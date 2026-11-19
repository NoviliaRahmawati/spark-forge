// The REST v3 surface: repositories, branches, commits, contents, git refs, labels,
// issues, comments and pull requests, GitHub-shaped, over the shared store. Creates
// are 201, deletes 204, stale content shas 409, unknown labels 422, merge conflicts
// 405, and every error body is a JSON object with a non-empty "message".
//
// The issue hot path is built around a wire cache: an issue's GET response is
// serialized once and kept on the record together with the field references it was
// built from. tryFastIssueGet serves those bytes synchronously while the references
// still match; a create pre-builds the cache so the read workload that follows hits
// it on every request. A mutation through any surface changes a reference and the
// next read rebuilds, so the cache can never serve stale state.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Store,
  VIEWER,
  type IssueRec,
  type IssueWireCache,
  type PullRec,
  type Repo,
  blobBytes,
  branchTip,
  buildTreeFromFiles,
  createCommit,
  filesOfCommit,
  getObject,
  historyOf,
  parseCommit,
  parseTree,
  pullChangedFiles,
  putBlob,
  squashMerge,
  type Oid,
} from './store.ts';

export interface RestResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Pre-serialized body bytes; when present they are sent verbatim with `headers`. */
  payload?: Buffer;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });

/** GitHub's error shape: a JSON object with a non-empty message. */
export const errBody = (message: string): { message: string } => ({ message });

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.owner + '/' + repo.name,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: 'http://forge.local/' + repo.owner + '/' + repo.name,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

export function issueJson(entry: IssueRec): Record<string, unknown> {
  return {
    id: entry.id,
    number: entry.number,
    title: entry.title,
    body: entry.body,
    state: entry.state,
    labels: entry.labels.map((name) => ({ name })),
    user: { login: VIEWER.login, id: VIEWER.id },
    comments: 0,
  };
}

export function pullJson(repo: Repo, entry: PullRec): Record<string, unknown> {
  const headSha = branchTip(repo, entry.headRef) ?? '0'.repeat(40);
  const baseSha = branchTip(repo, entry.baseRef) ?? '0'.repeat(40);
  return {
    id: entry.id,
    number: entry.number,
    state: entry.state,
    title: entry.title,
    body: entry.body,
    user: { login: VIEWER.login, id: VIEWER.id },
    head: { ref: entry.headRef, sha: headSha, label: repo.owner + ':' + entry.headRef },
    base: { ref: entry.baseRef, sha: baseSha, label: repo.owner + ':' + entry.baseRef },
    merged: entry.merged,
    merged_at: entry.mergedAt,
    merge_commit_sha: entry.mergeCommitSha,
  };
}

function entryJson(repo: Repo, entry: IssueRec | PullRec): Record<string, unknown> {
  return entry.isPull ? pullJson(repo, entry) : issueJson(entry);
}

// ------------------------------------------------------------------ the issue wire cache

/** Build (or refresh) an issue's serialized GET response, guarding on field references. */
export function ensureIssueWire(entry: IssueRec): IssueWireCache {
  const cached = entry.wire;
  if (
    cached !== undefined &&
    cached.title === entry.title &&
    cached.body === entry.body &&
    cached.state === entry.state &&
    cached.labels === entry.labels
  ) {
    return cached;
  }
  const payload = Buffer.from(JSON.stringify(issueJson(entry)) + '\n', 'utf8');
  const wire: IssueWireCache = {
    payload,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(payload.length),
      'x-github-request-id': 'spark-i' + entry.id,
    },
    title: entry.title,
    body: entry.body,
    state: entry.state,
    labels: entry.labels,
  };
  entry.wire = wire;
  return wire;
}

/**
 * Synchronous fast path for GET /api/v3/repos/{owner}/{repo}/issues/{number}.
 * Returns false (caller continues routing) for anything it cannot serve verbatim:
 * a non-issue, a pull request, a query string, percent-escapes, or a missing record.
 */
export function tryFastIssueGet(store: Store, res: ServerResponse, url: string, authed: boolean): boolean {
  if (!authed || !url.startsWith('/api/v3/repos/')) return false;
  const tail = url.slice(14);
  const s1 = tail.indexOf('/');
  if (s1 <= 0) return false;
  const s2 = tail.indexOf('/', s1 + 1);
  if (s2 < 0) return false;
  const s3 = tail.indexOf('/', s2 + 1);
  if (s3 < 0) return false;
  if (tail.indexOf('/', s3 + 1) !== -1) return false;
  if (tail.slice(s2 + 1, s3) !== 'issues') return false;
  const owner = tail.slice(0, s1);
  const name = tail.slice(s1 + 1, s2);
  const numStr = tail.slice(s3 + 1);
  if (numStr === '' || numStr.includes('?') || numStr.includes('%') || owner.includes('%') || name.includes('%')) return false;
  if (owner !== VIEWER.login) return false;
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return false;
  const number = Number(numStr);
  if (!Number.isInteger(number) || number < 1) return false;
  const entry = repo.entries.get(number);
  if (entry === undefined || entry.isPull) return false;
  const wire = ensureIssueWire(entry);
  res.writeHead(200, wire.headers);
  res.end(wire.payload);
  return true;
}

let fastErrSeq = 0;
/** Send a JSON error straight from a fast path (non-empty request id, exact status). */
function sendFastErr(res: ServerResponse, status: number, message: string): void {
  const payload = Buffer.from(JSON.stringify({ message }) + '\n', 'utf8');
  fastErrSeq += 1;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'x-github-request-id': 'spark-e' + fastErrSeq,
  });
  res.end(payload);
}

/**
 * Synchronous fast path for POST /api/v3/repos/{owner}/{repo}/issues (the write
 * workload). Parses the path and body without a URL object, creates the issue, and
 * answers 201 with the same pre-serialized bytes a later GET will serve. Returns
 * false for anything it cannot handle (caller continues to the general router).
 */
export function tryFastIssuePost(store: Store, res: ServerResponse, url: string, authed: boolean, raw: Buffer): boolean {
  if (!authed || !url.startsWith('/api/v3/repos/') || url.includes('?')) return false;
  const tail = url.slice(14);
  const s1 = tail.indexOf('/');
  if (s1 <= 0) return false;
  const s2 = tail.indexOf('/', s1 + 1);
  if (s2 < 0) return false;
  if (tail.indexOf('/', s2 + 1) !== -1) return false;
  if (tail.slice(s2 + 1) !== 'issues') return false;
  const owner = tail.slice(0, s1);
  const name = tail.slice(s1 + 1, s2);
  if (owner.includes('%') || name.includes('%')) return false;
  if (owner !== VIEWER.login) return false;
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return false;

  let parsed: Record<string, unknown>;
  if (raw.length === 0) {
    parsed = {};
  } else {
    let value: unknown;
    try {
      value = JSON.parse(raw.toString('utf8'));
    } catch {
      sendFastErr(res, 400, 'Problems parsing JSON');
      return true;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      sendFastErr(res, 400, 'Problems parsing JSON');
      return true;
    }
    parsed = value as Record<string, unknown>;
  }
  const title = typeof parsed.title === 'string' ? parsed.title : '';
  const bodyText = typeof parsed.body === 'string' ? parsed.body : '';
  const labelNames = Array.isArray(parsed.labels) ? parsed.labels.filter((x): x is string => typeof x === 'string') : [];
  for (const label of labelNames) {
    if (!repo.labels.has(label)) {
      sendFastErr(res, 422, 'Validation Failed: label "' + label + '" does not exist');
      return true;
    }
  }
  const entry: IssueRec = {
    id: store.nextEntryId++,
    number: repo.nextNumber++,
    title,
    body: bodyText,
    state: 'open',
    labels: labelNames,
    isPull: false,
  };
  repo.entries.set(entry.number, entry);
  const wire = ensureIssueWire(entry);
  res.writeHead(201, wire.headers);
  res.end(wire.payload);
  return true;
}

// ------------------------------------------------------------------ pagination

interface Page<T> {
  items: T[];
  headers: Record<string, string>;
}

/** Slice a list by ?page / ?per_page and build GitHub-style absolute Link headers. */
function paginate<T>(req: IncomingMessage, url: URL, all: readonly T[]): Page<T> {
  const perRaw = Number(url.searchParams.get('per_page') ?? '30');
  const perPage = Number.isFinite(perRaw) && perRaw > 0 ? Math.min(100, Math.trunc(perRaw)) : 30;
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  const items = all.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page < totalPages || page > 1) {
    const base = 'http://' + (req.headers.host ?? 'forge.local') + url.pathname;
    const link = (p: number, rel: string): string => {
      const params = new URLSearchParams(url.searchParams);
      params.set('page', String(p));
      params.set('per_page', String(perPage));
      return '<' + base + '?' + params.toString() + '>; rel="' + rel + '"';
    };
    const parts: string[] = [];
    if (page < totalPages) parts.push(link(page + 1, 'next'), link(totalPages, 'last'));
    if (page > 1) parts.push(link(page - 1, 'prev'), link(1, 'first'));
    if (parts.length > 0) headers.link = parts.join(', ');
  }
  return { items, headers };
}

// ------------------------------------------------------------------ directory listings

/** Walk a tree to a directory and list its immediate entries; null when absent. */
function listTreeAt(repo: Repo, treeOid: Oid, dirPath: string): { type: string; name: string; path: string; sha: Oid }[] | null {
  let current = treeOid;
  if (dirPath !== '') {
    for (const part of dirPath.split('/')) {
      const obj = getObject(repo, current);
      if (obj === undefined || obj.type !== 'tree') return null;
      const entry = parseTree(obj.body).find((c) => c.name === part && c.mode === '40000');
      if (entry === undefined) return null;
      current = entry.oid;
    }
  }
  const obj = getObject(repo, current);
  if (obj === undefined || obj.type !== 'tree') return null;
  return parseTree(obj.body).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: dirPath === '' ? entry.name : dirPath + '/' + entry.name,
    sha: entry.oid,
  }));
}

// ------------------------------------------------------------------ the router

export interface RestRequest {
  method: string;
  /** Path segments under /api/v3, already percent-decoded. */
  segments: string[];
  url: URL;
  body: Record<string, unknown> | null;
  raw: IncomingMessage;
}

/** Route one /api/v3 request. */
export function handleRest(store: Store, r: RestRequest): RestResult {
  const seg = r.segments;
  const method = r.method;

  if (seg.length === 0) {
    if (method === 'GET') return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return ok(404, errBody('Not Found'));
  }
  if (seg[0] === 'meta' && seg.length === 1 && method === 'GET') {
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }
  if (seg[0] === 'user' && seg.length === 1 && method === 'GET') {
    return ok(200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
  }

  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') {
      const mine = [...store.repos.values()].filter((repo) => repo.owner === VIEWER.login).sort((a, b) => a.id - b.id);
      const page = paginate(r.raw, r.url, mine.map(repoJson));
      return ok(200, page.items, page.headers);
    }
    if (method === 'POST') {
      const name = typeof r.body?.name === 'string' ? r.body.name : '';
      if (name === '') return ok(422, errBody('Repository creation failed: name is required'));
      if (store.getRepo(VIEWER.login, name) !== undefined) return ok(422, errBody('Repository creation failed: name already exists on this account'));
      const repo = store.createRepo(
        VIEWER.login,
        name,
        typeof r.body?.description === 'string' ? r.body.description : '',
        r.body?.private === true,
      );
      return ok(201, repoJson(repo));
    }
    return ok(404, errBody('Not Found'));
  }

  if (seg[0] !== 'repos' || seg.length < 3) return ok(404, errBody('Not Found'));
  const owner = seg[1] as string;
  const repoName = seg[2] as string;
  if (owner !== VIEWER.login) return ok(404, errBody('Not Found'));
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return ok(404, errBody('Not Found'));
  const rest = seg.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoJson(repo));
    if (method === 'PATCH') {
      if (typeof r.body?.description === 'string') repo.description = r.body.description;
      if (typeof r.body?.name === 'string' && r.body.name !== repo.name) {
        store.repos.delete(store.repoKey(repo.owner, repo.name));
        repo.name = r.body.name;
        store.repos.set(store.repoKey(repo.owner, repo.name), repo);
      }
      if (typeof r.body?.private === 'boolean') repo.private = r.body.private;
      return ok(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204 };
    }
    return ok(404, errBody('Not Found'));
  }

  if (rest[0] === 'branches') return branches(repo, rest.slice(1), r);
  if (rest[0] === 'commits') return commits(repo, rest.slice(1), r);
  if (rest[0] === 'contents') return contents(store, repo, rest.slice(1), r);
  if (rest[0] === 'git' && rest[1] === 'refs') return gitRefs(repo, rest.slice(2), r);
  if (rest[0] === 'labels') return labels(repo, rest.slice(1), r);
  if (rest[0] === 'issues') return issues(store, repo, rest.slice(1), r);
  if (rest[0] === 'pulls') return pulls(store, repo, rest.slice(1), r);
  return ok(404, errBody('Not Found'));
}

// ------------------------------------------------------------------ branches and commits

function branches(repo: Repo, rest: string[], r: RestRequest): RestResult {
  if (rest.length === 0 && r.method === 'GET') {
    const list = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    const page = paginate(r.raw, r.url, list);
    return ok(200, page.items, page.headers);
  }
  if (rest.length >= 1 && r.method === 'GET') {
    const name = rest.join('/');
    const sha = branchTip(repo, name);
    if (sha === undefined) return ok(404, errBody('Branch not found'));
    return ok(200, { name, commit: { sha }, protected: false });
  }
  return ok(404, errBody('Not Found'));
}

function commits(repo: Repo, rest: string[], r: RestRequest): RestResult {
  if (rest.length !== 0 || r.method !== 'GET') return ok(404, errBody('Not Found'));
  const refParam = r.url.searchParams.get('sha');
  let tip: Oid | undefined;
  if (refParam === null || refParam === '') tip = branchTip(repo, repo.defaultBranch);
  else if (/^[0-9a-f]{40}$/i.test(refParam) && parseCommit(repo, refParam.toLowerCase()) !== null) tip = refParam.toLowerCase();
  else tip = branchTip(repo, refParam);
  if (tip === undefined) return ok(200, []);
  const list = historyOf(repo, tip).map((sha) => {
    const info = parseCommit(repo, sha);
    const authorMatch = info === null ? null : /^(.*) <(.*)> \d+/.exec(info.authorLine);
    return {
      sha,
      commit: {
        message: info?.message ?? '',
        author: {
          name: authorMatch?.[1] ?? VIEWER.name,
          email: authorMatch?.[2] ?? VIEWER.email,
          date: new Date((info?.epochSec ?? 0) * 1000).toISOString(),
        },
        tree: { sha: info?.tree ?? '' },
      },
      parents: (info?.parents ?? []).map((parent) => ({ sha: parent })),
    };
  });
  const page = paginate(r.raw, r.url, list);
  return ok(200, page.items, page.headers);
}

// ------------------------------------------------------------------ contents

function resolveRef(repo: Repo, refParam: string | null): Oid | undefined {
  if (refParam === null || refParam === '') return branchTip(repo, repo.defaultBranch);
  if (/^[0-9a-f]{40}$/i.test(refParam) && parseCommit(repo, refParam.toLowerCase()) !== null) return refParam.toLowerCase();
  return branchTip(repo, refParam);
}

function contents(store: Store, repo: Repo, rest: string[], r: RestRequest): RestResult {
  const path = rest.join('/');

  if (r.method === 'GET') {
    const tip = resolveRef(repo, r.url.searchParams.get('ref'));
    if (tip === undefined) return ok(404, errBody('Not Found'));
    const commit = parseCommit(repo, tip);
    if (commit === null) return ok(404, errBody('Not Found'));
    const files = filesOfCommit(repo, tip);
    const blobSha = files.get(path);
    if (path !== '' && blobSha !== undefined) {
      const bytes = blobBytes(repo, blobSha);
      return ok(200, {
        type: 'file',
        name: path.split('/').pop(),
        path,
        sha: blobSha,
        size: bytes.length,
        encoding: 'base64',
        content: bytes.toString('base64'),
      });
    }
    const listing = listTreeAt(repo, commit.tree, path);
    if (listing !== null) {
      return ok(200, listing.map((entry) => ({ type: entry.type, name: entry.name, path: entry.path, sha: entry.sha, size: 0 })));
    }
    return ok(404, errBody('Not Found'));
  }

  if (r.method === 'PUT') {
    if (path === '') return ok(422, errBody('Invalid path'));
    const message = typeof r.body?.message === 'string' ? r.body.message : '';
    const contentB64 = typeof r.body?.content === 'string' ? r.body.content : '';
    const bytes = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
    const branchName = typeof r.body?.branch === 'string' && r.body.branch !== '' ? r.body.branch : repo.defaultBranch;
    const tip = branchTip(repo, branchName);
    if (tip === undefined && branchName !== repo.defaultBranch) return ok(404, errBody('Branch not found'));
    const files = tip === undefined ? new Map<string, Oid>() : new Map(filesOfCommit(repo, tip));
    const existing = files.get(path);
    const suppliedSha = typeof r.body?.sha === 'string' ? r.body.sha : undefined;
    if (suppliedSha !== undefined && suppliedSha !== existing) return ok(409, errBody('Conflict: the supplied sha does not match the current file'));
    if (existing === undefined && suppliedSha !== undefined && tip !== undefined) return ok(409, errBody('Conflict: the file does not exist'));
    const blobSha = putBlob(repo, bytes);
    files.set(path, blobSha);
    const tree = buildTreeFromFiles(repo, files);
    const commitSha = createCommit(repo, store, { tree, parents: tip === undefined ? [] : [tip], message });
    repo.refs.set('refs/heads/' + branchName, commitSha);
    return ok(existing === undefined ? 201 : 200, {
      content: { name: path.split('/').pop(), path, sha: blobSha, size: bytes.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha, message },
    });
  }

  if (r.method === 'DELETE') {
    if (path === '') return ok(422, errBody('Invalid path'));
    const message = typeof r.body?.message === 'string' ? r.body.message : '';
    const branchName = typeof r.body?.branch === 'string' && r.body.branch !== '' ? r.body.branch : repo.defaultBranch;
    const tip = branchTip(repo, branchName);
    if (tip === undefined) return ok(404, errBody('Not Found'));
    const files = new Map(filesOfCommit(repo, tip));
    const existing = files.get(path);
    if (existing === undefined) return ok(404, errBody('Not Found'));
    const suppliedSha = typeof r.body?.sha === 'string' ? r.body.sha : undefined;
    if (suppliedSha !== undefined && suppliedSha !== existing) return ok(409, errBody('Conflict: the supplied sha does not match the current file'));
    files.delete(path);
    const tree = buildTreeFromFiles(repo, files);
    const commitSha = createCommit(repo, store, { tree, parents: [tip], message });
    repo.refs.set('refs/heads/' + branchName, commitSha);
    return ok(200, { content: null, commit: { sha: commitSha, message } });
  }

  return ok(404, errBody('Not Found'));
}

// ------------------------------------------------------------------ git refs

function gitRefs(repo: Repo, rest: string[], r: RestRequest): RestResult {
  if (rest.length === 0) {
    if (r.method === 'POST') {
      const ref = typeof r.body?.ref === 'string' ? r.body.ref : '';
      const sha = typeof r.body?.sha === 'string' ? r.body.sha.toLowerCase() : '';
      if (!ref.startsWith('refs/')) return ok(422, errBody('Invalid ref'));
      if (parseCommit(repo, sha) === null && getObject(repo, sha) === undefined) return ok(422, errBody('Invalid sha'));
      repo.refs.set(ref, sha);
      return ok(201, { ref, object: { type: 'commit', sha } });
    }
    if (r.method === 'GET') {
      const list = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { type: 'commit', sha } }));
      return ok(200, list);
    }
    return ok(404, errBody('Not Found'));
  }
  const fullRef = 'refs/' + rest.join('/');
  if (r.method === 'GET') {
    const sha = repo.refs.get(fullRef);
    if (sha === undefined) return ok(404, errBody('Ref not found'));
    return ok(200, { ref: fullRef, object: { type: 'commit', sha } });
  }
  if (r.method === 'DELETE') {
    if (!repo.refs.delete(fullRef)) return ok(422, errBody('Ref not found'));
    return { status: 204 };
  }
  return ok(404, errBody('Not Found'));
}

// ------------------------------------------------------------------ labels

function labels(repo: Repo, rest: string[], r: RestRequest): RestResult {
  if (rest.length === 0) {
    if (r.method === 'POST') {
      const name = typeof r.body?.name === 'string' ? r.body.name : '';
      const color = typeof r.body?.color === 'string' ? r.body.color : 'ededed';
      if (name === '') return ok(422, errBody('Validation Failed: name is required'));
      if (repo.labels.has(name)) return ok(422, errBody('Validation Failed: label already exists'));
      repo.labels.set(name, { name, color });
      return ok(201, { id: repo.labels.size, name, color, default: false });
    }
    if (r.method === 'GET') {
      const list = [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, default: false }));
      const page = paginate(r.raw, r.url, list);
      return ok(200, page.items, page.headers);
    }
  }
  return ok(404, errBody('Not Found'));
}

// ------------------------------------------------------------------ issues and comments

function issues(store: Store, repo: Repo, rest: string[], r: RestRequest): RestResult {
  if (rest.length === 0) {
    if (r.method === 'POST') {
      const title = typeof r.body?.title === 'string' ? r.body.title : '';
      const bodyText = typeof r.body?.body === 'string' ? r.body.body : '';
      const labelNames = Array.isArray(r.body?.labels) ? r.body.labels.filter((x): x is string => typeof x === 'string') : [];
      for (const name of labelNames) {
        if (!repo.labels.has(name)) return ok(422, errBody('Validation Failed: label "' + name + '" does not exist'));
      }
      const entry: IssueRec = {
        id: store.nextEntryId++,
        number: repo.nextNumber++,
        title,
        body: bodyText,
        state: 'open',
        labels: labelNames,
        isPull: false,
      };
      repo.entries.set(entry.number, entry);
      // Pre-build the wire cache: the create answer and every later GET share these bytes.
      const wire = ensureIssueWire(entry);
      return { status: 201, payload: wire.payload, headers: wire.headers };
    }
    if (r.method === 'GET') {
      const state = r.url.searchParams.get('state') ?? 'open';
      const direction = r.url.searchParams.get('direction') ?? 'desc';
      let list = [...repo.entries.values()].filter((entry) => !entry.isPull) as IssueRec[];
      if (state === 'open' || state === 'closed') list = list.filter((entry) => entry.state === state);
      list.sort((a, b) => a.number - b.number);
      if (direction === 'desc') list.reverse();
      const page = paginate(r.raw, r.url, list.map(issueJson));
      return ok(200, page.items, page.headers);
    }
    return ok(404, errBody('Not Found'));
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return ok(404, errBody('Not Found'));
  const entry = repo.entries.get(number);

  if (rest.length === 1) {
    if (entry === undefined) return ok(404, errBody('Not Found'));
    if (r.method === 'GET') {
      if (!entry.isPull) {
        const wire = ensureIssueWire(entry);
        return { status: 200, payload: wire.payload, headers: wire.headers };
      }
      return ok(200, entryJson(repo, entry));
    }
    if (r.method === 'PATCH') {
      if (r.body?.state === 'open' || r.body?.state === 'closed') entry.state = r.body.state;
      if (!entry.isPull) {
        if (typeof r.body?.title === 'string') entry.title = r.body.title;
        if (typeof r.body?.body === 'string') entry.body = r.body.body;
        if (Array.isArray(r.body?.labels)) {
          const names = r.body.labels.filter((x): x is string => typeof x === 'string');
          for (const name of names) if (!repo.labels.has(name)) return ok(422, errBody('Validation Failed: label "' + name + '" does not exist'));
          entry.labels = names;
        }
        const wire = ensureIssueWire(entry);
        return { status: 200, payload: wire.payload, headers: wire.headers };
      }
      return ok(200, entryJson(repo, entry));
    }
    return ok(404, errBody('Not Found'));
  }

  if (rest[1] === 'comments' && rest.length === 2) {
    if (entry === undefined) return ok(404, errBody('Not Found'));
    const list = repo.comments.get(number) ?? [];
    if (r.method === 'POST') {
      const bodyText = typeof r.body?.body === 'string' ? r.body.body : '';
      const comment = { id: store.nextCommentId++, body: bodyText };
      list.push(comment);
      repo.comments.set(number, list);
      return ok(201, { id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id } });
    }
    if (r.method === 'GET') {
      const page = paginate(r.raw, r.url, list.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER.login, id: VIEWER.id } })));
      return ok(200, page.items, page.headers);
    }
  }
  return ok(404, errBody('Not Found'));
}

// ------------------------------------------------------------------ pull requests

function pulls(store: Store, repo: Repo, rest: string[], r: RestRequest): RestResult {
  if (rest.length === 0) {
    if (r.method === 'POST') {
      const title = typeof r.body?.title === 'string' ? r.body.title : '';
      const bodyText = typeof r.body?.body === 'string' ? r.body.body : '';
      const headRaw = typeof r.body?.head === 'string' ? r.body.head : '';
      const baseRaw = typeof r.body?.base === 'string' ? r.body.base : '';
      const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
      if (branchTip(repo, head) === undefined || branchTip(repo, base) === undefined) {
        return ok(422, errBody('Validation Failed: head or base branch does not exist'));
      }
      const entry: PullRec = {
        id: store.nextEntryId++,
        number: repo.nextNumber++,
        title,
        body: bodyText,
        state: 'open',
        headRef: head,
        baseRef: base,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        isPull: true,
      };
      repo.entries.set(entry.number, entry);
      return ok(201, pullJson(repo, entry));
    }
    if (r.method === 'GET') {
      const state = r.url.searchParams.get('state') ?? 'open';
      let list = [...repo.entries.values()].filter((entry) => entry.isPull) as PullRec[];
      if (state === 'open' || state === 'closed') list = list.filter((entry) => entry.state === state);
      list.sort((a, b) => a.number - b.number);
      const page = paginate(r.raw, r.url, list.map((entry) => pullJson(repo, entry)));
      return ok(200, page.items, page.headers);
    }
    return ok(404, errBody('Not Found'));
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return ok(404, errBody('Not Found'));
  const entry = repo.entries.get(number);
  if (entry === undefined || !entry.isPull) return ok(404, errBody('Not Found'));
  const pull = entry as PullRec;

  if (rest.length === 1 && r.method === 'GET') return ok(200, pullJson(repo, pull));

  if (rest.length === 2 && rest[1] === 'files' && r.method === 'GET') {
    const headTip = branchTip(repo, pull.headRef);
    const baseTip = branchTip(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return ok(200, []);
    const files = pullChangedFiles(repo, headTip, baseTip).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      sha: file.sha,
    }));
    const page = paginate(r.raw, r.url, files);
    return ok(200, page.items, page.headers);
  }

  if (rest.length === 2 && rest[1] === 'merge' && r.method === 'PUT') {
    const outcome = squashMerge(store, repo, pull);
    if (!outcome.merged) {
      if (outcome.reason === 'already-merged') return ok(405, errBody('Pull Request is not mergeable: already merged'));
      return ok(405, errBody('Pull Request is not mergeable'));
    }
    return ok(200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
  }

  return ok(404, errBody('Not Found'));
}