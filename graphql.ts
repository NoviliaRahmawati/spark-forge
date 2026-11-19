// GraphQL v4: a small purpose-built executor for exactly the document family
// gh and github-mcp-server send (see docs/suite-spec.md section 8): a lexer and
// parser for the GraphQL subset those documents use (variables, aliases, inline
// fragments, enum literals, input objects), and resolvers over the shared store,
// so GraphQL reads and mutations see and change the same state as REST and git.
//
// Discipline the checks enforce:
// - Valid documents answer 200 with a data object and NO errors key.
// - A document naming an unknown field answers 200 with an errors array whose
//   message names the field (graphql-js wording), never an HTTP error.
// - Unknown repositories resolve to null, not an error.
// - Global ids are opaque, stable base64 encodings that resolve back in
//   node(id:) and in mutation inputs; they never equal the numeric ids.

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

// ------------------------------------------------------------------ global ids

const enc = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const dec = (id: string): string => {
  try {
    return Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return '';
  }
};

export const repoGlobalId = (repo: Repo): string => enc(`Repository:${repo.id}`);
export const issueGlobalId = (repo: Repo, entry: IssueRec): string => enc(`Issue:${repo.owner}/${repo.name}:${entry.number}`);
export const pullGlobalId = (repo: Repo, entry: PullRec): string => enc(`PullRequest:${repo.owner}/${repo.name}:${entry.number}`);
export const commentGlobalId = (repo: Repo, number: number, commentId: number): string =>
  enc(`Comment:${repo.owner}/${repo.name}:${number}:${commentId}`);

interface ResolvedId {
  kind: 'Repository' | 'Issue' | 'PullRequest' | 'Comment' | 'User' | 'unknown';
  repo?: Repo;
  number?: number;
  commentId?: number;
}

function resolveGlobalId(store: Store, id: string): ResolvedId {
  const text = dec(id);
  const repoFromKey = (key: string): Repo | undefined => store.repos.get(key);
  if (text.startsWith('Repository:')) {
    const numeric = Number(text.slice('Repository:'.length));
    for (const repo of store.repos.values()) if (repo.id === numeric) return { kind: 'Repository', repo };
    return { kind: 'unknown' };
  }
  if (text.startsWith('Issue:') || text.startsWith('PullRequest:')) {
    const kind = text.startsWith('Issue:') ? 'Issue' : 'PullRequest';
    const rest = text.slice(kind.length + 1);
    const at = rest.lastIndexOf(':');
    if (at === -1) return { kind: 'unknown' };
    const repo = repoFromKey(rest.slice(0, at));
    const number = Number(rest.slice(at + 1));
    if (repo === undefined || !Number.isInteger(number)) return { kind: 'unknown' };
    return { kind, repo, number };
  }
  if (text.startsWith('Comment:')) {
    const rest = text.slice('Comment:'.length);
    const parts = rest.split(':');
    if (parts.length < 3) return { kind: 'unknown' };
    const commentId = Number(parts.pop());
    const number = Number(parts.pop());
    const repo = repoFromKey(parts.join(':'));
    if (repo === undefined) return { kind: 'unknown' };
    return { kind: 'Comment', repo, number, commentId };
  }
  if (text.startsWith('User:')) return { kind: 'User' };
  return { kind: 'unknown' };
}

// ------------------------------------------------------------------ lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const escaped = source[j + 1] as string;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
      if (match === null) throw new Error(`bad number at ${i}`);
      tokens.push({ kind: 'int', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
      tokens.push({ kind: 'name', value: (match as RegExpExecArray)[0] });
      i += (match as RegExpExecArray)[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// ------------------------------------------------------------------ parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias?: string;
  args: Map<string, Value>;
  selection?: SelectionNode[];
}
interface FragmentNode {
  kind: 'inline';
  typeCondition: string;
  selection: SelectionNode[];
}
type SelectionNode = FieldNode | FragmentNode | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selection: SelectionNode[];
}

class Parser {
  private at = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }
  private next(): Token {
    const token = this.tokens[this.at];
    if (token === undefined) throw new Error('unexpected end of document');
    this.at += 1;
    return token;
  }
  private isPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, SelectionNode[]> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek() !== undefined) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const type = token.value as 'query' | 'mutation';
        this.next();
        let name: string | undefined;
        const after = this.peek();
        if (after !== undefined && after.kind === 'name') name = this.expectName();
        if (this.isPunct('(')) this.skipVariableDefinitions();
        this.skipDirectives();
        operations.push({ type, name, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('fragment without on');
        this.expectName();
        this.skipDirectives();
        fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token)}`);
    }
    return { operations, fragments };
  }

  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) {
        this.expectPunct('(');
        while (!this.isPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
        this.expectPunct(')');
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      if (this.isPunct('...')) {
        this.next();
        const after = this.peek();
        if (after !== undefined && after.kind === 'name' && after.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else {
          const name = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      let name = this.expectName();
      let alias: string | undefined;
      if (this.isPunct(':')) {
        this.next();
        alias = name;
        name = this.expectName();
      }
      const args = new Map<string, Value>();
      if (this.isPunct('(')) {
        this.next();
        while (!this.isPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.set(argName, this.parseValue());
        }
        this.expectPunct(')');
      }
      this.skipDirectives();
      let selection: SelectionNode[] | undefined;
      if (this.isPunct('{')) selection = this.parseSelectionSet();
      selections.push({ kind: 'field', name, alias, args, selection });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.isPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, Value>();
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.set(name, this.parseValue());
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value token');
  }
}

/** Coerce an AST value into a plain JS value using the operation's variables. */
function valueOf(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'int':
      return value.value;
    case 'string':
      return value.value;
    case 'bool':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of value.fields) out[key] = valueOf(inner, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------ schema & resolvers

/** A runtime value tagged with its GraphQL type. */
interface GqlObj {
  __t: string;
  [key: string]: unknown;
}

const obj = (__t: string, props: Record<string, unknown> = {}): GqlObj => ({ __t, ...props });

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
  fragments: Map<string, SelectionNode[]>;
}

const cursorOf = (number: number): string => enc(`cursor:${number}`);

function stateOfEntry(entry: IssueRec | PullRec): string {
  if (entry.isPull && entry.merged) return 'MERGED';
  return entry.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueTag(repo: Repo, entry: IssueRec): GqlObj {
  return obj('Issue', { repo, entry });
}
function pullTag(repo: Repo, entry: PullRec): GqlObj {
  return obj('PullRequest', { repo, entry });
}

function issuesConnection(repo: Repo, args: Map<string, Value>, ctx: Ctx): GqlObj {
  const first = args.has('first') ? Number(valueOf(args.get('first') as Value, ctx.variables)) : undefined;
  const afterRaw = args.has('after') ? valueOf(args.get('after') as Value, ctx.variables) : undefined;
  const states = args.has('states') ? (valueOf(args.get('states') as Value, ctx.variables) as string[]) : undefined;
  const orderBy = args.has('orderBy') ? (valueOf(args.get('orderBy') as Value, ctx.variables) as { direction?: string }) : undefined;
  let list = [...repo.entries.values()].filter((entry) => !entry.isPull) as IssueRec[];
  if (states !== undefined) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : 'closed')));
    list = list.filter((entry) => wanted.has(entry.state));
  }
  list.sort((a, b) => a.number - b.number);
  const descending = orderBy?.direction === 'DESC';
  if (descending) list.reverse();
  if (typeof afterRaw === 'string' && afterRaw !== '') {
    const decoded = dec(afterRaw);
    const match = /^cursor:(\d+)$/.exec(decoded);
    if (match !== null) {
      const boundary = Number(match[1]);
      list = list.filter((entry) => (descending ? entry.number < boundary : entry.number > boundary));
    }
  }
  const page = first !== undefined && Number.isFinite(first) ? list.slice(0, Math.max(0, Math.trunc(first))) : list;
  const last = page[page.length - 1];
  return obj('IssueConnection', {
    nodesRaw: page.map((entry) => issueTag(repo, entry)),
    totalCount: list.length,
    pageInfo: obj('PageInfo', {
      hasNextPage: list.length > page.length,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? cursorOf((page[0] as IssueRec).number) : null,
      endCursor: last !== undefined ? cursorOf(last.number) : null,
    }),
  });
}

function pullRequestsConnection(repo: Repo, args: Map<string, Value>, ctx: Ctx): GqlObj {
  const first = args.has('first') ? Number(valueOf(args.get('first') as Value, ctx.variables)) : undefined;
  let list = [...repo.entries.values()].filter((entry) => entry.isPull) as PullRec[];
  list.sort((a, b) => a.number - b.number);
  const states = args.has('states') ? (valueOf(args.get('states') as Value, ctx.variables) as string[]) : undefined;
  if (states !== undefined) list = list.filter((entry) => states.includes(stateOfEntry(entry)));
  const page = first !== undefined && Number.isFinite(first) ? list.slice(0, Math.max(0, Math.trunc(first))) : list;
  const last = page[page.length - 1];
  return obj('PullRequestConnection', {
    nodesRaw: page.map((entry) => pullTag(repo, entry)),
    totalCount: list.length,
    pageInfo: obj('PageInfo', {
      hasNextPage: list.length > page.length,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? cursorOf((page[0] as PullRec).number) : null,
      endCursor: last !== undefined ? cursorOf(last.number) : null,
    }),
  });
}

function mergeableOf(repo: Repo, pull: PullRec): string {
  if (pull.merged) return 'UNKNOWN';
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  // The same conflict rule squashMerge applies, evaluated without mutating.
  const base = mergeBaseOf(repo, headTip, baseTip) ?? baseTip;
  const atBase = filesOfCommit(repo, base);
  const atHead = filesOfCommit(repo, headTip);
  const atCurrent = filesOfCommit(repo, baseTip);
  for (const [path, headSha] of atHead) {
    if (atBase.get(path) === headSha) continue;
    const currentSha = atCurrent.get(path);
    if (currentSha !== atBase.get(path) && currentSha !== headSha) return 'CONFLICTING';
  }
  for (const path of atBase.keys()) {
    if (atHead.has(path)) continue;
    const currentSha = atCurrent.get(path);
    if (currentSha !== atBase.get(path) && currentSha !== undefined) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/** Resolve one field on one tagged object; throws nothing, records unknown fields as errors. */
function resolveField(ctx: Ctx, source: GqlObj | null, typeName: string, field: FieldNode): unknown {
  const name = field.name;
  const args = field.args;
  const arg = (key: string): unknown => (args.has(key) ? valueOf(args.get(key) as Value, ctx.variables) : undefined);
  if (name === '__typename') return typeName;

  switch (typeName) {
    case 'Query': {
      if (name === 'viewer') return obj('User', {});
      if (name === 'repository') {
        const owner = String(arg('owner') ?? '');
        const repoName = String(arg('name') ?? '');
        const repo = ctx.store.getRepo(owner, repoName);
        return repo === undefined ? null : obj('Repository', { repo });
      }
      if (name === 'node') {
        const resolved = resolveGlobalId(ctx.store, String(arg('id') ?? ''));
        if (resolved.kind === 'Repository' && resolved.repo !== undefined) return obj('Repository', { repo: resolved.repo });
        if (resolved.kind === 'Issue' && resolved.repo !== undefined) {
          const entry = resolved.repo.entries.get(resolved.number as number);
          return entry !== undefined && !entry.isPull ? issueTag(resolved.repo, entry) : null;
        }
        if (resolved.kind === 'PullRequest' && resolved.repo !== undefined) {
          const entry = resolved.repo.entries.get(resolved.number as number);
          return entry !== undefined && entry.isPull ? pullTag(resolved.repo, entry) : null;
        }
        if (resolved.kind === 'User') return obj('User', {});
        return null;
      }
      if (name === '__type') {
        const typeNameArg = String(arg('name') ?? '');
        if (TYPE_FIELDS[typeNameArg] === undefined && TYPE_ENUMS[typeNameArg] === undefined) return null;
        return obj('__Type', { name: typeNameArg });
      }
      break;
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = (arg('input') ?? {}) as { repositoryId?: string; title?: string; body?: string };
        const resolved = resolveGlobalId(ctx.store, String(input.repositoryId ?? ''));
        if (resolved.kind !== 'Repository' || resolved.repo === undefined) throw new Error('repository not found');
        const repo = resolved.repo;
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
        return obj('CreateIssuePayload', { issue: issueTag(repo, entry) });
      }
      if (name === 'closeIssue') {
        const input = (arg('input') ?? {}) as { issueId?: string };
        const resolved = resolveGlobalId(ctx.store, String(input.issueId ?? ''));
        if (resolved.kind !== 'Issue' || resolved.repo === undefined) throw new Error('issue not found');
        const entry = resolved.repo.entries.get(resolved.number as number);
        if (entry === undefined || entry.isPull) throw new Error('issue not found');
        entry.state = 'closed';
        return obj('CloseIssuePayload', { issue: issueTag(resolved.repo, entry) });
      }
      if (name === 'createPullRequest') {
        const input = (arg('input') ?? {}) as { repositoryId?: string; baseRefName?: string; headRefName?: string; title?: string; body?: string };
        const resolved = resolveGlobalId(ctx.store, String(input.repositoryId ?? ''));
        if (resolved.kind !== 'Repository' || resolved.repo === undefined) throw new Error('repository not found');
        const repo = resolved.repo;
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
        return obj('CreatePullRequestPayload', { pullRequest: pullTag(repo, entry) });
      }
      if (name === 'mergePullRequest') {
        const input = (arg('input') ?? {}) as { pullRequestId?: string };
        const resolved = resolveGlobalId(ctx.store, String(input.pullRequestId ?? ''));
        if (resolved.kind !== 'PullRequest' || resolved.repo === undefined) throw new Error('pull request not found');
        const entry = resolved.repo.entries.get(resolved.number as number);
        if (entry === undefined || !entry.isPull) throw new Error('pull request not found');
        const outcome = squashMerge(ctx.store, resolved.repo, entry);
        if (!outcome.merged && outcome.reason !== 'already-merged') throw new Error('pull request is not mergeable');
        return obj('MergePullRequestPayload', { pullRequest: pullTag(resolved.repo, entry) });
      }
      if (name === 'addComment') {
        const input = (arg('input') ?? {}) as { subjectId?: string; body?: string };
        const resolved = resolveGlobalId(ctx.store, String(input.subjectId ?? ''));
        if ((resolved.kind !== 'Issue' && resolved.kind !== 'PullRequest') || resolved.repo === undefined) throw new Error('subject not found');
        const repo = resolved.repo;
        const number = resolved.number as number;
        if (repo.entries.get(number) === undefined) throw new Error('subject not found');
        const comment = { id: ctx.store.nextCommentId++, body: String(input.body ?? '') };
        const list = repo.comments.get(number) ?? [];
        list.push(comment);
        repo.comments.set(number, list);
        const node = obj('Comment', { id: commentGlobalId(repo, number, comment.id), body: comment.body });
        return obj('AddCommentPayload', { commentEdge: obj('CommentEdge', { node, cursor: cursorOf(comment.id) }), subject: null });
      }
      break;
    }
    case 'User': {
      if (name === 'login') return VIEWER.login;
      if (name === 'id') return enc(`User:${VIEWER.id}`);
      if (name === 'name') return VIEWER.name;
      if (name === 'email') return VIEWER.email;
      break;
    }
    case 'Repository': {
      const repo = source?.repo as Repo;
      switch (name) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return obj('User', {});
        case 'description': return repo.description;
        case 'isPrivate': return repo.private;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'defaultBranchRef': {
          const tip = branchTip(repo, repo.defaultBranch);
          return tip === undefined ? null : obj('Ref', { name: repo.defaultBranch });
        }
        case 'issue': {
          const number = Number(arg('number'));
          const entry = repo.entries.get(number);
          return entry !== undefined && !entry.isPull ? issueTag(repo, entry) : null;
        }
        case 'issues': return issuesConnection(repo, args, ctx);
        case 'pullRequest': {
          const number = Number(arg('number'));
          const entry = repo.entries.get(number);
          return entry !== undefined && entry.isPull ? pullTag(repo, entry) : null;
        }
        case 'pullRequests': return pullRequestsConnection(repo, args, ctx);
        case 'url': return `http://forge.local/${repo.owner}/${repo.name}`;
        case 'createdAt': return '2025-01-01T00:00:00Z';
        case 'updatedAt': return '2025-01-01T00:00:00Z';
      }
      break;
    }
    case 'Issue': {
      const entry = source?.entry as IssueRec;
      const repo = source?.repo as Repo;
      switch (name) {
        case 'id': return issueGlobalId(repo, entry);
        case 'number': return entry.number;
        case 'title': return entry.title;
        case 'body': return entry.body;
        case 'state': return entry.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'closed': return entry.state === 'closed';
        case 'url': return `http://forge.local/issues/${entry.number}`;
        case 'author': return obj('User', {});
        case 'repository': return obj('Repository', { repo });
        case 'createdAt': return '2025-01-01T00:00:00Z';
        case 'updatedAt': return '2025-01-01T00:00:00Z';
        case 'labels': return obj('LabelConnection', { nodesRaw: entry.labels.map((label) => obj('Label', { name: label })) });
        case 'comments': return obj('IssueCommentConnection', { nodesRaw: [] });
      }
      break;
    }
    case 'PullRequest': {
      const entry = source?.entry as PullRec;
      const repo = source?.repo as Repo;
      switch (name) {
        case 'id': return pullGlobalId(repo, entry);
        case 'number': return entry.number;
        case 'title': return entry.title;
        case 'body': return entry.body;
        case 'state': return stateOfEntry(entry);
        case 'merged': return entry.merged;
        case 'closed': return entry.state === 'closed';
        case 'mergedAt': return entry.mergedAt;
        case 'mergeable': return mergeableOf(repo, entry);
        case 'headRefName': return entry.headRef;
        case 'baseRefName': return entry.baseRef;
        case 'author': return obj('User', {});
        case 'createdAt': return '2025-01-01T00:00:00Z';
        case 'updatedAt': return '2025-01-01T00:00:00Z';
        case 'url': return `http://forge.local/pulls/${entry.number}`;
        case 'files': {
          const headTip = branchTip(repo, entry.headRef);
          const baseTip = branchTip(repo, entry.baseRef);
          const all = headTip !== undefined && baseTip !== undefined ? pullChangedFiles(repo, headTip, baseTip) : [];
          const first = args.has('first') ? Number(valueOf(args.get('first') as Value, ctx.variables)) : undefined;
          const paths = (first !== undefined && Number.isFinite(first) ? all.slice(0, Math.max(0, Math.trunc(first))) : all).map((file) => file.filename);
          return obj('PullRequestChangedFilesConnection', {
            nodesRaw: paths.map((path) => obj('ChangedFile', { path })),
            totalCount: all.length,
            pageInfo: obj('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }),
          });
        }
      }
      break;
    }
    case 'Ref': {
      if (name === 'name') return source?.name;
      if (name === 'prefix') return 'refs/heads/';
      break;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return source?.hasNextPage;
      if (name === 'hasPreviousPage') return source?.hasPreviousPage;
      if (name === 'startCursor') return source?.startCursor;
      if (name === 'endCursor') return source?.endCursor;
      break;
    }
    case '__Type': {
      const typeNameArg = source?.name as string;
      if (name === 'name') return typeNameArg;
      if (name === 'kind') return TYPE_ENUMS[typeNameArg] !== undefined ? 'ENUM' : 'OBJECT';
      if (name === 'fields') {
        const fields = TYPE_FIELDS[typeNameArg];
        return fields === undefined ? null : fields.map((fieldName) => obj('__Field', { name: fieldName }));
      }
      if (name === 'enumValues') {
        const values = TYPE_ENUMS[typeNameArg];
        return values === undefined ? null : values.map((valueName) => obj('__EnumValue', { name: valueName }));
      }
      break;
    }
    case '__Field':
    case '__EnumValue': {
      if (name === 'name') return source?.name;
      break;
    }
  }

  // Connection plumbing shared by every connection type.
  if (typeName.endsWith('Connection')) {
    if (name === 'nodes') return source?.nodesRaw;
    if (name === 'pageInfo') return source?.pageInfo;
    if (name === 'totalCount') return source?.totalCount;
    if (name === 'edges') {
      const nodes = (source?.nodesRaw as GqlObj[] | undefined) ?? [];
      return nodes.map((node) => obj('Edge', { node, cursor: '' }));
    }
  }
  if (typeName === 'Comment') {
    if (name === 'id') return source?.id;
    if (name === 'body') return source?.body;
    if (name === 'author') return obj('User', {});
    if (name === 'createdAt') return '2025-01-01T00:00:00Z';
  }
  if (typeName === 'CommentEdge') {
    if (name === 'node') return source?.node;
    if (name === 'cursor') return source?.cursor;
  }
  if (typeName.endsWith('Payload')) {
    if (name === 'issue') return source?.issue;
    if (name === 'pullRequest') return source?.pullRequest;
    if (name === 'commentEdge') return source?.commentEdge;
    if (name === 'subject') return source?.subject ?? null;
    if (name === 'clientMutationId') return null;
  }
  if (typeName === 'Label') {
    if (name === 'name') return source?.name;
    if (name === 'id') return enc(`Label:${String(source?.name)}`);
  }
  if (typeName === 'ChangedFile') {
    if (name === 'path') return source?.path;
  }

  ctx.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
  return null;
}

/** Execute a selection set against a tagged source object. */
function executeSelection(ctx: Ctx, source: GqlObj | null, typeName: string, selection: SelectionNode[]): Record<string, unknown> {
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

/** Complete a resolved value: recurse into objects/arrays that carry a selection set. */
function completeValue(ctx: Ctx, value: unknown, node: FieldNode): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, node));
  if (typeof value === 'object' && node.selection !== undefined) {
    const tagged = value as GqlObj;
    if (typeof tagged.__t === 'string') return executeSelection(ctx, tagged, tagged.__t, node.selection);
    return executeSelection(ctx, tagged as GqlObj, 'User', node.selection);
  }
  return value;
}

export interface GraphqlRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

/** Execute one GraphQL operation envelope; returns the response envelope. */
export function handleGraphql(store: Store, request: GraphqlRequest): Record<string, unknown> {
  const ctx: Ctx = { store, variables: request.variables ?? {}, errors: [], fragments: new Map() };
  try {
    const { operations, fragments } = new Parser(lex(request.query)).parseDocument();
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
