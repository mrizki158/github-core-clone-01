// The Model Context Protocol endpoint: streamable HTTP JSON-RPC, both protocol eras —
// the modern `server/discover` revision and the legacy `initialize` handshake — with the
// github-mcp-server tool set over the forge's store.
import { VIEWER, type RepoRec, type Store } from './store.ts';
import { createIssueRecord, createPullRecord, issueJson, performMerge, pullJson, repoJson } from './core.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const CAPABILITIES = { tools: {} };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function tool(name: string, description: string, properties: Record<string, string>, required: string[]): ToolDef {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(properties).map(([k, t]) => [k, { type: t, description: `${name} argument ${k}` }])),
      required,
    },
  };
}

/** The tool list, built once: two tools/list answers must be byte-identical. */
export const TOOLS: ToolDef[] = [
  tool('create_repo', 'Create a new repository for the authenticated user', { name: 'string', description: 'string', private: 'boolean' }, ['name']),
  tool('get_repo', 'Get details of a repository by owner and name', { owner: 'string', repo: 'string' }, ['owner', 'repo']),
  tool('list_repos', 'List the repositories of the authenticated user', {}, []),
  tool('create_issue', 'Create a new issue in a repository', { owner: 'string', repo: 'string', title: 'string', body: 'string' }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List the issues of a repository, optionally filtered by state (open, closed, all)', { owner: 'string', repo: 'string', state: 'string' }, ['owner', 'repo']),
  tool('get_issue', 'Get one issue of a repository by its number', { owner: 'string', repo: 'string', issue_number: 'number' }, ['owner', 'repo', 'issue_number']),
  tool('create_pull_request', 'Create a pull request from a head branch into a base branch', { owner: 'string', repo: 'string', title: 'string', body: 'string', head: 'string', base: 'string' }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request by its number', { owner: 'string', repo: 'string', pull_number: 'number' }, ['owner', 'repo', 'pull_number']),
];

interface RpcReply {
  status: number;
  body?: unknown;
}

function result(id: unknown, value: unknown): RpcReply {
  return { status: 200, body: { jsonrpc: '2.0', id, result: value } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): RpcReply {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function findRepo(store: Store, args: Record<string, unknown>): RepoRec | undefined {
  const owner = String(args.owner ?? '');
  const repo = String(args.repo ?? '');
  if (owner !== VIEWER.login) return undefined;
  return store.getRepo(owner, repo);
}

function callTool(store: Store, name: string, args: Record<string, unknown>): RpcReply | { toolPayload: Record<string, unknown> } {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return rpcError(null, -32602, `Unknown tool: ${name}`);
  for (const required of def.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return rpcError(null, -32602, `Missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (store.getRepo(VIEWER.login, repoName)) return { toolPayload: toolError(`Repository ${repoName} already exists`) };
      const repo = store.createRepo(VIEWER.login, repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      return { toolPayload: toolResult(repoJson(repo)) };
    }
    case 'list_repos': {
      return { toolPayload: toolResult(store.viewerRepos().map(repoJson)) };
    }
    case 'get_repo': {
      const repo = findRepo(store, args);
      if (!repo) return { toolPayload: toolError('Repository not found') };
      return { toolPayload: toolResult(repoJson(repo)) };
    }
    case 'create_issue': {
      const repo = findRepo(store, args);
      if (!repo) return { toolPayload: toolError('Repository not found') };
      const issue = createIssueRecord(repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        labels: [],
      });
      return { toolPayload: toolResult(issueJson(repo, issue)) };
    }
    case 'list_issues': {
      const repo = findRepo(store, args);
      if (!repo) return { toolPayload: toolError('Repository not found') };
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      let items = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') items = items.filter((i) => i.state === state);
      items.sort((a, b) => a.number - b.number);
      return { toolPayload: toolResult(items.map((i) => issueJson(repo, i))) };
    }
    case 'get_issue': {
      const repo = findRepo(store, args);
      if (!repo) return { toolPayload: toolError('Repository not found') };
      const issue = repo.issues.get(Number(args.issue_number));
      if (!issue) return { toolPayload: toolError('Issue not found') };
      return { toolPayload: toolResult(issueJson(repo, issue)) };
    }
    case 'create_pull_request': {
      const repo = findRepo(store, args);
      if (!repo) return { toolPayload: toolError('Repository not found') };
      const head = String(args.head ?? '').split(':').pop() as string;
      const base = String(args.base ?? '') || repo.default_branch;
      const pull = createPullRecord(store, repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        head,
        base,
      });
      if (!pull) return { toolPayload: toolError('Invalid head or base branch') };
      return { toolPayload: toolResult(pullJson(repo, pull)) };
    }
    case 'merge_pull_request': {
      const repo = findRepo(store, args);
      if (!repo) return { toolPayload: toolError('Repository not found') };
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return { toolPayload: toolError('Pull request not found') };
      if (pull.merged) return { toolPayload: toolResult(pullJson(repo, pull)) };
      if (pull.state !== 'open') return { toolPayload: toolError('Pull request is not open') };
      const sha = performMerge(store, repo, pull, 'squash');
      if (!sha) return { toolPayload: toolError('Pull request is not mergeable: conflicts must be resolved first') };
      return { toolPayload: toolResult(pullJson(repo, pull)) };
    }
    default:
      return rpcError(null, -32602, `Unknown tool: ${name}`);
  }
}

/** Handle one JSON-RPC request object; returns undefined for notifications. */
function handleOne(store: Store, entry: unknown): RpcReply | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const record = entry as Record<string, unknown>;
  const method = String(record.method ?? '');
  const id = record.id;
  const isNotification = id === undefined || id === null;
  const params = (typeof record.params === 'object' && record.params !== null ? record.params : {}) as Record<string, unknown>;

  switch (method) {
    case 'server/discover':
      return result(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return result(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25',
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: TOOLS });
    case 'tools/call': {
      const name = String(params.name ?? '');
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const outcome = callTool(store, name, args);
      if ('toolPayload' in outcome) return result(id, outcome.toolPayload);
      // Rebind the error to this request's id.
      const body = outcome.body as { error?: { code: number; message: string } };
      return rpcError(id, body.error?.code ?? -32602, body.error?.message ?? 'Invalid params', outcome.status);
    }
    default:
      if (isNotification) return undefined;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export interface McpReply {
  status: number;
  body?: unknown;
}

/** Handle one HTTP POST to /mcp. */
export function handleMcp(store: Store, rawBody: Buffer): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (Array.isArray(parsed)) {
    const replies: unknown[] = [];
    for (const entry of parsed) {
      const reply = handleOne(store, entry);
      if (reply?.body !== undefined) replies.push(reply.body);
    }
    return { status: 200, body: replies };
  }
  const reply = handleOne(store, parsed);
  if (!reply || reply.body === undefined) return { status: 202 };
  return { status: reply.status, body: reply.body };
}
