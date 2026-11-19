// The forge's shared store: one in-memory state that every surface (git smart HTTP,
// REST v3, GraphQL, MCP) reads and writes, so an object created through one surface
// is visible through all the others, exactly as the suite's cross-surface checks
// require. Git objects are stored per repository, keyed by their SHA-1 id, and are
// immutable once written.
//
// Design notes (Spark, in-session; architecture memo by Xingchi gpt-6.1-sol in
// docs/xingchi-design-memo.md informed the one-store/four-adapters shape):
// - Commit timestamps come from a logical clock, never the wall clock, so two runs
//   of the same scripted scenario produce identical object ids.
// - Trees are manipulated through a flattened path -> blob map and rebuilt
//   recursively with git's exact entry ordering (directories sort as name + '/').

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

/** The one authenticated user: the scenario viewer the suite's token belongs to. */
export const VIEWER: ForgeUser = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  isPull: false;
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
  /** issue/PR numbers share one per-repo sequence, as on GitHub. */
  nextNumber: number;
  entries: Map<number, IssueOrPull>;
  comments: Map<number, CommentRec[]>;
  labels: Map<string, { name: string; color: string }>;
  /** flattened-tree cache: commit sha -> (path -> blob sha). */
  flatCache: Map<Oid, Map<string, Oid>>;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextEntryId = 1;
  nextCommentId = 1;
  /** Logical clock (epoch seconds) for commit timestamps and merged_at. */
  clock = 1735689600;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
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
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  tick(): number {
    this.clock += 1;
    return this.clock;
  }

  isoNow(): string {
    return new Date(this.tick() * 1000).toISOString();
  }
}

// ---------------------------------------------------------------- git objects

/** The SHA-1 id of a git object: sha1("<type> <len>\0" + body). */
export function hashObject(type: GitObject['type'], body: Buffer): Oid {
  const head = Buffer.from(`${type} ${body.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(body).digest('hex');
}

/** Store an object in the repo (idempotent) and return its id. */
export function putObject(repo: Repo, type: GitObject['type'], body: Buffer): Oid {
  const oid = hashObject(type, body);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, body });
  return oid;
}

export function getObject(repo: Repo, oid: Oid): GitObject | undefined {
  return repo.objects.get(oid);
}

/** Write a blob and return its id. */
export function putBlob(repo: Repo, content: Buffer): Oid {
  return putObject(repo, 'blob', content);
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: Oid;
}

/** Parse a raw tree body into entries. */
export function parseTree(body: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < body.length) {
    const sp = body.indexOf(0x20, at);
    const mode = body.toString('utf8', at, sp);
    const nul = body.indexOf(0x00, sp + 1);
    const name = body.toString('utf8', sp + 1, nul);
    const oid = body.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    at = nul + 21;
  }
  return entries;
}

/** Git's tree ordering: names compare bytewise, directories as if suffixed with '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialize entries into a raw tree body, git-ordered. */
export function buildTreeBody(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into path -> blob oid. */
export function flattenTree(repo: Repo, treeOid: Oid, prefix = '', out = new Map<string, Oid>()): Map<string, Oid> {
  const obj = getObject(repo, treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.body)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, entry.oid);
  }
  return out;
}

/** The flattened file map of a commit, cached per commit id. */
export function filesOfCommit(repo: Repo, commitOid: Oid): Map<string, Oid> {
  const cached = repo.flatCache.get(commitOid);
  if (cached !== undefined) return cached;
  const commit = parseCommit(repo, commitOid);
  const files = commit === null ? new Map<string, Oid>() : flattenTree(repo, commit.tree);
  repo.flatCache.set(commitOid, files);
  return files;
}

/** Build (and store) nested trees from a flat path -> blob oid map; returns the root tree id. */
export function buildTreeFromFiles(repo: Repo, files: Map<string, Oid>): Oid {
  interface Dir {
    files: Map<string, Oid>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, oid] of files) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let next = dir.dirs.get(part);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1] as string, oid);
  }
  const write = (dir: Dir): Oid => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of dir.files) entries.push({ mode: '100644', name, oid });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: write(sub) });
    return putObject(repo, 'tree', buildTreeBody(entries));
  };
  return write(root);
}

export interface CommitInfo {
  tree: Oid;
  parents: Oid[];
  message: string;
  authorLine: string;
  epochSec: number;
}

/** Create (and store) a commit object; returns its id. */
export function createCommit(
  repo: Repo,
  store: Store,
  input: { tree: Oid; parents: Oid[]; message: string; author?: ForgeUser },
): Oid {
  const author = input.author ?? VIEWER;
  const ts = store.tick();
  const ident = `${author.name} <${author.email}> ${ts} +0000`;
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '', input.message);
  return putObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
}

/** Parse a commit object; null when the id is not a commit. */
export function parseCommit(repo: Repo, oid: Oid): CommitInfo | null {
  const obj = getObject(repo, oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const text = obj.body.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: Oid[] = [];
  let authorLine = '';
  let epochSec = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      authorLine = line.slice(7);
      const match = / (\d+) [+-]\d{4}$/.exec(authorLine);
      if (match !== null) epochSec = Number(match[1]);
    }
  }
  return { tree, parents, message, authorLine, epochSec };
}

/** All ancestors of a commit (including itself), breadth-first, newest first. */
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

/** Commit history for a tip: reachable commits sorted by their logical time, newest first. */
export function historyOf(repo: Repo, tip: Oid): Oid[] {
  const all = ancestorsOf(repo, tip);
  const withTime = all.map((oid) => ({ oid, t: parseCommit(repo, oid)?.epochSec ?? 0 }));
  withTime.sort((a, b) => b.t - a.t);
  return withTime.map((entry) => entry.oid);
}

/** The merge-base (best common ancestor) of two commits, or null when unrelated. */
export function mergeBaseOf(repo: Repo, a: Oid, b: Oid): Oid | null {
  const ancestorsA = new Set(ancestorsOf(repo, a));
  for (const candidate of ancestorsOf(repo, b)) {
    if (ancestorsA.has(candidate)) return candidate;
  }
  return null;
}

/** Resolve a ref name (refs/heads/x) or the default branch name to a commit id. */
export function branchTip(repo: Repo, branch: string): Oid | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

// ------------------------------------------------------------------ diffs & merges (shared by REST, GraphQL, MCP)

/** The blob bytes behind an oid, or an empty buffer when absent. */
export function blobBytes(repo: Repo, oid: Oid | undefined): Buffer {
  if (oid === undefined) return Buffer.alloc(0);
  const obj = getObject(repo, oid);
  return obj === undefined ? Buffer.alloc(0) : obj.body;
}

/** Count text lines the way diff counters do: a trailing newline ends the last line. */
export function countLines(text: string): number {
  if (text === '') return 0;
  const newlines = text.split('\n').length - 1;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

/** Line-level additions/deletions between two texts, via a longest-common-subsequence pass. */
export function lineDiff(before: string, after: string): { additions: number; deletions: number } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
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
  const files: ChangedFile[] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const beforeSha = before.get(path);
    const afterSha = after.get(path);
    if (beforeSha === afterSha) continue;
    const diff = lineDiff(blobBytes(repo, beforeSha).toString('utf8'), blobBytes(repo, afterSha).toString('utf8'));
    files.push({
      filename: path,
      status: beforeSha === undefined ? 'added' : afterSha === undefined ? 'removed' : 'modified',
      additions: diff.additions,
      deletions: diff.deletions,
      changes: diff.additions + diff.deletions,
      sha: afterSha ?? beforeSha,
    });
  }
  files.sort((a, b) => (a.filename < b.filename ? -1 : 1));
  return files;
}

export type MergeOutcome = { merged: true; sha: Oid } | { merged: false; reason: 'conflict' | 'already-merged' | 'unmergeable' };

/**
 * Squash-merge a pull request in the store: apply the head branch's changes
 * (relative to the merge-base) onto the current base tree as one new commit on
 * the base branch. A path the PR changes conflicts when the base branch has
 * also moved that path away from the merge-base to something the head is not.
 */
export function squashMerge(store: Store, repo: Repo, pull: PullRec): MergeOutcome {
  if (pull.merged) return { merged: false, reason: 'already-merged' };
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return { merged: false, reason: 'unmergeable' };
  const base = mergeBaseOf(repo, headTip, baseTip) ?? baseTip;
  const atBase = filesOfCommit(repo, base);
  const atHead = filesOfCommit(repo, headTip);
  const atCurrent = new Map(filesOfCommit(repo, baseTip));
  for (const [path, headSha] of atHead) {
    if (atBase.get(path) === headSha) continue;
    const currentSha = atCurrent.get(path);
    if (currentSha !== atBase.get(path) && currentSha !== headSha) return { merged: false, reason: 'conflict' };
  }
  for (const path of atBase.keys()) {
    if (atHead.has(path)) continue;
    const currentSha = atCurrent.get(path);
    if (currentSha !== atBase.get(path) && currentSha !== undefined) return { merged: false, reason: 'conflict' };
  }
  for (const [path, headSha] of atHead) {
    if (atBase.get(path) !== headSha) atCurrent.set(path, headSha);
  }
  for (const path of atBase.keys()) {
    if (!atHead.has(path)) atCurrent.delete(path);
  }
  const tree = buildTreeFromFiles(repo, atCurrent);
  const commitSha = createCommit(repo, store, { tree, parents: [baseTip], message: `${pull.title} (#${pull.number})` });
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.isoNow();
  pull.mergeCommitSha = commitSha;
  return { merged: true, sha: commitSha };
}
