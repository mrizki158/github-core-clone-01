// The forge's HTTP surface: git smart HTTP, REST v3, GraphQL v4 and MCP in one process over
// the store in store.ts and the object engine in git.ts.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ancestors,
  buildCommit,
  buildPack,
  flattenTree,
  mergeBase,
  parseCommit,
  parsePack,
  parsePkts,
  parseTree,
  peelToCommit,
  pktLine,
  planFetch,
  PKT_DELIM,
  PKT_FLUSH,
  sideband,
  storeTreeFromFiles,
} from './git.ts';
import { branchRef, nowIso, refTip, shortRef, Store, VIEWER, viewerIdent, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import { addCommentRecord, createIssueRecord, performMerge, pullFilesList } from './core.ts';

const store = new Store();
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const JSON_TYPE = 'application/json; charset=utf-8';
let requestSeq = 0;

function requestId(): string {
  requestSeq += 1;
  return `req-${requestSeq.toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId(),
    ...(text ? { 'content-length': Buffer.byteLength(text) } : {}),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function unprocessable(res: ServerResponse, message: string): void {
  sendJson(res, 422, { message });
}

/** The bearer token's validity: missing and wrong are both 401. */
function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  return TOKEN === '' || token === TOKEN;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Parse a JSON request body; on malformed JSON, answer 400 and return undefined. */
function parseJsonBody(res: ServerResponse, raw: Buffer): Record<string, unknown> | undefined {
  if (raw.length === 0) return {};
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return undefined;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------- JSON shapes

function userJson(login: string): Record<string, unknown> {
  const isViewer = login === VIEWER.login;
  return {
    login,
    id: isViewer ? VIEWER.id : 0,
    type: 'User',
    name: isViewer ? VIEWER.name : login,
    email: isViewer ? VIEWER.email : `${login}@example.invalid`,
  };
}

function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    html_url: `http://forge.local/${repo.owner}/${repo.name}`,
    clone_url: `http://forge.local/${repo.owner}/${repo.name}.git`,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    fork: false,
    archived: false,
    disabled: false,
  };
}

function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const rec = repo.labels.get(name);
  return { name, color: rec?.color ?? 'ededed', default: true, description: null };
}

function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(issue.user),
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
  };
}

function refJson(repo: RepoRec, refName: string, sha: string): Record<string, unknown> {
  return { ref: shortRef(refName), sha, label: `${repo.owner}:${shortRef(refName)}`, user: userJson(repo.owner), repo: repoJson(repo) };
}

function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + pull.number,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(pull.user),
    head: refJson(repo, pull.headRef, pull.headSha),
    base: refJson(repo, pull.baseRef, pull.baseSha),
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    draft: false,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.merged ? pull.merged_at : null,
  };
}

function identParts(ident: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(ident);
  if (!match) return { name: ident, email: '', date: new Date(0).toISOString() };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

function commitJson(oid: string): Record<string, unknown> | undefined {
  const obj = store.objects.get(oid);
  if (!obj || obj.type !== 'commit') return undefined;
  const info = parseCommit(obj.buf);
  return {
    sha: oid,
    commit: {
      author: identParts(info.author),
      committer: identParts(info.committer),
      message: info.message,
      tree: { sha: info.tree },
    },
    parents: info.parents.map((p) => ({ sha: p })),
  };
}

// ---------------------------------------------------------------- pagination

interface Page {
  page: number;
  perPage: number;
}

function pageOf(url: URL): Page {
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  return { page, perPage };
}

function paginate<T>(res: ServerResponse, req: IncomingMessage, url: URL, items: T[], page: Page): T[] {
  const totalPages = Math.max(1, Math.ceil(items.length / page.perPage));
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage);
  const host = req.headers.host ?? 'forge.local';
  const base = `http://${host}${url.pathname}`;
  const mk = (p: number): string => {
    const q = new URLSearchParams(url.searchParams);
    q.set('page', String(p));
    q.set('per_page', String(page.perPage));
    return `<${base}?${q.toString()}>`;
  };
  const links: string[] = [];
  if (page.page < totalPages) links.push(`${mk(page.page + 1)}; rel="next"`, `${mk(totalPages)}; rel="last"`);
  if (page.page > 1) links.push(`${mk(page.page - 1)}; rel="prev"`, `${mk(1)}; rel="first"`);
  if (links.length > 0) res.setHeader('link', links.join(', '));
  return slice;
}

// ---------------------------------------------------------------- git-backed repo helpers

/** The flattened file map of a branch tip (empty for an unborn branch). */
function branchFiles(repo: RepoRec, branch: string): Map<string, { oid: string; mode: string }> {
  const tip = refTip(repo, branchRef(branch));
  const out = new Map<string, { oid: string; mode: string }>();
  if (!tip) return out;
  const commit = store.objects.get(tip);
  if (!commit || commit.type !== 'commit') return out;
  const tree = parseCommit(commit.buf).tree;
  for (const [path, e] of flattenTree(store.objects, tree)) out.set(path, { oid: e.oid, mode: e.mode });
  return out;
}

/** Commit a new file map onto a branch; returns the new commit's oid. */
function commitFiles(repo: RepoRec, branch: string, files: Map<string, { oid: string; mode: string }>, message: string): string {
  const tip = refTip(repo, branchRef(branch));
  const tree = storeTreeFromFiles(store.objects, files);
  const ident = viewerIdent();
  const buf = buildCommit({
    tree,
    parents: tip ? [tip] : [],
    author: ident,
    committer: ident,
    message,
  });
  const oid = store.objects.store('commit', buf);
  repo.refs.set(branchRef(branch), oid);
  repo.updated_at = nowIso();
  return oid;
}

/** Resolve a committish: branch name, full ref, tag name or raw oid -> commit oid. */
function resolveCommit(repo: RepoRec, ref: string): string | undefined {
  const candidates = [ref, branchRef(ref), `refs/tags/${ref}`];
  for (const c of candidates) {
    const oid = repo.refs.get(c);
    if (oid) return peelToCommit(store.objects, oid) ?? oid;
  }
  if (/^[0-9a-f]{40}$/.test(ref) && store.objects.has(ref)) return peelToCommit(store.objects, ref) ?? ref;
  return undefined;
}

// ---------------------------------------------------------------- REST: repositories

function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer): void {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/api/v3' || path === '/api/v3/') {
    if (method !== 'GET') return notFound(res);
    return sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_url: '/api/v3/repos/{owner}/{repo}/issues',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org, gist' });
  }
  if (path === '/api/v3/meta') {
    if (method !== 'GET') return notFound(res);
    return sendJson(res, 200, { installed_version: '1.0.0-forge', hooks: [], git: [] });
  }
  if (path === '/api/v3/user') {
    if (method !== 'GET') return notFound(res);
    return sendJson(res, 200, userJson(VIEWER.login));
  }
  if (path === '/api/v3/user/repos') {
    if (method === 'GET') {
      const page = pageOf(url);
      const items = paginate(res, req, url, store.viewerRepos(), page);
      return sendJson(res, 200, items.map(repoJson));
    }
    if (method === 'POST') {
      const body = parseJsonBody(res, raw);
      if (!body) return;
      const name = str(body.name);
      if (name === '') return unprocessable(res, 'Repository creation failed: name is required');
      if (store.getRepo(VIEWER.login, name)) return unprocessable(res, 'Repository creation failed: name already exists on this account');
      const repo = store.createRepo(VIEWER.login, name, {
        description: str(body.description),
        private: body.private === true,
        defaultBranch: str(body.default_branch) || 'main',
      });
      return sendJson(res, 201, repoJson(repo));
    }
    return notFound(res);
  }

  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (!repoMatch) return notFound(res);
  const owner = decodeURIComponent(repoMatch[1] as string);
  const name = decodeURIComponent(repoMatch[2] as string);
  const rest = repoMatch[3] ?? '';
  const repo = owner === VIEWER.login ? store.getRepo(owner, name) : undefined;
  if (!repo) return notFound(res);

  if (rest === '' || rest === '/') {
    if (method === 'GET') return sendJson(res, 200, repoJson(repo));
    if (method === 'PATCH') {
      const body = parseJsonBody(res, raw);
      if (!body) return;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.default_branch = body.default_branch;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        store.repos.delete(store.key(repo.owner, repo.name));
        repo.name = body.name;
        store.repos.set(store.key(repo.owner, repo.name), repo);
      }
      repo.updated_at = nowIso();
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      return sendJson(res, 204, undefined);
    }
    return notFound(res);
  }

  if (rest === '/branches' && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: shortRef(ref), commit: { sha }, protected: false }));
    return sendJson(res, 200, branches);
  }

  if (rest === '/commits' && method === 'GET') {
    const shaParam = url.searchParams.get('sha');
    const tip = shaParam ? resolveCommit(repo, shaParam) : resolveCommit(repo, repo.default_branch);
    if (!tip) return sendJson(res, 200, []);
    const page = pageOf(url);
    const all = ancestors(store.objects, tip).map(commitJson).filter((c) => c !== undefined);
    return sendJson(res, 200, paginate(res, req, url, all as Record<string, unknown>[], page));
  }
  const commitMatch = /^\/commits\/([0-9a-f]{40})$/.exec(rest);
  if (commitMatch && method === 'GET') {
    const json = commitJson(commitMatch[1] as string);
    return json ? sendJson(res, 200, json) : notFound(res);
  }

  if (rest === '/git/refs' && method === 'POST') {
    const body = parseJsonBody(res, raw);
    if (!body) return;
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (!ref.startsWith('refs/')) return unprocessable(res, 'Invalid ref');
    if (repo.refs.has(ref)) return unprocessable(res, 'Reference already exists');
    const target = /^[0-9a-f]{40}$/.test(sha) ? peelToCommit(store.objects, sha) : undefined;
    if (!target) return unprocessable(res, 'Invalid sha');
    repo.refs.set(ref, sha);
    repo.updated_at = nowIso();
    return sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
  }
  const gitRefMatch = /^\/git\/refs\/(.+)$/.exec(rest);
  if (gitRefMatch && method === 'GET') {
    const ref = `refs/${gitRefMatch[1] as string}`;
    const sha = repo.refs.get(ref);
    if (!sha) return notFound(res);
    const obj = store.objects.get(sha);
    return sendJson(res, 200, { ref, object: { sha, type: obj?.type ?? 'commit' } });
  }

  if (rest === '/labels') {
    if (method === 'GET') {
      const labels = [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, default: true, description: null }));
      return sendJson(res, 200, labels);
    }
    if (method === 'POST') {
      const body = parseJsonBody(res, raw);
      if (!body) return;
      const labelName = str(body.name);
      if (labelName === '') return unprocessable(res, 'Label name is required');
      const existing = repo.labels.get(labelName);
      if (existing) return sendJson(res, 201, { name: existing.name, color: existing.color, default: true, description: null });
      const color = str(body.color) || 'ededed';
      repo.labels.set(labelName, { name: labelName, color });
      return sendJson(res, 201, { name: labelName, color, default: true, description: null });
    }
    return notFound(res);
  }

  const contentsMatch = /^\/contents(?:\/(.*))?$/.exec(rest);
  if (contentsMatch) {
    const filePath = decodeURIComponent(contentsMatch[1] ?? '');
    return handleContents(req, res, url, raw, repo, filePath);
  }

  if (rest === '/issues' || rest.startsWith('/issues/')) return handleIssues(req, res, url, raw, repo, rest);
  if (rest === '/pulls' || rest.startsWith('/pulls/')) return handlePulls(req, res, url, raw, repo, rest);

  return notFound(res);
}

// ---------------------------------------------------------------- REST: contents

function handleContents(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer, repo: RepoRec, filePath: string): void {
  const method = req.method ?? 'GET';
  const branchParam = (method === 'GET' ? url.searchParams.get('ref') : null) ?? undefined;

  if (method === 'GET') {
    const branch = branchParam ?? repo.default_branch;
    const files = branchFiles(repo, branch);
    if (filePath !== '') {
      const entry = files.get(filePath);
      if (entry) {
        const blob = store.objects.get(entry.oid);
        const content = blob ? blob.buf : Buffer.alloc(0);
        return sendJson(res, 200, {
          name: filePath.split('/').pop(),
          path: filePath,
          sha: entry.oid,
          size: content.length,
          type: 'file',
          encoding: 'base64',
          content: content.toString('base64').replace(/.{60}/g, '$&\n'),
        });
      }
      const prefix = `${filePath}/`;
      const children = new Map<string, { oid: string; dir: boolean }>();
      for (const [p, e] of files) {
        if (!p.startsWith(prefix)) continue;
        const tail = p.slice(prefix.length);
        const seg = tail.split('/')[0] as string;
        if (tail.includes('/')) {
          if (!children.has(seg)) children.set(seg, { oid: subtreeOid(repo, branch, `${prefix}${seg}`), dir: true });
        } else {
          children.set(seg, { oid: e.oid, dir: false });
        }
      }
      if (children.size > 0) {
        const listing = [...children.entries()].map(([childName, e]) => ({
          name: childName,
          path: `${prefix}${childName}`,
          sha: e.oid,
          size: 0,
          type: e.dir ? 'dir' : 'file',
        }));
        return sendJson(res, 200, listing);
      }
      return notFound(res);
    }
    const listing: Record<string, unknown>[] = [];
    const dirs = new Set<string>();
    for (const [p, e] of files) {
      if (p.includes('/')) {
        const seg = p.split('/')[0] as string;
        if (!dirs.has(seg)) {
          dirs.add(seg);
          listing.push({ name: seg, path: seg, sha: subtreeOid(repo, branch, seg), size: 0, type: 'dir' });
        }
      } else {
        listing.push({ name: p, path: p, sha: e.oid, size: store.objects.get(e.oid)?.buf.length ?? 0, type: 'file' });
      }
    }
    return sendJson(res, 200, listing);
  }

  if (method === 'PUT') {
    const body = parseJsonBody(res, raw);
    if (!body) return;
    if (filePath === '') return unprocessable(res, 'Invalid path');
    const branch = str(body.branch) || repo.default_branch;
    const files = branchFiles(repo, branch);
    const existing = files.get(filePath);
    if (existing) {
      if (body.sha === undefined) return unprocessable(res, 'sha was not supplied');
      if (str(body.sha) !== existing.oid) {
        return sendJson(res, 409, { message: 'Conflict: the file has changed since the sha was read' });
      }
    }
    const content = Buffer.from(str(body.content).replace(/\s/g, ''), 'base64');
    const blobOid = store.objects.store('blob', content);
    files.set(filePath, { oid: blobOid, mode: existing?.mode ?? '100644' });
    const commitSha = commitFiles(repo, branch, files, str(body.message) || 'Update file');
    return sendJson(res, existing ? 200 : 201, {
      content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha },
    });
  }

  if (method === 'DELETE') {
    const body = parseJsonBody(res, raw);
    if (!body) return;
    const branch = str(body.branch) || repo.default_branch;
    const files = branchFiles(repo, branch);
    const existing = files.get(filePath);
    if (!existing) return notFound(res);
    if (body.sha !== undefined && str(body.sha) !== existing.oid) {
      return sendJson(res, 409, { message: 'Conflict: the file has changed since the sha was read' });
    }
    files.delete(filePath);
    const commitSha = commitFiles(repo, branch, files, str(body.message) || 'Delete file');
    return sendJson(res, 200, { content: null, commit: { sha: commitSha } });
  }

  return notFound(res);
}

/** The tree oid of a directory prefix on a branch (for directory listings). */
function subtreeOid(repo: RepoRec, branch: string, prefix: string): string {
  const zero = '0000000000000000000000000000000000000000';
  const tip = refTip(repo, branchRef(branch));
  if (!tip) return zero;
  const commit = store.objects.get(tip);
  if (!commit || commit.type !== 'commit') return zero;
  let tree = parseCommit(commit.buf).tree;
  for (const seg of prefix.split('/')) {
    const obj = store.objects.get(tree);
    if (!obj || obj.type !== 'tree') return zero;
    const entry = parseTree(obj.buf).find((e) => e.name === seg && e.mode === '40000');
    if (!entry) return zero;
    tree = entry.oid;
  }
  return tree;
}

// ---------------------------------------------------------------- REST: issues

function commentJson(c: import('./store.ts').CommentRec): Record<string, unknown> {
  return { id: c.id, body: c.body, user: userJson(c.user), created_at: c.created_at, updated_at: c.updated_at };
}

function handleIssues(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer, repo: RepoRec, rest: string): void {
  const method = req.method ?? 'GET';

  if (rest === '/issues') {
    if (method === 'POST') {
      const body = parseJsonBody(res, raw);
      if (!body) return;
      const labels = Array.isArray(body.labels) ? body.labels.map((l) => str(l)) : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return unprocessable(res, `Label "${label}" does not exist in this repository`);
      }
      const issue = createIssueRecord(repo, { title: str(body.title), body: str(body.body), labels });
      return sendJson(res, 201, issueJson(repo, issue));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let items = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') items = items.filter((i) => i.state === state);
      items.sort((a, b) => a.number - b.number);
      if (direction !== 'asc') items.reverse();
      const page = pageOf(url);
      return sendJson(res, 200, paginate(res, req, url, items, page).map((i) => issueJson(repo, i)));
    }
    return notFound(res);
  }

  const issueMatch = /^\/issues\/(\d+)(\/comments)?$/.exec(rest);
  if (!issueMatch) return notFound(res);
  const num = Number(issueMatch[1]);
  const issue = repo.issues.get(num);
  const isComments = issueMatch[2] === '/comments';

  if (isComments) {
    const list = store.commentsFor(repo, num);
    if (!list) return notFound(res);
    if (method === 'GET') {
      const page = pageOf(url);
      return sendJson(res, 200, paginate(res, req, url, list, page).map(commentJson));
    }
    if (method === 'POST') {
      const body = parseJsonBody(res, raw);
      if (!body) return;
      const comment = addCommentRecord(store, repo, num, str(body.body));
      if (!comment) return notFound(res);
      return sendJson(res, 201, commentJson(comment));
    }
    return notFound(res);
  }

  if (!issue) return notFound(res);
  if (method === 'GET') return sendJson(res, 200, issueJson(repo, issue));
  if (method === 'PATCH') {
    const body = parseJsonBody(res, raw);
    if (!body) return;
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
    if (body.state === 'closed' || body.state === 'open') {
      issue.state = body.state;
      issue.closed_at = body.state === 'closed' ? nowIso() : null;
    }
    if (Array.isArray(body.labels)) {
      const labels = body.labels.map((l) => str(l));
      for (const label of labels) if (!repo.labels.has(label)) return unprocessable(res, `Label "${label}" does not exist in this repository`);
      issue.labels = labels;
    }
    issue.updated_at = nowIso();
    return sendJson(res, 200, issueJson(repo, issue));
  }
  return notFound(res);
}

function handlePulls(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer, repo: RepoRec, rest: string): void {
  const method = req.method ?? 'GET';

  if (rest === '/pulls') {
    if (method === 'POST') {
      const body = parseJsonBody(res, raw);
      if (!body) return;
      const headRaw = str(body.head).split(':').pop() as string;
      const baseRaw = str(body.base) || repo.default_branch;
      const headSha = resolveCommit(repo, headRaw);
      const baseSha = resolveCommit(repo, baseRaw);
      if (!headSha) return unprocessable(res, 'Invalid head');
      if (!baseSha) return unprocessable(res, 'Invalid base');
      if (headSha === baseSha) return unprocessable(res, 'No commits between base and head');
      const ts = nowIso();
      const pull: PullRec = {
        number: repo.nextNumber,
        title: str(body.title),
        body: str(body.body),
        state: 'open',
        headRef: branchRef(headRaw),
        headSha,
        baseRef: branchRef(baseRaw),
        baseSha,
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        user: VIEWER.login,
        created_at: ts,
        updated_at: ts,
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      return sendJson(res, 201, pullJson(repo, pull));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let items = [...repo.pulls.values()];
      if (state === 'open') items = items.filter((p) => p.state === 'open');
      else if (state === 'closed') items = items.filter((p) => p.state === 'closed');
      items.sort((a, b) => a.number - b.number);
      const page = pageOf(url);
      return sendJson(res, 200, paginate(res, req, url, items, page).map((p) => pullJson(repo, p)));
    }
    return notFound(res);
  }

  const pullMatch = /^\/pulls\/(\d+)(\/files|\/merge)?$/.exec(rest);
  if (!pullMatch) return notFound(res);
  const num = Number(pullMatch[1]);
  const pull = repo.pulls.get(num);
  if (!pull) return notFound(res);
  const sub = pullMatch[2] ?? '';

  if (sub === '/files' && method === 'GET') {
    const page = pageOf(url);
    const files = pullFilesList(store, repo, pull).map((f) => ({ ...f }));
    return sendJson(res, 200, paginate(res, req, url, files, page));
  }

  if (sub === '/merge' && method === 'PUT') {
    const body = parseJsonBody(res, raw);
    if (!body) return;
    if (pull.merged || pull.state !== 'open') {
      return sendJson(res, 405, { message: 'Pull Request is not mergeable' });
    }
    const mergeMethod = str(body.merge_method) || 'merge';
    const sha = performMerge(store, repo, pull, mergeMethod);
    if (!sha) {
      return sendJson(res, 405, { message: 'Pull Request is not mergeable: conflicts must be resolved first' });
    }
    return sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
  }

  if (sub === '' && method === 'GET') {
    // Refresh the tips the way GitHub reports them: the branches' current heads.
    const headTip = resolveCommit(repo, pull.headRef);
    const baseTip = resolveCommit(repo, pull.baseRef);
    const view: PullRec = {
      ...pull,
      headSha: pull.merged ? pull.headSha : (headTip ?? pull.headSha),
      baseSha: pull.merged ? pull.baseSha : (baseTip ?? pull.baseSha),
    };
    return sendJson(res, 200, pullJson(repo, view));
  }
  if (sub === '' && method === 'PATCH') {
    const body = parseJsonBody(res, raw);
    if (!body) return;
    if (typeof body.title === 'string') pull.title = body.title;
    if (typeof body.body === 'string') pull.body = body.body;
    if (body.state === 'closed' || body.state === 'open') pull.state = body.state;
    pull.updated_at = nowIso();
    return sendJson(res, 200, pullJson(repo, pull));
  }
  return notFound(res);
}

// ---------------------------------------------------------------- the server

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const raw = await readBody(req);

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          handleRest(req, res, url, raw);
          return;
        }
        if (path === '/api/graphql') {
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          handleGraphql(req, res, raw);
          return;
        }
        if (path === '/mcp' || path.startsWith('/mcp/')) {
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          handleMcp(req, res, raw);
          return;
        }
        if (/^\/[^/]+\/[^/]+\.git(\/.*)?$/.test(path)) {
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          await handleGitHttp(req, res, url, raw);
          return;
        }
        notFound(res);
      } catch (err) {
        process.stderr.write(`[forge] ${req.method} ${req.url}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}

// ---------------------------------------------------------------- surfaces still being built

function handleGraphql(_req: IncomingMessage, res: ServerResponse, _raw: Buffer): void {
  sendJson(res, 200, { data: {} });
}

function handleMcp(_req: IncomingMessage, res: ServerResponse, _raw: Buffer): void {
  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------- git smart HTTP

const ZERO_OID = '0000000000000000000000000000000000000000';
const AGENT = 'forge/1.0';

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** HEAD plus every ref, in advertisement order (HEAD first, then refs sorted by name). */
function allRefLines(repo: RepoRec): RefLine[] {
  const lines: RefLine[] = [];
  const headRef = branchRef(repo.default_branch);
  const headOid = repo.refs.get(headRef);
  lines.push({ oid: headOid ?? ZERO_OID, name: 'HEAD' });
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    const obj = store.objects.get(oid);
    if (obj?.type === 'tag') {
      const target = peelToCommit(store.objects, oid);
      if (target && target !== oid) line.peeled = target;
    }
    lines.push(line);
  }
  return lines;
}

function uploadCaps(repo: RepoRec): string {
  return `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=${AGENT} symref=HEAD:${branchRef(repo.default_branch)}`;
}

function receiveCaps(repo: RepoRec): string {
  return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:${branchRef(repo.default_branch)}`;
}

function v0Advertisement(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? uploadCaps(repo) : receiveCaps(repo);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const lines = allRefLines(repo);
  const hasRealRefs = repo.refs.size > 0;
  if (!hasRealRefs) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    lines.forEach((line, index) => {
      const capsSuffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${line.oid} ${line.name}${capsSuffix}\n`));
      if (line.peeled) parts.push(pktLine(`${line.peeled} ${line.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(repo: RepoRec): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('server-option\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, url: URL, repo: RepoRec): void {
  const service = url.searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return notFound(res);
  const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (service === 'git-upload-pack' && wantsV2) {
    return sendRaw(res, 200, v2Advertisement(repo), 'application/x-git-upload-pack-advertisement');
  }
  const body = v0Advertisement(repo, service);
  return sendRaw(res, 200, body, `application/x-${service}-advertisement`);
}

/** One ls-refs / fetch / receive request, already pkt-parsed. */
function pktTexts(raw: Buffer): { texts: string[]; kinds: string[]; rest: Buffer } {
  const { pkts, rest } = parsePkts(raw);
  return {
    texts: pkts.map((p) => (p.kind === 'data' ? p.data.toString('utf8') : '')),
    kinds: pkts.map((p) => p.kind),
    rest,
  };
}

/** Split a v2 command request into its argument sections (before/after the delim). */
function v2Sections(raw: Buffer): { head: string[]; args: string[] } {
  const { pkts } = parsePkts(raw);
  const head: string[] = [];
  const args: string[] = [];
  let inArgs = false;
  for (const p of pkts) {
    if (p.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    const text = p.data.toString('utf8').replace(/\n$/, '');
    if (inArgs) args.push(text);
    else head.push(text);
  }
  return { head, args };
}

function handleLsRefs(res: ServerResponse, repo: RepoRec, raw: Buffer): void {
  const { args } = v2Sections(raw);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const headRef = branchRef(repo.default_branch);
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else {
      parts.push(pktLine(`${ZERO_OID} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let suffix = '';
    if (peel) {
      const obj = store.objects.get(oid);
      if (obj?.type === 'tag') {
        const target = peelToCommit(store.objects, oid);
        if (target && target !== oid) suffix = ` peeled:${target}`;
      }
    }
    parts.push(pktLine(`${oid} ${name}${suffix}\n`));
  }
  parts.push(PKT_FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

async function handleFetch(res: ServerResponse, repo: RepoRec, raw: Buffer, version2: boolean): Promise<void> {
  if (!version2) return handleFetchV0(res, repo, raw);
  const { args } = v2Sections(raw);
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  const deepenNot: string[] = [];
  let deepen: number | undefined;
  let deepenSince: number | undefined;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen-not ')) deepenNot.push(arg.slice(11).trim());
    else if (arg.startsWith('deepen-since ')) deepenSince = Number(arg.slice(13).trim());
    else if (arg.startsWith('deepen ')) deepen = Number(arg.slice(7).trim());
    else if (arg === 'done') done = true;
  }
  for (const w of wants) {
    if (!store.objects.has(w)) {
      sendJson(res, 500, { message: `want ${w} not found` });
      return;
    }
  }
  if (!done) {
    const parts: Buffer[] = [pktLine('acknowledgments\n')];
    const acks = haves.filter((h) => store.objects.has(h));
    if (acks.length === 0) parts.push(pktLine('NAK\n'));
    else {
      for (const a of acks) parts.push(pktLine(`ACK ${a}\n`));
      parts.push(pktLine('ready\n'));
    }
    parts.push(PKT_DELIM, PKT_FLUSH);
    return sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
  }
  const plan = planFetch(store.objects, wants, haves, {
    maxDepth: deepen,
    sinceTs: deepenSince,
    exclude: deepenNot,
    clientShallow: new Set(clientShallow),
  });
  const parts: Buffer[] = [];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sideband(buildPack(store.objects, plan.objects)));
  return sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleFetchV0(res: ServerResponse, repo: RepoRec, raw: Buffer): void {
  const { texts } = pktTexts(raw);
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  const deepenNot: string[] = [];
  let deepen: number | undefined;
  let deepenSince: number | undefined;
  for (const rawLine of texts) {
    const line = rawLine.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0] as string);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen-not ')) deepenNot.push(line.slice(11).trim());
    else if (line.startsWith('deepen-since ')) deepenSince = Number(line.slice(13).trim());
    else if (line.startsWith('deepen ')) deepen = Number(line.slice(7).trim());
  }
  const plan = planFetch(store.objects, wants, haves, {
    maxDepth: deepen,
    sinceTs: deepenSince,
    exclude: deepenNot,
    clientShallow: new Set(clientShallow),
  });
  const parts: Buffer[] = [];
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(sideband(buildPack(store.objects, plan.objects)));
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

async function handleReceivePack(res: ServerResponse, repo: RepoRec, raw: Buffer): Promise<void> {
  const { pkts, rest } = parsePkts(raw);
  interface Cmd {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Cmd[] = [];
  let caps = '';
  for (const p of pkts) {
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    let text = p.data.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      caps = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const fields = text.split(' ');
    if (fields.length === 3) commands.push({ oldOid: fields[0] as string, newOid: fields[1] as string, ref: fields[2] as string });
  }
  const useSideband = caps.split(' ').includes('side-band-64k');
  const wantReport = caps.split(' ').includes('report-status') || caps.split(' ').includes('report-status-v2');

  let unpackLine = 'unpack ok\n';
  if (rest.length > 0) {
    try {
      parsePack(store.objects, rest);
    } catch (err) {
      unpackLine = `unpack ${err instanceof Error ? err.message : 'error'}\n`;
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackLine === 'unpack ok\n') {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
      const fail = (reason: string): void => {
        results.push({ ref: cmd.ref, ok: false, reason });
      };
      const pass = (): void => {
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      };
      if (cmd.oldOid !== current) {
        fail('stale info');
        continue;
      }
      if (cmd.newOid === ZERO_OID) {
        if (current === ZERO_OID) {
          fail('does not exist');
          continue;
        }
        repo.refs.delete(cmd.ref);
        pass();
        continue;
      }
      const newObj = store.objects.get(cmd.newOid);
      if (!newObj) {
        fail('bad object');
        continue;
      }
      if (cmd.ref.startsWith('refs/tags/')) {
        if (current !== ZERO_OID && current !== cmd.newOid) {
          fail('already exists');
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        pass();
        continue;
      }
      const newCommit = peelToCommit(store.objects, cmd.newOid);
      if (!newCommit) {
        fail('bad object');
        continue;
      }
      if (current !== ZERO_OID) {
        const currentCommit = peelToCommit(store.objects, current);
        if (!currentCommit || !ancestors(store.objects, newCommit).includes(currentCommit)) {
          fail('non-fast-forward');
          continue;
        }
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      pass();
    }
    repo.updated_at = nowIso();
  } else {
    for (const cmd of commands) results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
  }

  if (!wantReport) {
    return sendRaw(res, 200, Buffer.alloc(0), 'application/x-git-receive-pack-result');
  }
  const reportParts: Buffer[] = [pktLine(unpackLine)];
  for (const r of results) reportParts.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  if (useSideband) {
    const parts: Buffer[] = [];
    const CHUNK = 65519 - 5;
    for (let i = 0; i < report.length; i += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(i, Math.min(report.length, i + CHUNK))])));
    }
    parts.push(PKT_FLUSH);
    return sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
  }
  return sendRaw(res, 200, report, 'application/x-git-receive-pack-result');
}

async function handleGitHttp(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer): Promise<void> {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(url.pathname);
  if (!match) return notFound(res);
  const owner = decodeURIComponent(match[1] as string);
  const name = decodeURIComponent(match[2] as string);
  const rest = match[3] ?? '';
  const repo = owner === VIEWER.login ? store.getRepo(owner, name) : undefined;
  if (!repo) return notFound(res);

  if (rest === '/info/refs' && (req.method ?? 'GET') === 'GET') return handleInfoRefs(req, res, url, repo);
  if (rest === '/git-upload-pack' && (req.method ?? 'GET') === 'POST') {
    const version2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    // A v2 command request names its command in the first section.
    const { head } = v2Sections(raw);
    const command = head.find((l) => l.startsWith('command='));
    if (version2 && command === 'command=ls-refs') return handleLsRefs(res, repo, raw);
    if (version2 && command === 'command=fetch') return handleFetch(res, repo, raw, true);
    if (!version2) return handleFetch(res, repo, raw, false);
    return sendJson(res, 400, { message: 'Unknown command' });
  }
  if (rest === '/git-receive-pack' && (req.method ?? 'GET') === 'POST') return handleReceivePack(res, repo, raw);
  return notFound(res);
}
