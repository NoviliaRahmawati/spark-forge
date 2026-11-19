// Shared in-memory state for the forge. Every surface (git smart HTTP, REST v3,
// GraphQL v4, MCP) reads and writes this one store, so an object made through any
// surface is visible through all of them. Git objects live per repository keyed by
// their SHA-1 id and never change once written.
//
// Determinism: commit timestamps advance a logical clock (never the wall clock), so
// two runs of the same scripted scenario produce byte-identical object ids. Trees are
// edited as a flat path->blob map and rebuilt with git's exact entry ordering.
//
// The issue record carries an optional `wire` cache: the pre-serialized REST GET
// response plus the field references it was built from. A read serves the cached
// bytes only while those references still match, so a mutation through any surface
// (REST PATCH, GraphQL closeIssue/updateIssue, MCP) invalidates it automatically.

import { createHash } from 'node:crypto';

export type Oid = string;

export interface GitObject {
  readonly type: 'blob' | 'tree' | 'commit' | 'tag';
  readonly body: Buffer;
}

export interface ForgeUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** The single authenticated viewer the trial's token names. */
export const VIEWER: ForgeUser = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** A cached REST issue GET: serialized bytes, ready headers, and the guard refs. */
export interface IssueWireCache {
  payload: Buffer;
  headers: Record<string, string>;
  title: string;
  body: string;
  state: string;
  labels: string[];
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  isPull: false;
  wire?: IssueWireCache;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: Oid | null;
  isPull: true;
}

export type IssueOrPull = IssueRec | PullRec;

export interface CommentRec {
  id: number;
  body: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<Oid, GitObject>;
  refs: Map<string, Oid>;
  /** Issues and pull requests share one per-repo number sequence, as on GitHub. */
  nextNumber: number;
  entries: Map<number, IssueOrPull>;
  comments: Map<number, CommentRec[]>;
  labels: Map<string, { name: string; color: string }>;
  /** Flattened-tree memo: commit id -> (path -> blob id). */
  flatCache: Map<Oid, Map<string, Oid>>;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextEntryId = 1;
  nextCommentId = 1;
  /** Logical epoch seconds behind every commit timestamp and merged_at. */
  clock = 1735689600;

  repoKey(owner: string, name: string): string {
    return owner + '/' + name;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(owner + '/' + name);
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      nextNumber: 1,
      entries: new Map(),
      comments: new Map(),
      labels: new Map(),
      flatCache: new Map(),
    };
    this.repos.set(owner + '/' + name, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(owner + '/' + name);
  }

  tick(): number {
    this.clock += 1;
    return this.clock;
  }

  isoNow(): string {
    return new Date(this.tick() * 1000).toISOString();
  }
}

// ------------------------------------------------------------------ git objects

/** git's object id: SHA-1 over "<type> <len>\0" followed by the raw bytes. */
export function hashObject(type: GitObject['type'], body: Buffer): Oid {
  return createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest('hex');
}

/** Insert an object (idempotent) and return its id. */
export function putObject(repo: Repo, type: GitObject['type'], body: Buffer): Oid {
  const oid = hashObject(type, body);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, body });
  return oid;
}

export function getObject(repo: Repo, oid: Oid): GitObject | undefined {
  return repo.objects.get(oid);
}

export function putBlob(repo: Repo, content: Buffer): Oid {
  return putObject(repo, 'blob', content);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: Oid;
}

/** Decode a raw tree body into its entries, in stored order. */
export function parseTree(body: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    const space = body.indexOf(0x20, cursor);
    const nul = body.indexOf(0x00, space + 1);
    out.push({
      mode: body.toString('utf8', cursor, space),
      name: body.toString('utf8', space + 1, nul),
      oid: body.toString('hex', nul + 1, nul + 21),
    });
    cursor = nul + 21;
  }
  return out;
}

/** git orders tree entries bytewise, comparing a directory as if its name ended in '/'. */
function orderKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? entry.name + '/' : entry.name;
}

/** Serialize entries into a raw tree body in git's order. */
export function buildTreeBody(entries: TreeEntry[]): Buffer {
  const ordered = entries.slice().sort((a, b) => {
    const ka = orderKey(a);
    const kb = orderKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const chunks: Buffer[] = [];
  for (const entry of ordered) {
    chunks.push(Buffer.from(entry.mode + ' ' + entry.name + '\0', 'utf8'));
    chunks.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

/** Recursively flatten a tree into path -> blob id. */
export function flattenTree(repo: Repo, treeOid: Oid, prefix = '', into = new Map<string, Oid>()): Map<string, Oid> {
  const obj = getObject(repo, treeOid);
  if (obj === undefined || obj.type !== 'tree') return into;
  for (const entry of parseTree(obj.body)) {
    const path = prefix === '' ? entry.name : prefix + '/' + entry.name;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, into);
    else into.set(path, entry.oid);
  }
  return into;
}

/** The flattened file map of a commit, memoized per commit id. */
export function filesOfCommit(repo: Repo, commitOid: Oid): Map<string, Oid> {
  const hit = repo.flatCache.get(commitOid);
  if (hit !== undefined) return hit;
  const info = parseCommit(repo, commitOid);
  const files = info === null ? new Map<string, Oid>() : flattenTree(repo, info.tree);
  repo.flatCache.set(commitOid, files);
  return files;
}

/** Rebuild nested trees from a flat path -> blob map; returns the root tree id. */
export function buildTreeFromFiles(repo: Repo, files: Map<string, Oid>): Oid {
  interface Node {
    blobs: Map<string, Oid>;
    subs: Map<string, Node>;
  }
  const root: Node = { blobs: new Map(), subs: new Map() };
  for (const [path, oid] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = node.subs.get(part);
      if (child === undefined) {
        child = { blobs: new Map(), subs: new Map() };
        node.subs.set(part, child);
      }
      node = child;
    }
    node.blobs.set(parts[parts.length - 1] as string, oid);
  }
  const emit = (node: Node): Oid => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.blobs) entries.push({ mode: '100644', name, oid });
    for (const [name, sub] of node.subs) entries.push({ mode: '40000', name, oid: emit(sub) });
    return putObject(repo, 'tree', buildTreeBody(entries));
  };
  return emit(root);
}

export interface CommitInfo {
  tree: Oid;
  parents: Oid[];
  message: string;
  authorLine: string;
  epochSec: number;
}

/** Create and store a commit object stamped from the logical clock; returns its id. */
export function createCommit(
  repo: Repo,
  store: Store,
  input: { tree: Oid; parents: Oid[]; message: string; author?: ForgeUser },
): Oid {
  const who = input.author ?? VIEWER;
  const stamp = store.tick();
  const ident = `${who.name} <${who.email}> ${stamp} +0000`;
  const lines = ['tree ' + input.tree];
  for (const parent of input.parents) lines.push('parent ' + parent);
  lines.push('author ' + ident, 'committer ' + ident, '', input.message);
  return putObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
}

/** Parse a commit object; null when the id does not name a commit. */
export function parseCommit(repo: Repo, oid: Oid): CommitInfo | null {
  const obj = getObject(repo, oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const text = obj.body.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: Oid[] = [];
  let authorLine = '';
  let epochSec = 0;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      authorLine = line.slice(7);
      const m = / (\d+) [+-]\d{4}$/.exec(authorLine);
      if (m !== null) epochSec = Number(m[1]);
    }
  }
  return { tree, parents, message, authorLine, epochSec };
}

/** Every ancestor of a commit (including itself), breadth-first, newest first. */
export function ancestorsOf(repo: Repo, tip: Oid): Oid[] {
  const seen = new Set<Oid>();
  const order: Oid[] = [];
  const queue: Oid[] = [tip];
  while (queue.length > 0) {
    const current = queue.shift() as Oid;
    if (seen.has(current)) continue;
    seen.add(current);
    order.push(current);
    const info = parseCommit(repo, current);
    if (info !== null) queue.push(...info.parents);
  }
  return order;
}

/** Reachable commits of a tip ordered by logical time, newest first. */
export function historyOf(repo: Repo, tip: Oid): Oid[] {
  const ranked = ancestorsOf(repo, tip).map((oid) => ({ oid, t: parseCommit(repo, oid)?.epochSec ?? 0 }));
  ranked.sort((a, b) => b.t - a.t);
  return ranked.map((row) => row.oid);
}

/** Best common ancestor of two commits, or null when their histories are unrelated. */
export function mergeBaseOf(repo: Repo, a: Oid, b: Oid): Oid | null {
  const sideA = new Set(ancestorsOf(repo, a));
  for (const candidate of ancestorsOf(repo, b)) {
    if (sideA.has(candidate)) return candidate;
  }
  return null;
}

/** Resolve a branch name to its tip commit id. */
export function branchTip(repo: Repo, branch: string): Oid | undefined {
  return repo.refs.get('refs/heads/' + branch);
}

// ------------------------------------------------------------------ diffs and merges

/** The bytes behind a blob id, or an empty buffer when absent. */
export function blobBytes(repo: Repo, oid: Oid | undefined): Buffer {
  if (oid === undefined) return Buffer.alloc(0);
  const obj = getObject(repo, oid);
  return obj === undefined ? Buffer.alloc(0) : obj.body;
}

/** Count text lines the way diff counters do: a trailing newline ends the last line. */
export function countLines(text: string): number {
  if (text === '') return 0;
  const breaks = text.split('\n').length - 1;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

/** Line-level additions/deletions between two texts via a longest-common-subsequence pass. */
export function lineDiff(before: string, after: string): { additions: number; deletions: number } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  const common = dp[0]![0] as number;
  return { additions: b.length - common, deletions: a.length - common };
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  sha: Oid | undefined;
}

/** The files a pull request changes: merge-base tree versus head tree, GitHub-shaped. */
export function pullChangedFiles(repo: Repo, headTip: Oid, baseTip: Oid): ChangedFile[] {
  const base = mergeBaseOf(repo, headTip, baseTip) ?? baseTip;
  const before = filesOfCommit(repo, base);
  const after = filesOfCommit(repo, headTip);
  const paths = new Set([...before.keys(), ...after.keys()]);
  const files: ChangedFile[] = [];
  for (const path of paths) {
    const oldSha = before.get(path);
    const newSha = after.get(path);
    if (oldSha === newSha) continue;
    const diff = lineDiff(blobBytes(repo, oldSha).toString('utf8'), blobBytes(repo, newSha).toString('utf8'));
    files.push({
      filename: path,
      status: oldSha === undefined ? 'added' : newSha === undefined ? 'removed' : 'modified',
      additions: diff.additions,
      deletions: diff.deletions,
      changes: diff.additions + diff.deletions,
      sha: newSha ?? oldSha,
    });
  }
  files.sort((a, b) => (a.filename < b.filename ? -1 : 1));
  return files;
}

export type MergeOutcome = { merged: true; sha: Oid } | { merged: false; reason: 'conflict' | 'already-merged' | 'unmergeable' };

/**
 * Squash-merge a pull request: apply the head branch's changes (relative to the
 * merge-base) onto the current base tree as one new commit on the base branch. A
 * path conflicts when the base branch moved it away from the merge-base to something
 * the head does not also hold.
 */
export function squashMerge(store: Store, repo: Repo, pull: PullRec): MergeOutcome {
  if (pull.merged) return { merged: false, reason: 'already-merged' };
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return { merged: false, reason: 'unmergeable' };
  const base = mergeBaseOf(repo, headTip, baseTip) ?? baseTip;
  const atBase = filesOfCommit(repo, base);
  const atHead = filesOfCommit(repo, headTip);
  const merged = new Map(filesOfCommit(repo, baseTip));
  for (const [path, headSha] of atHead) {
    if (atBase.get(path) === headSha) continue;
    const nowSha = merged.get(path);
    if (nowSha !== atBase.get(path) && nowSha !== headSha) return { merged: false, reason: 'conflict' };
  }
  for (const path of atBase.keys()) {
    if (atHead.has(path)) continue;
    const nowSha = merged.get(path);
    if (nowSha !== atBase.get(path) && nowSha !== undefined) return { merged: false, reason: 'conflict' };
  }
  for (const [path, headSha] of atHead) {
    if (atBase.get(path) !== headSha) merged.set(path, headSha);
  }
  for (const path of atBase.keys()) {
    if (!atHead.has(path)) merged.delete(path);
  }
  const tree = buildTreeFromFiles(repo, merged);
  const sha = createCommit(repo, store, { tree, parents: [baseTip], message: `${pull.title} (#${pull.number})` });
  repo.refs.set('refs/heads/' + pull.baseRef, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.isoNow();
  pull.mergeCommitSha = sha;
  return { merged: true, sha };
}