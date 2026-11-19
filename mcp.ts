// The MCP endpoint (streamable HTTP, stateless, modern era): server/discover,
// tools/list and tools/call for the six github-mcp-server tools the suite looks
// for, implemented as thin wrappers over the shared store — the same state the
// REST and GraphQL surfaces serve, which mcp.rest-parity verifies.
//
// Wire discipline (docs/suite-spec.md section 10):
// - Plain JSON responses, the request's id echoed exactly (string ids stay strings).
// - A malformed JSON body is a -32700 parse error at HTTP 400.
// - An unknown tool is a -32601 JSON-RPC error, never an HTTP 500.
// - Missing required arguments are a -32602, never a silent success.
// - tools/list is a static array: byte-identical on every call.
// - No session id is ever issued, so no session state can leak between calls.

import type { ServerResponse } from 'node:http';
import {
  type IssueRec,
  type PullRec,
  type Repo,
  type Store,
  VIEWER,
  branchTip,
  squashMerge,
} from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const PROTOCOL_VERSION = '2026-07-28';
const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  run: (store: Store, args: Record<string, unknown>) => Record<string, unknown>;
}

const str = (description: string): { type: string; description: string } => ({ type: 'string', description });

function needRepo(store: Store, args: Record<string, unknown>): Repo {
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const name = typeof args.repo === 'string' ? args.repo : '';
  const repo = store.getRepo(owner, name);
  if (repo === undefined) throw new ToolError(`repository ${owner}/${name} not found`);
  return repo;
}

class ToolError extends Error {}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login (defaults to the authenticated user).'),
        name: str('The repository name.'),
        description: str('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    run: (store, args) => {
      const name = String(args.name ?? '');
      const existing = store.getRepo(VIEWER.login, name);
      if (existing !== undefined) return repoJson(existing);
      const repo = store.createRepo(
        VIEWER.login,
        name,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: str('The repository owner login.'), repo: str('The repository name.') },
      required: ['owner', 'repo'],
    },
    run: (store, args) => repoJson(needRepo(store, args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        title: str('The issue title.'),
        body: str('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (store, args) => {
      const repo = needRepo(store, args);
      const entry: IssueRec = {
        id: store.nextEntryId++,
        number: repo.nextNumber++,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        isPull: false,
      };
      repo.entries.set(entry.number, entry);
      return issueJson(entry);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        state: str('Filter by state: open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
    run: (store, args) => {
      const repo = needRepo(store, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.entries.values()].filter((entry) => !entry.isPull) as IssueRec[];
      if (state === 'open' || state === 'closed') list = list.filter((entry) => entry.state === state);
      list.sort((a, b) => a.number - b.number);
      return { issues: list.map(issueJson) };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        title: str('The pull request title.'),
        body: str('The pull request body.'),
        head: str('The head branch name.'),
        base: str('The base branch name.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (store, args) => {
      const repo = needRepo(store, args);
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      if (branchTip(repo, head) === undefined || branchTip(repo, base) === undefined) {
        throw new ToolError('head or base branch does not exist');
      }
      const entry: PullRec = {
        id: store.nextEntryId++,
        number: repo.nextNumber++,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        headRef: head,
        baseRef: base,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        isPull: true,
      };
      repo.entries.set(entry.number, entry);
      return pullJson(repo, entry);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (store, args) => {
      const repo = needRepo(store, args);
      const number = Number(args.pull_number);
      const entry = repo.entries.get(number);
      if (entry === undefined || !entry.isPull) throw new ToolError(`pull request ${number} not found`);
      const outcome = squashMerge(store, repo, entry);
      if (!outcome.merged && outcome.reason === 'conflict') throw new ToolError('pull request is not mergeable: conflict');
      return { ...pullJson(repo, entry), sha: entry.mergeCommitSha, merged: entry.merged };
    },
  },
];

const TOOL_LIST = TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function sendJsonRpc(res: ServerResponse, status: number, payload: JsonRpcResponse | { jsonrpc: '2.0'; id: unknown }): void {
  const text = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const rpcError = (id: unknown, code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Handle one POST /mcp (raw body in, response written). Auth ran before this. */
export function handleMcp(store: Store, rawBody: Buffer, res: ServerResponse): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJsonRpc(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJsonRpc(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const request = parsed as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
  const isNotification = request.id === undefined;
  if (isNotification) {
    // Notifications (notifications/initialized et al.) are accepted and ignored.
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return;
  }
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = request.params ?? {};

  if (method === 'server/discover') {
    sendJsonRpc(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    });
    return;
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    sendJsonRpc(res, 200, {
      jsonrpc: '2.0',
      id,
      result: { protocolVersion: offered, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
    });
    return;
  }
  if (method === 'ping') {
    sendJsonRpc(res, 200, { jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    sendJsonRpc(res, 200, { jsonrpc: '2.0', id, result: { tools: TOOL_LIST } });
    return;
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      sendJsonRpc(res, 200, rpcError(id, -32601, `Method not found: ${name}`));
      return;
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      sendJsonRpc(res, 200, rpcError(id, -32602, `Invalid params: missing required argument(s): ${missing.join(', ')}`));
      return;
    }
    try {
      const payload = tool.run(store, args);
      const text = JSON.stringify(payload);
      sendJsonRpc(res, 200, {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text }], structuredContent: payload, isError: false },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJsonRpc(res, 200, {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: message }], isError: true },
      });
    }
    return;
  }
  sendJsonRpc(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
}
