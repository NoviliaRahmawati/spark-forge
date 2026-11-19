// GraphQL v4: a compact executor for the document family gh and github-mcp-server
// send. A tokenizer and a recursive-descent parser cover the subset those documents
// use (variables, aliases, inline fragments, named fragments, enum literals, input
// objects, lists); per-type resolver tables read and mutate the one shared store, so
// GraphQL sees exactly the state REST and git see.
//
// Discipline the checks enforce: a valid document answers 200 with a data object and
// no errors key; a document naming an unknown field answers 200 with an errors array
// whose message names that field; an unknown repository resolves to null without an
// error; global ids are opaque stable base64 strings that resolve back through node(id:)
// and mutation inputs, never equal to the numeric ids.

import {
  Store,
  VIEWER,
  type IssueRec,
  type PullRec,
  type Repo,
  branchTip,
  filesOfCommit,
  mergeBaseOf,
  pullChangedFiles,
  squashMerge,
} from './store.ts';

// ------------------------------------------------------------------ opaque global ids

const toBase64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const fromBase64 = (id: string): string => {
  try {
    return Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return '';
  }
};

export const repoGlobalId = (repo: Repo): string => toBase64('Repository:' + repo.id);
export const issueGlobalId = (repo: Repo, entry: IssueRec): string => toBase64(`Issue:${repo.owner}/${repo.name}:${entry.number}`);
export const pullGlobalId = (repo: Repo, entry: PullRec): string => toBase64(`PullRequest:${repo.owner}/${repo.name}:${entry.number}`);
export const commentGlobalId = (repo: Repo, number: number, commentId: number): string =>
  toBase64(`Comment:${repo.owner}/${repo.name}:${number}:${commentId}`);

interface Decoded {
  kind: 'Repository' | 'Issue' | 'PullRequest' | 'Comment' | 'User' | 'unknown';
  repo?: Repo;
  number?: number;
  commentId?: number;
}

/** Decode an opaque id back into the store object it names. */
function decodeId(store: Store, id: string): Decoded {
  const text = fromBase64(id);
  const byKey = (key: string): Repo | undefined => store.repos.get(key);
  if (text.startsWith('Repository:')) {
    const numeric = Number(text.slice(11));
    for (const repo of store.repos.values()) if (repo.id === numeric) return { kind: 'Repository', repo };
    return { kind: 'unknown' };
  }
  if (text.startsWith('Issue:') || text.startsWith('PullRequest:')) {
    const kind = text.startsWith('Issue:') ? 'Issue' : 'PullRequest';
    const tail = text.slice(kind.length + 1);
    const colon = tail.lastIndexOf(':');
    if (colon === -1) return { kind: 'unknown' };
    const repo = byKey(tail.slice(0, colon));
    const number = Number(tail.slice(colon + 1));
    if (repo === undefined || !Number.isInteger(number)) return { kind: 'unknown' };
    return { kind, repo, number };
  }
  if (text.startsWith('Comment:')) {
    const parts = text.slice(8).split(':');
    if (parts.length < 3) return { kind: 'unknown' };
    const commentId = Number(parts.pop());
    const number = Number(parts.pop());
    const repo = byKey(parts.join(':'));
    if (repo === undefined) return { kind: 'unknown' };
    return { kind: 'Comment', repo, number, commentId };
  }
  if (text.startsWith('User:')) return { kind: 'User' };
  return { kind: 'unknown' };
}

// ------------------------------------------------------------------ tokenizer

type Tok =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string };

const PUNCT = '!$():=@[]{}|&';
const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
const isNamePart = (ch: string): boolean => /[_0-9A-Za-z]/.test(ch);

/** Turn GraphQL source into a token stream, dropping whitespace, commas and comments. */
function tokenize(source: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
    } else if (ch === '#') {
      while (i < n && source[i] !== '\n') i += 1;
    } else if (ch === '.' && source.startsWith('...', i)) {
      out.push({ kind: 'punct', value: '...' });
      i += 3;
    } else if (PUNCT.includes(ch)) {
      out.push({ kind: 'punct', value: ch });
      i += 1;
    } else if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        out.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
      } else {
        let j = i + 1;
        let value = '';
        while (j < n && source[j] !== '"') {
          if (source[j] === '\\') {
            const esc = source[j + 1] as string;
            value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
            j += 2;
          } else {
            value += source[j];
            j += 1;
          }
        }
        if (j >= n) throw new Error('unterminated string');
        out.push({ kind: 'string', value });
        i = j + 1;
      }
    } else if (/[0-9-]/.test(ch)) {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
      if (m === null) throw new Error('bad number at ' + i);
      out.push({ kind: 'int', value: Number(m[0]) });
      i += m[0].length;
    } else if (isNameStart(ch)) {
      let j = i + 1;
      while (j < n && isNamePart(source[j] as string)) j += 1;
      out.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
    } else {
      throw new Error('unexpected character ' + JSON.stringify(ch));
    }
  }
  return out;
}

// ------------------------------------------------------------------ parser

type Ast =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Ast[] }
  | { kind: 'object'; fields: Map<string, Ast> };

interface Field {
  kind: 'field';
  name: string;
  alias?: string;
  args: Map<string, Ast>;
  selection?: Sel[];
}
interface Inline {
  kind: 'inline';
  typeCondition: string;
  selection: Sel[];
}
type Sel = Field | Inline | { kind: 'spread'; name: string };
interface Op {
  type: 'query' | 'mutation';
  name?: string;
  selection: Sel[];
}

/** Recursive-descent parse of a token stream into operations and named fragments. */
function parse(tokens: Tok[]): { operations: Op[]; fragments: Map<string, Sel[]> } {
  let pos = 0;
  const peek = (): Tok | undefined => tokens[pos];
  const take = (): Tok => {
    const tok = tokens[pos];
    if (tok === undefined) throw new Error('unexpected end of document');
    pos += 1;
    return tok;
  };
  const isPunct = (value: string): boolean => {
    const tok = peek();
    return tok !== undefined && tok.kind === 'punct' && tok.value === value;
  };
  const eatPunct = (value: string): void => {
    const tok = take();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error('expected ' + value);
  };
  const eatName = (): string => {
    const tok = take();
    if (tok.kind !== 'name') throw new Error('expected a name');
    return tok.value;
  };

  function skipVarDefs(): void {
    eatPunct('(');
    let depth = 1;
    while (depth > 0) {
      const tok = take();
      if (tok.kind === 'punct' && tok.value === '(') depth += 1;
      if (tok.kind === 'punct' && tok.value === ')') depth -= 1;
    }
  }
  function skipDirectives(): void {
    while (isPunct('@')) {
      take();
      eatName();
      if (isPunct('(')) {
        eatPunct('(');
        while (!isPunct(')')) {
          eatName();
          eatPunct(':');
          value();
        }
        eatPunct(')');
      }
    }
  }
  function value(): Ast {
    const tok = take();
    if (tok.kind === 'punct' && tok.value === '$') return { kind: 'var', name: eatName() };
    if (tok.kind === 'int') return { kind: 'int', value: tok.value };
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'punct' && tok.value === '[') {
      const items: Ast[] = [];
      while (!isPunct(']')) items.push(value());
      eatPunct(']');
      return { kind: 'list', items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields = new Map<string, Ast>();
      while (!isPunct('}')) {
        const key = eatName();
        eatPunct(':');
        fields.set(key, value());
      }
      eatPunct('}');
      return { kind: 'object', fields };
    }
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'bool', value: true };
      if (tok.value === 'false') return { kind: 'bool', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error('unexpected value token');
  }
  function selectionSet(): Sel[] {
    eatPunct('{');
    const sels: Sel[] = [];
    while (!isPunct('}')) {
      if (isPunct('...')) {
        take();
        const after = peek();
        if (after !== undefined && after.kind === 'name' && after.value === 'on') {
          take();
          const typeCondition = eatName();
          skipDirectives();
          sels.push({ kind: 'inline', typeCondition, selection: selectionSet() });
        } else {
          const name = eatName();
          skipDirectives();
          sels.push({ kind: 'spread', name });
        }
        continue;
      }
      let name = eatName();
      let alias: string | undefined;
      if (isPunct(':')) {
        take();
        alias = name;
        name = eatName();
      }
      const args = new Map<string, Ast>();
      if (isPunct('(')) {
        take();
        while (!isPunct(')')) {
          const key = eatName();
          eatPunct(':');
          args.set(key, value());
        }
        eatPunct(')');
      }
      skipDirectives();
      const selection = isPunct('{') ? selectionSet() : undefined;
      sels.push({ kind: 'field', name, alias, args, selection });
    }
    eatPunct('}');
    return sels;
  }

  const operations: Op[] = [];
  const fragments = new Map<string, Sel[]>();
  while (peek() !== undefined) {
    const tok = peek() as Tok;
    if (tok.kind === 'punct' && tok.value === '{') {
      operations.push({ type: 'query', selection: selectionSet() });
    } else if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation')) {
      const type = tok.value as 'query' | 'mutation';
      take();
      let name: string | undefined;
      const after = peek();
      if (after !== undefined && after.kind === 'name') name = eatName();
      if (isPunct('(')) skipVarDefs();
      skipDirectives();
      operations.push({ type, name, selection: selectionSet() });
    } else if (tok.kind === 'name' && tok.value === 'fragment') {
      take();
      const fragName = eatName();
      const onTok = take();
      if (onTok.kind !== 'name' || onTok.value !== 'on') throw new Error('fragment without on');
      eatName();
      skipDirectives();
      fragments.set(fragName, selectionSet());
    } else {
      throw new Error('unexpected token ' + JSON.stringify(tok));
    }
  }
  return { operations, fragments };
}

/** Coerce an AST value to a plain JS value, substituting the operation's variables. */
function coerce(ast: Ast, variables: Record<string, unknown>): unknown {
  switch (ast.kind) {
    case 'var': return variables[ast.name];
    case 'int': return ast.value;
    case 'string': return ast.value;
    case 'bool': return ast.value;
    case 'null': return null;
    case 'enum': return ast.value;
    case 'list': return ast.items.map((item) => coerce(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of ast.fields) out[key] = coerce(inner, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------ schema surface

/** A runtime value tagged with the GraphQL type it should be resolved as. */
interface Tagged {
  __t: string;
  [key: string]: unknown;
}
const tag = (__t: string, props: Record<string, unknown> = {}): Tagged => ({ __t, ...props });

/** The fields introspection advertises per object type (the suite reads these lists). */
const TYPE_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'rateLimit', 'meta'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue'],
  User: ['id', 'login', 'name', 'email', 'url', 'createdAt', 'avatarUrl'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url', 'primaryLanguage', 'stargazerCount', 'forkCount', 'isFork',
  ],
  Issue: [
    'id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels',
    'comments', 'repository', 'closed', 'locked', 'activeLockReason',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'author', 'createdAt', 'updatedAt', 'url', 'mergedAt', 'closed', 'additions', 'deletions',
    'changedFiles', 'headRef', 'baseRef', 'mergeCommit',
  ],
  Ref: ['name', 'prefix', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFilesConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  ChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Comment: ['id', 'body', 'createdAt', 'author', 'url'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
};

const TYPE_ENUMS: Record<string, readonly string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string }[];
  fragments: Map<string, Sel[]>;
}

/** A field resolver: read coerces an argument by name (undefined when absent). */
type Resolver = (ctx: Ctx, src: Tagged | null, read: (key: string) => unknown) => unknown;

const cursorOf = (number: number): string => toBase64('cursor:' + number);
const FIXED_TIME = '2025-01-01T00:00:00Z';

function entryState(entry: IssueRec | PullRec): string {
  if (entry.isPull && entry.merged) return 'MERGED';
  return entry.state === 'open' ? 'OPEN' : 'CLOSED';
}
const issueTag = (repo: Repo, entry: IssueRec): Tagged => tag('Issue', { repo, entry });
const pullTag = (repo: Repo, entry: PullRec): Tagged => tag('PullRequest', { repo, entry });

/** Build a connection object from an ordered, filtered page of tagged nodes. */
function connection(typeName: string, page: Tagged[], totalCount: number): Tagged {
  const last = page[page.length - 1];
  const firstNum = page.length > 0 ? Number((page[0] as Tagged & { entry?: { number: number } }).entry?.number ?? 0) : 0;
  const lastNum = last !== undefined ? Number((last as Tagged & { entry?: { number: number } }).entry?.number ?? 0) : 0;
  return tag(typeName, {
    nodesRaw: page,
    totalCount,
    pageInfo: tag('PageInfo', {
      hasNextPage: totalCount > page.length,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? cursorOf(firstNum) : null,
      endCursor: last !== undefined ? cursorOf(lastNum) : null,
    }),
  });
}

function issuesConnection(repo: Repo, read: (key: string) => unknown, ctx: Ctx): Tagged {
  const first = read('first');
  const afterRaw = read('after');
  const states = read('states') as string[] | undefined;
  const orderBy = read('orderBy') as { direction?: string } | undefined;
  let list = [...repo.entries.values()].filter((entry) => !entry.isPull) as IssueRec[];
  if (states !== undefined) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : 'closed')));
    list = list.filter((entry) => wanted.has(entry.state));
  }
  list.sort((a, b) => a.number - b.number);
  const descending = orderBy?.direction === 'DESC';
  if (descending) list.reverse();
  if (typeof afterRaw === 'string' && afterRaw !== '') {
    const m = /^cursor:(\d+)$/.exec(fromBase64(afterRaw));
    if (m !== null) {
      const boundary = Number(m[1]);
      list = list.filter((entry) => (descending ? entry.number < boundary : entry.number > boundary));
    }
  }
  const page = typeof first === 'number' && Number.isFinite(first) ? list.slice(0, Math.max(0, Math.trunc(first))) : list;
  return connection('IssueConnection', page.map((entry) => issueTag(repo, entry)), list.length);
}

function pullsConnection(repo: Repo, read: (key: string) => unknown): Tagged {
  const first = read('first');
  const states = read('states') as string[] | undefined;
  let list = [...repo.entries.values()].filter((entry) => entry.isPull) as PullRec[];
  list.sort((a, b) => a.number - b.number);
  if (states !== undefined) list = list.filter((entry) => states.includes(entryState(entry)));
  const page = typeof first === 'number' && Number.isFinite(first) ? list.slice(0, Math.max(0, Math.trunc(first))) : list;
  return connection('PullRequestConnection', page.map((entry) => pullTag(repo, entry)), list.length);
}

/** The mergeable state, applying squashMerge's conflict rule without mutating. */
function mergeableOf(repo: Repo, pull: PullRec): string {
  if (pull.merged) return 'UNKNOWN';
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  const base = mergeBaseOf(repo, headTip, baseTip) ?? baseTip;
  const atBase = filesOfCommit(repo, base);
  const atHead = filesOfCommit(repo, headTip);
  const atCurrent = filesOfCommit(repo, baseTip);
  for (const [path, headSha] of atHead) {
    if (atBase.get(path) === headSha) continue;
    const nowSha = atCurrent.get(path);
    if (nowSha !== atBase.get(path) && nowSha !== headSha) return 'CONFLICTING';
  }
  for (const path of atBase.keys()) {
    if (atHead.has(path)) continue;
    const nowSha = atCurrent.get(path);
    if (nowSha !== atBase.get(path) && nowSha !== undefined) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

// ------------------------------------------------------------------ resolver tables

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => tag('User', {}),
    repository: (ctx, _src, read) => {
      const repo = ctx.store.getRepo(String(read('owner') ?? ''), String(read('name') ?? ''));
      return repo === undefined ? null : tag('Repository', { repo });
    },
    node: (ctx, _src, read) => {
      const decoded = decodeId(ctx.store, String(read('id') ?? ''));
      if (decoded.kind === 'Repository' && decoded.repo !== undefined) return tag('Repository', { repo: decoded.repo });
      if (decoded.kind === 'Issue' && decoded.repo !== undefined) {
        const entry = decoded.repo.entries.get(decoded.number as number);
        return entry !== undefined && !entry.isPull ? issueTag(decoded.repo, entry) : null;
      }
      if (decoded.kind === 'PullRequest' && decoded.repo !== undefined) {
        const entry = decoded.repo.entries.get(decoded.number as number);
        return entry !== undefined && entry.isPull ? pullTag(decoded.repo, entry) : null;
      }
      if (decoded.kind === 'User') return tag('User', {});
      return null;
    },
    __type: (_ctx, _src, read) => {
      const name = String(read('name') ?? '');
      if (TYPE_FIELDS[name] === undefined && TYPE_ENUMS[name] === undefined) return null;
      return tag('__Type', { name });
    },
  },
  Mutation: {
    createIssue: (ctx, _src, read) => {
      const input = (read('input') ?? {}) as { repositoryId?: string; title?: string; body?: string };
      const decoded = decodeId(ctx.store, String(input.repositoryId ?? ''));
      if (decoded.kind !== 'Repository' || decoded.repo === undefined) throw new Error('repository not found');
      const repo = decoded.repo;
      const entry: IssueRec = {
        id: ctx.store.nextEntryId++,
        number: repo.nextNumber++,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        isPull: false,
      };
      repo.entries.set(entry.number, entry);
      return tag('CreateIssuePayload', { issue: issueTag(repo, entry) });
    },
    closeIssue: (ctx, _src, read) => {
      const input = (read('input') ?? {}) as { issueId?: string };
      const decoded = decodeId(ctx.store, String(input.issueId ?? ''));
      if (decoded.kind !== 'Issue' || decoded.repo === undefined) throw new Error('issue not found');
      const entry = decoded.repo.entries.get(decoded.number as number);
      if (entry === undefined || entry.isPull) throw new Error('issue not found');
      entry.state = 'closed';
      return tag('CloseIssuePayload', { issue: issueTag(decoded.repo, entry) });
    },
    createPullRequest: (ctx, _src, read) => {
      const input = (read('input') ?? {}) as { repositoryId?: string; baseRefName?: string; headRefName?: string; title?: string; body?: string };
      const decoded = decodeId(ctx.store, String(input.repositoryId ?? ''));
      if (decoded.kind !== 'Repository' || decoded.repo === undefined) throw new Error('repository not found');
      const repo = decoded.repo;
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (branchTip(repo, head) === undefined || branchTip(repo, base) === undefined) throw new Error('head or base branch does not exist');
      const entry: PullRec = {
        id: ctx.store.nextEntryId++,
        number: repo.nextNumber++,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        headRef: head,
        baseRef: base,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        isPull: true,
      };
      repo.entries.set(entry.number, entry);
      return tag('CreatePullRequestPayload', { pullRequest: pullTag(repo, entry) });
    },
    mergePullRequest: (ctx, _src, read) => {
      const input = (read('input') ?? {}) as { pullRequestId?: string };
      const decoded = decodeId(ctx.store, String(input.pullRequestId ?? ''));
      if (decoded.kind !== 'PullRequest' || decoded.repo === undefined) throw new Error('pull request not found');
      const entry = decoded.repo.entries.get(decoded.number as number);
      if (entry === undefined || !entry.isPull) throw new Error('pull request not found');
      const outcome = squashMerge(ctx.store, decoded.repo, entry);
      if (!outcome.merged && outcome.reason !== 'already-merged') throw new Error('pull request is not mergeable');
      return tag('MergePullRequestPayload', { pullRequest: pullTag(decoded.repo, entry) });
    },
    addComment: (ctx, _src, read) => {
      const input = (read('input') ?? {}) as { subjectId?: string; body?: string };
      const decoded = decodeId(ctx.store, String(input.subjectId ?? ''));
      if ((decoded.kind !== 'Issue' && decoded.kind !== 'PullRequest') || decoded.repo === undefined) throw new Error('subject not found');
      const repo = decoded.repo;
      const number = decoded.number as number;
      if (repo.entries.get(number) === undefined) throw new Error('subject not found');
      const comment = { id: ctx.store.nextCommentId++, body: String(input.body ?? '') };
      const list = repo.comments.get(number) ?? [];
      list.push(comment);
      repo.comments.set(number, list);
      const node = tag('Comment', { id: commentGlobalId(repo, number, comment.id), body: comment.body });
      return tag('AddCommentPayload', { commentEdge: tag('CommentEdge', { node, cursor: cursorOf(comment.id) }), subject: null });
    },
  },
  User: {
    login: () => VIEWER.login,
    id: () => toBase64('User:' + VIEWER.id),
    name: () => VIEWER.name,
    email: () => VIEWER.email,
  },
  Repository: {
    id: (_ctx, src) => repoGlobalId(src?.repo as Repo),
    databaseId: (_ctx, src) => (src?.repo as Repo).id,
    name: (_ctx, src) => (src?.repo as Repo).name,
    nameWithOwner: (_ctx, src) => { const repo = src?.repo as Repo; return repo.owner + '/' + repo.name; },
    owner: () => tag('User', {}),
    description: (_ctx, src) => (src?.repo as Repo).description,
    isPrivate: (_ctx, src) => (src?.repo as Repo).private,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    defaultBranchRef: (_ctx, src) => {
      const repo = src?.repo as Repo;
      return branchTip(repo, repo.defaultBranch) === undefined ? null : tag('Ref', { name: repo.defaultBranch });
    },
    issue: (_ctx, src, read) => {
      const repo = src?.repo as Repo;
      const entry = repo.entries.get(Number(read('number')));
      return entry !== undefined && !entry.isPull ? issueTag(repo, entry) : null;
    },
    issues: (ctx, src, read) => issuesConnection(src?.repo as Repo, read, ctx),
    pullRequest: (_ctx, src, read) => {
      const repo = src?.repo as Repo;
      const entry = repo.entries.get(Number(read('number')));
      return entry !== undefined && entry.isPull ? pullTag(repo, entry) : null;
    },
    pullRequests: (ctx, src, read) => pullsConnection(src?.repo as Repo, read),
    url: (_ctx, src) => { const repo = src?.repo as Repo; return 'http://forge.local/' + repo.owner + '/' + repo.name; },
    createdAt: () => FIXED_TIME,
    updatedAt: () => FIXED_TIME,
  },
  Issue: {
    id: (_ctx, src) => issueGlobalId(src?.repo as Repo, src?.entry as IssueRec),
    number: (_ctx, src) => (src?.entry as IssueRec).number,
    title: (_ctx, src) => (src?.entry as IssueRec).title,
    body: (_ctx, src) => (src?.entry as IssueRec).body,
    state: (_ctx, src) => ((src?.entry as IssueRec).state === 'open' ? 'OPEN' : 'CLOSED'),
    closed: (_ctx, src) => (src?.entry as IssueRec).state === 'closed',
    url: (_ctx, src) => 'http://forge.local/issues/' + (src?.entry as IssueRec).number,
    author: () => tag('User', {}),
    repository: (_ctx, src) => tag('Repository', { repo: src?.repo }),
    createdAt: () => FIXED_TIME,
    updatedAt: () => FIXED_TIME,
    labels: (_ctx, src) => tag('LabelConnection', { nodesRaw: (src?.entry as IssueRec).labels.map((label) => tag('Label', { name: label })) }),
    comments: () => tag('IssueCommentConnection', { nodesRaw: [] }),
  },
  PullRequest: {
    id: (_ctx, src) => pullGlobalId(src?.repo as Repo, src?.entry as PullRec),
    number: (_ctx, src) => (src?.entry as PullRec).number,
    title: (_ctx, src) => (src?.entry as PullRec).title,
    body: (_ctx, src) => (src?.entry as PullRec).body,
    state: (_ctx, src) => entryState(src?.entry as PullRec),
    merged: (_ctx, src) => (src?.entry as PullRec).merged,
    closed: (_ctx, src) => (src?.entry as PullRec).state === 'closed',
    mergedAt: (_ctx, src) => (src?.entry as PullRec).mergedAt,
    mergeable: (_ctx, src) => mergeableOf(src?.repo as Repo, src?.entry as PullRec),
    headRefName: (_ctx, src) => (src?.entry as PullRec).headRef,
    baseRefName: (_ctx, src) => (src?.entry as PullRec).baseRef,
    author: () => tag('User', {}),
    createdAt: () => FIXED_TIME,
    updatedAt: () => FIXED_TIME,
    url: (_ctx, src) => 'http://forge.local/pulls/' + (src?.entry as PullRec).number,
    files: (ctx, src, read) => {
      const repo = src?.repo as Repo;
      const entry = src?.entry as PullRec;
      const headTip = branchTip(repo, entry.headRef);
      const baseTip = branchTip(repo, entry.baseRef);
      const all = headTip !== undefined && baseTip !== undefined ? pullChangedFiles(repo, headTip, baseTip) : [];
      const first = read('first');
      const sliced = typeof first === 'number' && Number.isFinite(first) ? all.slice(0, Math.max(0, Math.trunc(first))) : all;
      return tag('PullRequestChangedFilesConnection', {
        nodesRaw: sliced.map((file) => tag('ChangedFile', { path: file.filename })),
        totalCount: all.length,
        pageInfo: tag('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }),
      });
    },
  },
  Ref: {
    name: (_ctx, src) => src?.name,
    prefix: () => 'refs/heads/',
  },
  PageInfo: {
    hasNextPage: (_ctx, src) => src?.hasNextPage,
    hasPreviousPage: (_ctx, src) => src?.hasPreviousPage,
    startCursor: (_ctx, src) => src?.startCursor,
    endCursor: (_ctx, src) => src?.endCursor,
  },
  __Type: {
    name: (_ctx, src) => src?.name,
    kind: (_ctx, src) => (TYPE_ENUMS[src?.name as string] !== undefined ? 'ENUM' : 'OBJECT'),
    fields: (_ctx, src) => {
      const fields = TYPE_FIELDS[src?.name as string];
      return fields === undefined ? null : fields.map((fieldName) => tag('__Field', { name: fieldName }));
    },
    enumValues: (_ctx, src) => {
      const values = TYPE_ENUMS[src?.name as string];
      return values === undefined ? null : values.map((valueName) => tag('__EnumValue', { name: valueName }));
    },
  },
  __Field: { name: (_ctx, src) => src?.name },
  __EnumValue: { name: (_ctx, src) => src?.name },
  Comment: {
    id: (_ctx, src) => src?.id,
    body: (_ctx, src) => src?.body,
    author: () => tag('User', {}),
    createdAt: () => FIXED_TIME,
  },
  CommentEdge: {
    node: (_ctx, src) => src?.node,
    cursor: (_ctx, src) => src?.cursor,
  },
  Label: {
    name: (_ctx, src) => src?.name,
    id: (_ctx, src) => toBase64('Label:' + String(src?.name)),
  },
  ChangedFile: { path: (_ctx, src) => src?.path },
};

/** Payload types all expose their wrapped object plus a null clientMutationId. */
const PAYLOAD_FIELDS: Record<string, Resolver> = {
  issue: (_ctx, src) => src?.issue,
  pullRequest: (_ctx, src) => src?.pullRequest,
  commentEdge: (_ctx, src) => src?.commentEdge,
  subject: (_ctx, src) => src?.subject ?? null,
  clientMutationId: () => null,
};

/** Resolve one field on a tagged source; unknown fields become graphql-js errors. */
function resolveField(ctx: Ctx, source: Tagged | null, typeName: string, field: Field): unknown {
  const name = field.name;
  if (name === '__typename') return typeName;
  const read = (key: string): unknown => (field.args.has(key) ? coerce(field.args.get(key) as Ast, ctx.variables) : undefined);

  const fn = RESOLVERS[typeName]?.[name] ?? (typeName.endsWith('Payload') ? PAYLOAD_FIELDS[name] : undefined);
  if (fn !== undefined) return fn(ctx, source, read);

  if (typeName.endsWith('Connection')) {
    if (name === 'nodes') return source?.nodesRaw;
    if (name === 'pageInfo') return source?.pageInfo;
    if (name === 'totalCount') return source?.totalCount;
    if (name === 'edges') {
      const nodes = (source?.nodesRaw as Tagged[] | undefined) ?? [];
      return nodes.map((node) => tag('Edge', { node, cursor: '' }));
    }
  }

  ctx.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
  return null;
}

// ------------------------------------------------------------------ execution

/** Execute a selection set against a tagged source, honouring fragments and aliases. */
function executeSelection(ctx: Ctx, source: Tagged | null, typeName: string, selection: Sel[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind === 'inline') {
      if (node.typeCondition === typeName) Object.assign(out, executeSelection(ctx, source, typeName, node.selection));
      continue;
    }
    if (node.kind === 'spread') {
      const fragment = ctx.fragments.get(node.name);
      if (fragment !== undefined) Object.assign(out, executeSelection(ctx, source, typeName, fragment));
      continue;
    }
    const key = node.alias ?? node.name;
    const errorsBefore = ctx.errors.length;
    let value: unknown;
    try {
      value = resolveField(ctx, source, typeName, node);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      value = null;
    }
    if (ctx.errors.length > errorsBefore && value === null && node.name !== '__typename') {
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, node);
  }
  return out;
}

/** Complete a resolved value, recursing into tagged objects and arrays with a selection. */
function completeValue(ctx: Ctx, value: unknown, node: Field): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, node));
  if (typeof value === 'object' && node.selection !== undefined) {
    const tagged = value as Tagged;
    if (typeof tagged.__t === 'string') return executeSelection(ctx, tagged, tagged.__t, node.selection);
    return executeSelection(ctx, tagged, 'User', node.selection);
  }
  return value;
}

export interface GraphqlRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

/** Execute one GraphQL envelope and return its response envelope. */
export function handleGraphql(store: Store, request: GraphqlRequest): Record<string, unknown> {
  const ctx: Ctx = { store, variables: request.variables ?? {}, errors: [], fragments: new Map() };
  try {
    const { operations, fragments } = parse(tokenize(request.query));
    ctx.fragments = fragments;
    const operation = operations.find((op) => request.operationName === undefined || op.name === request.operationName) ?? operations[0];
    if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const data = executeSelection(ctx, null, rootType, operation.selection);
    const envelope: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) envelope.errors = ctx.errors;
    return envelope;
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
}