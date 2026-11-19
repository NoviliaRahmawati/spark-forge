// The forge's HTTP server: one process serving git smart HTTP, REST v3, GraphQL v4
// and MCP over the shared store. This file is the dispatcher.
//
// The benchmark's hot requests are answered synchronously, before any async hop:
// GET info/refs and GET issue reads route straight to a cached buffer, and git POSTs
// run synchronously once their body is collected. Everything else falls through to
// the general async path, which keeps the full routing, the one-token auth rule, the
// malformed-body 400 discipline and the X-GitHub-Request-Id header on every API reply.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, errBody, tryFastIssueGet, tryFastIssuePost, type RestResult } from './rest.ts';
import { serveInfoRefs, serveGitPost, isGitPath } from './git.ts';
import { handleGraphql, type GraphqlRequest } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/** The exact Authorization header the suite presents; null when no token is configured. */
const EXPECTED_AUTH = TOKEN === '' ? null : 'Bearer ' + TOKEN;

let requestSeq = 0;
function nextRequestId(): string {
  requestSeq += 1;
  return 'spark-' + requestSeq.toString(36);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const payload = Buffer.from(JSON.stringify(body) + '\n', 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': payload.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(payload);
}

function sendResult(res: ServerResponse, result: RestResult): void {
  if (result.payload !== undefined) {
    res.writeHead(result.status, result.headers ?? {});
    res.end(result.payload);
    return;
  }
  if (result.status === 204 || result.body === undefined) {
    res.writeHead(result.status, { 'x-github-request-id': nextRequestId(), ...(result.headers ?? {}) });
    res.end();
    return;
  }
  sendJson(res, result.status, result.body, result.headers);
}

/** Collect a whole request body (bounded; the suite's payloads are small). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authed(req: IncomingMessage): boolean {
  return EXPECTED_AUTH === null || req.headers.authorization === EXPECTED_AUTH;
}

/** Percent-decode one path segment, tolerating malformed escapes. */
function decode(segment: string): string {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    // No wall-clock Date header: cleaner for determinism and one less header per reply.
    res.sendDate = false;
    const rawUrl = req.url ?? '/';
    const method = req.method ?? 'GET';
    const qAt = rawUrl.indexOf('?');
    const path = qAt < 0 ? rawUrl : rawUrl.slice(0, qAt);
    const query = qAt < 0 ? '' : rawUrl.slice(qAt + 1);

    // The env's boot probe: no auth, exact body.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // ---- synchronous fast paths (no await, no URL object) ----
    if (method === 'GET') {
      if (isGitPath(path) && serveInfoRefs(store, req, res, path, query)) return;
      if (tryFastIssueGet(store, res, rawUrl, authed(req))) return;
    }

    // ---- general async path ----
    void (async () => {
      if (method === 'POST' && isGitPath(path)) {
        const body = await readBody(req);
        if (serveGitPost(store, req, res, path, body)) return;
      }

      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const isAuth = authed(req);
        const mutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
        const raw = mutating ? await readBody(req) : Buffer.alloc(0);
        // Fast issue create: no URL object, no full routing on the write workload.
        if (method === 'POST' && tryFastIssuePost(store, res, rawUrl, isAuth, raw)) return;
        const url = new URL(rawUrl, 'http://entry');
        const segments = path
          .slice(7)
          .split('/')
          .filter((part) => part !== '')
          .map(decode);
        const isPublic = method === 'GET' && (segments.length === 0 || (segments.length === 1 && segments[0] === 'meta'));
        if (!isPublic && !isAuth) {
          sendJson(res, 401, errBody('Bad credentials'));
          return;
        }
        let body: Record<string, unknown> | null = null;
        if (mutating) {
          if (raw.length > 0) {
            try {
              const parsed: unknown = JSON.parse(raw.toString('utf8'));
              if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
              body = parsed as Record<string, unknown>;
            } catch {
              sendJson(res, 400, errBody('Problems parsing JSON'));
              return;
            }
          } else {
            body = {};
          }
        }
        const result = handleRest(store, { method, segments, url, body, raw: req });
        sendResult(res, result);
        return;
      }

      if (path === '/api/graphql') {
        if (!authed(req)) {
          sendJson(res, 401, errBody('Bad credentials'));
          return;
        }
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
          return;
        }
        if (Array.isArray(parsed)) {
          sendJson(res, 200, parsed.map((item) => handleGraphql(store, item as GraphqlRequest)));
          return;
        }
        sendJson(res, 200, handleGraphql(store, parsed as GraphqlRequest));
        return;
      }

      if (path === '/mcp') {
        if (!authed(req)) {
          sendJson(res, 401, errBody('Bad credentials'));
          return;
        }
        if (method === 'DELETE') {
          res.writeHead(200, { 'content-length': 0 });
          res.end();
          return;
        }
        if (method === 'POST') {
          const raw = await readBody(req);
          handleMcp(store, raw, res);
          return;
        }
        sendJson(res, 405, errBody('Method Not Allowed'));
        return;
      }

      sendJson(res, 404, errBody('Not Found'));
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, errBody('Internal Server Error'));
      else res.end();
    });
  });
}