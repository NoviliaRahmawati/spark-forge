// The forge's HTTP server: one process serving the git smart-HTTP surface, the
// REST v3 API, GraphQL v4 and the MCP endpoint over the shared store (store.ts).
// This file is the wiring: routing, the one-token auth rule, JSON body discipline
// (a malformed body is a 400 with a {"message"} body, never a crash), and the
// X-GitHub-Request-Id header every API response must carry. main.ts owns the
// register/done lifecycle and stays untouched.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, errBody, type RestResult } from './rest.ts';
import { handleGit } from './git.ts';
import { handleGraphql, type GraphqlRequest } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The suite's bearer token; undefined only in local development without the env. */
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

/** A unique, non-empty request id (the protocol checks require one per response). */
function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}-${(requestCounter * 2654435761 % 0xffffff).toString(16)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': payload.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(payload);
}

function sendResult(res: ServerResponse, result: RestResult): void {
  if (result.status === 204 || result.body === undefined) {
    res.writeHead(result.status, { 'x-github-request-id': nextRequestId(), ...(result.headers ?? {}) });
    res.end();
    return;
  }
  sendJson(res, result.status, result.body, result.headers);
}

/** Read a whole request body (bounded; the suite's payloads are small). */
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
    // The common case is a single chunk: hand it over without a concat copy.
    req.on('end', () => resolve(chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Whether the request carries the suite's bearer token. */
function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
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
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://entry');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      // The env's boot probe: no auth, exact body.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // ------------------------------------------------------------ REST v3
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const segments = path
          .slice('/api/v3'.length)
          .split('/')
          .filter((part) => part !== '')
          .map(decode);
        const isPublic = method === 'GET' && (segments.length === 0 || (segments.length === 1 && segments[0] === 'meta'));
        if (!isPublic && !authed(req)) {
          sendJson(res, 401, errBody('Bad credentials'));
          return;
        }
        let body: Record<string, unknown> | null = null;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const raw = await readBody(req);
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

      // ------------------------------------------------------------ GraphQL v4
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
          const envelopes = parsed.map((item) => handleGraphql(store, item as GraphqlRequest));
          sendJson(res, 200, envelopes);
          return;
        }
        sendJson(res, 200, handleGraphql(store, parsed as GraphqlRequest));
        return;
      }

      // ------------------------------------------------------------ MCP
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

      // ------------------------------------------------------------ git smart HTTP
      if (/^\/[^/]+\/[^/]+\.git(\/|$)/.test(path)) {
        const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
        const handled = await handleGit(store, req, res, body, url);
        if (handled) return;
      }

      // Everything else: GitHub's JSON 404.
      sendJson(res, 404, errBody('Not Found'));
    })().catch(() => {
      // A handler failure must still answer JSON, never hang or crash the process.
      if (!res.headersSent) sendJson(res, 500, errBody('Internal Server Error'));
      else res.end();
    });
  });
}
