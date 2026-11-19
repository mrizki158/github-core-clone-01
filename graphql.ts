// A small GraphQL engine for the GitHub v4 surface the suite drives: a parser for the
// documents gh and github-mcp-server send, and an executor over the forge's store.
import { branchRef, shortRef, VIEWER, type IssueRec, type PullRec, type RepoRec, type Store } from './store.ts';
import { addCommentRecord, createIssueRecord, createPullRecord, performMerge, pullFilesList, pullMergeable } from './core.ts';

// ---------------------------------------------------------------- parsing

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Map<string, Value>;
  selection?: SelectionNode[];
}

interface FragmentNode {
  kind: 'inline';
  typeCondition: string;
  selection: SelectionNode[];
}

interface SpreadNode {
  kind: 'spread';
  name: string;
}

type SelectionNode = FieldNode | FragmentNode | SpreadNode;

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selection: SelectionNode[];
}

interface FragmentDef {
  typeCondition: string;
  selection: SelectionNode[];
}

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(c)) {
      i += 1;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:$!@='.includes(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        tokens.push(`"${src.slice(i + 3, end === -1 ? src.length : end)}"`);
        i = end === -1 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          out += src[j + 1] === 'n' ? '\n' : src[j + 1] === 't' ? '\t' : src[j + 1] === 'r' ? '\r' : (src[j + 1] as string);
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j] as string)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j] as string)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const t = this.tokens[this.pos];
    if (t === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return t;
  }

  expect(t: string): void {
    const got = this.next();
    if (got !== t) throw new Error(`expected ${t}, got ${got}`);
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, FragmentDef> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.pos < this.tokens.length) {
      const head = this.peek();
      if (head === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation') {
        const type = this.next() as 'query' | 'mutation';
        let name: string | undefined;
        if (this.peek() !== '(' && this.peek() !== '{') name = this.next();
        if (this.peek() === '(') this.skipBalanced();
        // Directives, if any, are skipped: the suite's documents carry none that matter.
        while (this.peek() === '@') {
          this.next();
          this.next();
          if (this.peek() === '(') this.skipBalanced();
        }
        operations.push({ type, name, selection: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${head}`);
      }
    }
    return { operations, fragments };
  }

  private skipBalanced(): void {
    let depth = 0;
    do {
      const t = this.next();
      if (t === '(' || t === '[' || t === '{') depth += 1;
      else if (t === ')' || t === ']' || t === '}') depth -= 1;
    } while (depth > 0);
  }

  parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const out: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          out.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else {
          out.push({ kind: 'spread', name: this.next() });
        }
        continue;
      }
      let name = this.next();
      let alias: string | undefined;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args = new Map<string, Value>();
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args.set(argName, this.parseValue());
        }
        this.expect(')');
      }
      while (this.peek() === '@') {
        this.next();
        this.next();
        if (this.peek() === '(') this.skipBalanced();
      }
      let selection: SelectionNode[] | undefined;
      if (this.peek() === '{') selection = this.parseSelectionSet();
      out.push({ kind: 'field', alias, name, args, selection });
    }
    this.expect('}');
    return out;
  }

  parseValue(): Value {
    const t = this.next();
    if (t === '$') return { kind: 'var', name: this.next() };
    if (t.startsWith('"')) return { kind: 'string', value: t.slice(1, -1) };
    if (t === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (t === '{') {
      const fields = new Map<string, Value>();
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields.set(key, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t === 'true') return { kind: 'bool', value: true };
    if (t === 'false') return { kind: 'bool', value: false };
    if (t === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(t)) return { kind: 'int', value: Number(t) };
    if (/^-?\d*\.\d/.test(t)) return { kind: 'float', value: Number(t) };
    return { kind: 'enum', value: t };
  }
}

function resolveValue(value: Value, vars: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return vars[value.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of value.fields) out[k] = resolveValue(v, vars);
      return out;
    }
  }
}

// ---------------------------------------------------------------- global ids

function toGlobalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function fromGlobalId(id: string): { type: string; key: string } | undefined {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const split = text.indexOf(':');
    if (split < 0) return undefined;
    return { type: text.slice(0, split), key: text.slice(split + 1) };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- the schema

interface Ctx {
  store: Store;
  vars: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: Array<{ message: string }>;
}

type Source = Record<string, unknown> & { __typename: string };
type Resolver = (source: Source, args: Record<string, unknown>, ctx: Ctx) => unknown;

function repoSource(store: Store, repo: RepoRec): Source {
  return { __typename: 'Repository', repo, id: toGlobalId('Repository', String(repo.id)) };
}

function issueSource(repo: RepoRec, issue: IssueRec): Source {
  return { __typename: 'Issue', repo, issue, id: toGlobalId('Issue', `${repo.id}:${issue.number}`) };
}

function pullSource(repo: RepoRec, pull: PullRec): Source {
  return { __typename: 'PullRequest', repo, pull, id: toGlobalId('PullRequest', `${repo.id}:${pull.number}`) };
}

function userSource(login: string): Source {
  return { __typename: 'User', login, id: toGlobalId('User', login) };
}

function repoOf(source: Source): RepoRec {
  return source.repo as RepoRec;
}

function stateOf(issue: IssueRec): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateOf(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

interface Connection<T> {
  items: T[];
  total: number;
  endIndex: number;
}

function page<T extends { number: number }>(items: T[], args: Record<string, unknown>): Connection<T> {
  const first = typeof args.first === 'number' ? args.first : 30;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    try {
      const decoded = Buffer.from(args.after, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match) {
        const idx = items.findIndex((item) => item.number === Number(match[1]));
        if (idx >= 0) start = idx + 1;
      }
    } catch {
      start = 0;
    }
  }
  const slice = items.slice(start, start + first);
  return { items: slice, total: items.length, endIndex: start + slice.length };
}

function connectionSource<T extends { number: number }>(
  typename: string,
  conn: Connection<T>,
  wrap: (item: T) => Source,
): Source {
  const nodes = conn.items.map(wrap);
  const last = conn.items[conn.items.length - 1];
  return {
    __typename: typename,
    nodes,
    totalCount: conn.total,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: conn.endIndex < conn.total,
      hasPreviousPage: false,
      endCursor: last ? Buffer.from(`cursor:${last.number}`, 'utf8').toString('base64') : null,
      startCursor: null,
    },
  };
}

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit', 'meta'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'reopenIssue', 'updateIssue'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url', 'isFork', 'isArchived', 'stargazerCount', 'forkCount',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'repository', 'labels', 'comments',
    'createdAt', 'updatedAt', 'closedAt', 'url', 'viewerDidAuthor', 'locked', 'milestone', 'assignees',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'author', 'repository', 'createdAt', 'updatedAt', 'mergedAt', 'closedAt', 'additions',
    'deletions', 'changedFiles', 'mergeCommit', 'url', 'isDraft', 'labels', 'comments', 'reviews',
  ],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url', 'createdAt', 'updatedAt'],
  Organization: ['id', 'login', 'name', 'url'],
  Ref: ['id', 'name', 'prefix', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Commit: ['id', 'oid', 'message', 'messageHeadline', 'authoredDate'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  FileStatus: ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED'],
};

function typeSource(name: string): Source | null {
  if (TYPE_FIELDS[name]) {
    return {
      __typename: '__Type',
      name,
      kind: 'OBJECT',
      fields: TYPE_FIELDS[name].map((fieldName) => ({ __typename: '__Field', name: fieldName })),
      enumValues: null,
    };
  }
  if (TYPE_ENUMS[name]) {
    return {
      __typename: '__Type',
      name,
      kind: 'ENUM',
      fields: null,
      enumValues: TYPE_ENUMS[name].map((valueName) => ({ __typename: '__EnumValue', name: valueName })),
    };
  }
  if (name === 'Node') {
    return { __typename: '__Type', name, kind: 'INTERFACE', fields: [{ __typename: '__Field', name: 'id' }], enumValues: null };
  }
  return null;
}

function findRepoByGlobalId(store: Store, id: string): RepoRec | undefined {
  const decoded = fromGlobalId(id);
  if (!decoded || decoded.type !== 'Repository') return undefined;
  const repoId = Number(decoded.key);
  return [...store.repos.values()].find((r) => r.id === repoId);
}

const resolvers: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_s, _a, ctx) => userSource(VIEWER.login),
    repository: (_s, args, ctx) => {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      if (owner !== VIEWER.login) return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo ? repoSource(ctx.store, repo) : null;
    },
    node: (_s, args, ctx) => {
      const id = String(args.id ?? '');
      const decoded = fromGlobalId(id);
      if (!decoded) return null;
      if (decoded.type === 'Repository') {
        const repo = [...ctx.store.repos.values()].find((r) => r.id === Number(decoded.key));
        return repo ? repoSource(ctx.store, repo) : null;
      }
      if (decoded.type === 'User') return userSource(decoded.key);
      if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
        const [repoId, num] = decoded.key.split(':').map(Number);
        const repo = [...ctx.store.repos.values()].find((r) => r.id === repoId);
        if (!repo) return null;
        if (decoded.type === 'Issue') {
          const issue = repo.issues.get(num as number);
          return issue ? issueSource(repo, issue) : null;
        }
        const pull = repo.pulls.get(num as number);
        return pull ? pullSource(repo, pull) : null;
      }
      return null;
    },
    __type: (_s, args) => typeSource(String(args.name ?? '')),
    __schema: () => ({ __typename: '__Schema', types: [] }),
    rateLimit: () => ({ __typename: 'RateLimit', limit: 5000, cost: 1, remaining: 4999, used: 1, resetAt: '2030-01-01T00:00:00Z', nodeCount: 0 }),
    meta: () => null,
  },
  Mutation: {
    createIssue: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGlobalId(ctx.store, String(input.repositoryId ?? ''));
      if (!repo) throw new Error('Repository not found');
      const issue = createIssueRecord(repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        labels: [],
      });
      return { __typename: 'CreateIssuePayload', issue: issueSource(repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = fromGlobalId(String(input.issueId ?? ''));
      if (!decoded || decoded.type !== 'Issue') throw new Error('Issue not found');
      const [repoId, num] = decoded.key.split(':').map(Number);
      const repo = [...ctx.store.repos.values()].find((r) => r.id === repoId);
      const issue = repo?.issues.get(num as number);
      if (!repo || !issue) throw new Error('Issue not found');
      issue.state = 'closed';
      issue.closed_at = new Date().toISOString();
      issue.updated_at = issue.closed_at;
      return { __typename: 'CloseIssuePayload', issue: issueSource(repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    createPullRequest: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGlobalId(ctx.store, String(input.repositoryId ?? ''));
      if (!repo) throw new Error('Repository not found');
      const pull = createPullRecord(ctx.store, repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? repo.default_branch),
      });
      if (!pull) throw new Error('Invalid head or base branch');
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(repo, pull), clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = fromGlobalId(String(input.pullRequestId ?? ''));
      if (!decoded || decoded.type !== 'PullRequest') throw new Error('Pull request not found');
      const [repoId, num] = decoded.key.split(':').map(Number);
      const repo = [...ctx.store.repos.values()].find((r) => r.id === repoId);
      const pull = repo?.pulls.get(num as number);
      if (!repo || !pull) throw new Error('Pull request not found');
      if (!pull.merged && pull.state === 'open') {
        const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
        performMerge(ctx.store, repo, pull, method);
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullSource(repo, pull), clientMutationId: input.clientMutationId ?? null };
    },
    addComment: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = fromGlobalId(String(input.subjectId ?? ''));
      if (!decoded || (decoded.type !== 'Issue' && decoded.type !== 'PullRequest')) throw new Error('Subject not found');
      const [repoId, num] = decoded.key.split(':').map(Number);
      const repo = [...ctx.store.repos.values()].find((r) => r.id === repoId);
      if (!repo) throw new Error('Subject not found');
      const comment = addCommentRecord(ctx.store, repo, num as number, String(input.body ?? ''));
      if (!comment) throw new Error('Subject not found');
      const node: Source = {
        __typename: 'IssueComment',
        id: toGlobalId('IssueComment', `${repo.id}:${num}:${comment.id}`),
        body: comment.body,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
        author: userSource(comment.user),
      };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node },
        clientMutationId: input.clientMutationId ?? null,
      };
    },
  },
  Repository: {
    id: (s) => s.id,
    databaseId: (s) => repoOf(s).id,
    name: (s) => repoOf(s).name,
    nameWithOwner: (s) => `${repoOf(s).owner}/${repoOf(s).name}`,
    owner: (s) => userSource(repoOf(s).owner),
    description: (s) => repoOf(s).description,
    isPrivate: (s) => repoOf(s).private,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    createdAt: (s) => repoOf(s).created_at,
    updatedAt: (s) => repoOf(s).updated_at,
    url: (s) => `http://forge.local/${repoOf(s).owner}/${repoOf(s).name}`,
    isFork: () => false,
    isArchived: () => false,
    stargazerCount: () => 0,
    forkCount: () => 0,
    defaultBranchRef: (s) => {
      const repo = repoOf(s);
      return { __typename: 'Ref', name: repo.default_branch, prefix: 'refs/heads/', id: toGlobalId('Ref', `${repo.id}:${branchRef(repo.default_branch)}`) };
    },
    issue: (s, args) => {
      const repo = repoOf(s);
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueSource(repo, issue) : null;
    },
    issues: (s, args) => {
      const repo = repoOf(s);
      let items = [...repo.issues.values()];
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        items = items.filter((i) => states.includes(stateOf(i)));
      }
      const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
      items.sort((a, b) => a.number - b.number);
      if (orderBy.direction !== 'ASC') items.reverse();
      const conn = page(items, args);
      return connectionSource('IssueConnection', conn, (i) => issueSource(repo, i));
    },
    pullRequest: (s, args) => {
      const repo = repoOf(s);
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullSource(repo, pull) : null;
    },
    pullRequests: (s, args) => {
      const repo = repoOf(s);
      let items = [...repo.pulls.values()];
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        items = items.filter((p) => states.includes(pullStateOf(p)));
      }
      items.sort((a, b) => b.number - a.number);
      const conn = page(items, args);
      return connectionSource('PullRequestConnection', conn, (p) => pullSource(repo, p));
    },
  },
  Issue: {
    id: (s) => s.id,
    number: (s) => (s.issue as IssueRec).number,
    title: (s) => (s.issue as IssueRec).title,
    body: (s) => (s.issue as IssueRec).body,
    state: (s) => stateOf(s.issue as IssueRec),
    author: (s) => userSource((s.issue as IssueRec).user),
    repository: (s) => repoSource(null as unknown as Store, repoOf(s)),
    createdAt: (s) => (s.issue as IssueRec).created_at,
    updatedAt: (s) => (s.issue as IssueRec).updated_at,
    closedAt: (s) => (s.issue as IssueRec).closed_at,
    url: (s) => `http://forge.local/x/issues/${(s.issue as IssueRec).number}`,
    locked: () => false,
    viewerDidAuthor: () => true,
  },
  PullRequest: {
    id: (s) => s.id,
    number: (s) => (s.pull as PullRec).number,
    title: (s) => (s.pull as PullRec).title,
    body: (s) => (s.pull as PullRec).body,
    state: (s) => pullStateOf(s.pull as PullRec),
    merged: (s) => (s.pull as PullRec).merged,
    mergedAt: (s) => (s.pull as PullRec).merged_at,
    closedAt: (s) => ((s.pull as PullRec).merged ? (s.pull as PullRec).merged_at : null),
    headRefName: (s) => shortRef((s.pull as PullRec).headRef),
    baseRefName: (s) => shortRef((s.pull as PullRec).baseRef),
    author: (s) => userSource((s.pull as PullRec).user),
    repository: (s) => repoSource(null as unknown as Store, repoOf(s)),
    createdAt: (s) => (s.pull as PullRec).created_at,
    updatedAt: (s) => (s.pull as PullRec).updated_at,
    isDraft: () => false,
    mergeable: (s, _a, ctx) => {
      const pull = s.pull as PullRec;
      if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
      return pullMergeable(ctx.store, repoOf(s), pull) ? 'MERGEABLE' : 'CONFLICTING';
    },
    files: (s, args, ctx) => {
      const repo = repoOf(s);
      const pull = s.pull as PullRec;
      const files = pullFilesList(ctx.store, repo, pull).map((f) => ({
        __typename: 'PullRequestChangedFile',
        path: f.filename,
        additions: f.additions,
        deletions: f.deletions,
        changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'DELETED' : 'MODIFIED',
      }));
      const first = typeof args.first === 'number' ? args.first : 30;
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: files.slice(0, first),
        totalCount: files.length,
        pageInfo: { __typename: 'PageInfo', hasNextPage: files.length > first, hasPreviousPage: false, endCursor: null, startCursor: null },
      };
    },
    additions: (s, _a, ctx) => pullFilesList(ctx.store, repoOf(s), s.pull as PullRec).reduce((n, f) => n + f.additions, 0),
    deletions: (s, _a, ctx) => pullFilesList(ctx.store, repoOf(s), s.pull as PullRec).reduce((n, f) => n + f.deletions, 0),
    changedFiles: (s, _a, ctx) => pullFilesList(ctx.store, repoOf(s), s.pull as PullRec).length,
  },
  User: {
    id: (s) => s.id,
    login: (s) => s.login,
    name: (s) => (s.login === VIEWER.login ? VIEWER.name : s.login),
    email: (s) => (s.login === VIEWER.login ? VIEWER.email : `${String(s.login)}@example.invalid`),
    avatarUrl: () => 'http://forge.local/avatar.png',
    url: (s) => `http://forge.local/${String(s.login)}`,
    createdAt: () => '2025-01-01T00:00:00Z',
    updatedAt: () => '2025-01-01T00:00:00Z',
  },
  Ref: {
    id: (s) => s.id,
    name: (s) => s.name,
    prefix: (s) => s.prefix,
  },
  PageInfo: {
    hasNextPage: (s) => s.hasNextPage,
    hasPreviousPage: (s) => s.hasPreviousPage,
    endCursor: (s) => s.endCursor,
    startCursor: (s) => s.startCursor,
  },
  IssueComment: {
    id: (s) => s.id,
    body: (s) => s.body,
    author: (s) => s.author,
    createdAt: (s) => s.createdAt,
    updatedAt: (s) => s.updatedAt,
  },
  __Type: {
    name: (s) => s.name,
    kind: (s) => s.kind,
    fields: (s) => s.fields,
    enumValues: (s) => s.enumValues,
    description: () => null,
  },
  __Field: { name: (s) => s.name, description: () => null },
  __EnumValue: { name: (s) => s.name, description: () => null },
};

// ---------------------------------------------------------------- execution

function executeSelectionSet(source: Source, selections: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const expanded: FieldNode[] = [];
  const expand = (nodes: SelectionNode[], typeName: string): void => {
    for (const node of nodes) {
      if (node.kind === 'field') expanded.push(node);
      else if (node.kind === 'inline') {
        if (node.typeCondition === typeName) expand(node.selection, typeName);
      } else if (node.kind === 'spread') {
        const frag = ctx.fragments.get(node.name);
        if (frag && frag.typeCondition === typeName) expand(frag.selection, typeName);
      }
    }
  };
  expand(selections, source.__typename);
  for (const field of expanded) {
    const key = field.alias ?? field.name;
    const typeResolvers = resolvers[source.__typename];
    const resolver = typeResolvers?.[field.name];
    if (!resolver) {
      // Plain data carried on the source (connections, payloads, edges) resolves by name.
      if (field.name in source) {
        out[key] = completeValue(source[field.name], field, ctx);
        continue;
      }
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${source.__typename}'` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of field.args) args[argName] = resolveValue(argValue, ctx.vars);
    let value: unknown;
    try {
      value = resolver(source, args, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, field, ctx);
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, field, ctx));
  if (typeof value === 'object') {
    const source = value as Source;
    if (typeof source.__typename === 'string' && field.selection) {
      return executeSelectionSet(source, field.selection, ctx);
    }
    return value;
  }
  return value;
}

export interface GraphQLReply {
  status: number;
  body: unknown;
}

/** Execute one request body (a single operation document or a batch array). */
export function executeGraphQL(store: Store, rawBody: Buffer): GraphQLReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((entry) => runOne(store, entry)) };
  }
  return { status: 200, body: runOne(store, parsed) };
}

function runOne(store: Store, entry: unknown): Record<string, unknown> {
  const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
  const query = String(record.query ?? '');
  const vars = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Record<string, unknown>;
  const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
  let doc: { operations: Operation[]; fragments: Map<string, FragmentDef> };
  try {
    doc = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
  }
  const operation = operationName ? doc.operations.find((op) => op.name === operationName) : doc.operations[0];
  if (!operation) return { errors: [{ message: 'Operation not found' }] };
  const ctx: Ctx = { store, vars, fragments: doc.fragments, errors: [] };
  const root: Source = { __typename: operation.type === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelectionSet(root, operation.selection, ctx);
  const reply: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) reply.errors = ctx.errors;
  return reply;
}
