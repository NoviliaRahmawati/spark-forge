// The MCP surface: JSON-RPC 2.0 over Streamable HTTP, stateless, speaking revision
// 2026-07-28 (server/discover) plus the initialize handshake older clients use. The
// six github-mcp-server tools are thin adapters over the one shared store, so an
// object made here reads back identically through REST and GraphQL.
//
// Wire rules the suite enforces: the request id is echoed exactly (string ids stay
// strings); a body that is not JSON is a -32700 parse error at HTTP 400; an unknown
// tool is -32601 and a missing required argument is -32602, both as JSON-RPC errors
// rather than HTTP 500; tools/list is a fixed array, byte-identical on every call;
// no session id is issued, so nothing leaks between calls.

import type { ServerResponse } from 'node:http';
import { type IssueRec, type PullRec, type Repo, type Store, VIEWER, branchTip, squashMerge } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const REVISION = '2026-07-28';
const HANDSHAKE_DEFAULT = '2025-11-25';
const SERVER = { name: 'spark-forge-mcp', version: '2.0.0' };

/** A tool's advertised shape plus its adapter over the store. */
interface Tool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
  invoke: (store: Store, args: Record<string, unknown>) => Record<string, unknown>;
}

/** Raised by an adapter to turn into an isError:true tool result. */
class ToolFailure extends Error {}

const textProp = (description: string) => ({ type: 'string', description });

/** Look up the repository an argument set names, defaulting the owner to the viewer. */
function repoFromArgs(store: Store, args: Record<string, unknown>): Repo {
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const name = typeof args.repo === 'string' ? args.repo : '';
  const repo = store.getRepo(owner, name);
  if (repo === undefined) throw new ToolFailure(`repository ${owner}/${name} not found`);
  return repo;
}

function newIssue(store: Store, repo: Repo, title: string, body: string): IssueRec {
  const entry: IssueRec = {
    id: store.nextEntryId++,
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    labels: [],
    isPull: false,
  };
  repo.entries.set(entry.number, entry);
  return entry;
}

function newPull(store: Store, repo: Repo, title: string, body: string, head: string, base: string): PullRec {
  const entry: PullRec = {
    id: store.nextEntryId++,
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    headRef: head,
    baseRef: base,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    isPull: true,
  };
  repo.entries.set(entry.number, entry);
  return entry;
}

const OWNER_REPO = { owner: textProp('The repository owner login.'), repo: textProp('The repository name.') };

/** The fixed tool registry. Order and content never change, so tools/list is stable. */
const REGISTRY: Tool[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: textProp('The repository owner login (defaults to the authenticated user).'),
        name: textProp('The repository name.'),
        description: textProp('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    invoke: (store, args) => {
      const name = String(args.name ?? '');
      const existing = store.getRepo(VIEWER.login, name);
      if (existing !== undefined) return repoJson(existing);
      return repoJson(store.createRepo(VIEWER.login, name, typeof args.description === 'string' ? args.description : '', args.private === true));
    },
  },
  {
    name: 'get_repo',
    description: 'Fetch one repository by owner and name.',
    inputSchema: { type: 'object', properties: { ...OWNER_REPO }, required: ['owner', 'repo'] },
    invoke: (store, args) => repoJson(repoFromArgs(store, args)),
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: { ...OWNER_REPO, title: textProp('The issue title.'), body: textProp('The issue body.') },
      required: ['owner', 'repo', 'title'],
    },
    invoke: (store, args) => issueJson(newIssue(store, repoFromArgs(store, args), String(args.title ?? ''), typeof args.body === 'string' ? args.body : '')),
  },
  {
    name: 'list_issues',
    description: 'List a repository\'s issues, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: { ...OWNER_REPO, state: textProp('Filter by state: open, closed or all.') },
      required: ['owner', 'repo'],
    },
    invoke: (store, args) => {
      const repo = repoFromArgs(store, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.entries.values()].filter((entry) => !entry.isPull) as IssueRec[];
      if (state === 'open' || state === 'closed') issues = issues.filter((entry) => entry.state === state);
      issues.sort((a, b) => a.number - b.number);
      return { issues: issues.map(issueJson) };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request between two branches of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO,
        title: textProp('The pull request title.'),
        body: textProp('The pull request body.'),
        head: textProp('The head branch name.'),
        base: textProp('The base branch name.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    invoke: (store, args) => {
      const repo = repoFromArgs(store, args);
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      if (branchTip(repo, head) === undefined || branchTip(repo, base) === undefined) throw new ToolFailure('head or base branch does not exist');
      return pullJson(repo, newPull(store, repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', head, base));
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: { ...OWNER_REPO, pull_number: { type: 'number', description: 'The pull request number.' } },
      required: ['owner', 'repo', 'pull_number'],
    },
    invoke: (store, args) => {
      const repo = repoFromArgs(store, args);
      const number = Number(args.pull_number);
      const entry = repo.entries.get(number);
      if (entry === undefined || !entry.isPull) throw new ToolFailure(`pull request ${number} not found`);
      const outcome = squashMerge(store, repo, entry);
      if (!outcome.merged && outcome.reason === 'conflict') throw new ToolFailure('pull request is not mergeable: conflict');
      return { ...pullJson(repo, entry), sha: entry.mergeCommitSha, merged: entry.merged };
    },
  },
];

/** The advertised list (no adapters), frozen so every tools/list is byte-identical. */
const ADVERTISED = REGISTRY.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
const BY_NAME = new Map(REGISTRY.map((tool) => [tool.name, tool]));

interface RpcReply {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

function reply(res: ServerResponse, status: number, body: RpcReply): void {
  const text = JSON.stringify(body) + '\n';
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const rpcError = (id: unknown, code: number, message: string): RpcReply => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcResult = (id: unknown, result: unknown): RpcReply => ({ jsonrpc: '2.0', id, result });

/** Run one tools/call: validate the tool and its required arguments, then invoke. */
function callTool(store: Store, id: unknown, params: Record<string, unknown>): RpcReply {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = BY_NAME.get(name);
  if (tool === undefined) return rpcError(id, -32601, `Method not found: ${name}`);
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) return rpcError(id, -32602, `Invalid params: missing required argument(s): ${missing.join(', ')}`);
  try {
    const payload = tool.invoke(store, args);
    return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return rpcResult(id, { content: [{ type: 'text', text: message }], isError: true });
  }
}

/** Handle one POST /mcp (auth already checked by the dispatcher). */
export function handleMcp(store: Store, rawBody: Buffer, res: ServerResponse): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    reply(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    reply(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const request = parsed as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
  if (request.id === undefined) {
    // A notification (notifications/initialized and friends): accept, no body.
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return;
  }
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = request.params ?? {};

  switch (method) {
    case 'server/discover':
      reply(res, 200, rpcResult(id, { supportedVersions: [REVISION], capabilities: { tools: {} }, serverInfo: SERVER }));
      return;
    case 'initialize':
      reply(res, 200, rpcResult(id, {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : HANDSHAKE_DEFAULT,
        capabilities: { tools: {} },
        serverInfo: SERVER,
      }));
      return;
    case 'ping':
      reply(res, 200, rpcResult(id, {}));
      return;
    case 'tools/list':
      reply(res, 200, rpcResult(id, { tools: ADVERTISED }));
      return;
    case 'tools/call':
      reply(res, 200, callTool(store, id, params));
      return;
    default:
      reply(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
  }
}