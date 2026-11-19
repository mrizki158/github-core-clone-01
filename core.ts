// Domain operations shared by the REST, GraphQL and MCP surfaces: line diffs, the 3-way
// merge, pull-request files/merge, and issue/pull/comment creation.
import {
  buildCommit,
  flattenTree,
  mergeBase,
  parseCommit,
  peelToCommit,
  storeTreeFromFiles,
  type ObjectStore,
} from './git.ts';
import { branchRef, nowIso, shortRef, viewerIdent, type CommentRec, type IssueRec, type PullRec, type RepoRec, type Store, VIEWER } from './store.ts';

// ---------------------------------------------------------------- line diffs and 3-way merge

/** LCS-based line diff counts between two texts. */
export function lineDiff(aText: string, bText: string): { additions: number; deletions: number } {
  const a = aText === '' ? [] : aText.split('\n');
  const b = bText === '' ? [] : bText.split('\n');
  if (a.length > 4000 || b.length > 4000) return { additions: b.length, deletions: a.length };
  const dp = new Uint32Array((a.length + 1) * (b.length + 1));
  const W = b.length + 1;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * W + j] = a[i] === b[j] ? (dp[(i + 1) * W + j + 1] as number) + 1 : Math.max(dp[(i + 1) * W + j] as number, dp[i * W + j + 1] as number);
    }
  }
  const lcs = dp[0] as number;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

interface Hunk {
  start: number;
  end: number;
  lines: string[];
}

/** The edit hunks that turn base into other, in base coordinates. */
export function diffHunks(base: string[], other: string[]): Hunk[] {
  const n = base.length;
  const m = other.length;
  const W = m + 1;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * W + j] = base[i] === other[j] ? (dp[(i + 1) * W + j + 1] as number) + 1 : Math.max(dp[(i + 1) * W + j] as number, dp[i * W + j + 1] as number);
    }
  }
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let cur: Hunk | undefined;
  const flush = (): void => {
    if (cur) hunks.push(cur);
    cur = undefined;
  };
  while (i < n || j < m) {
    if (i < n && j < m && base[i] === other[j]) {
      flush();
      i += 1;
      j += 1;
    } else if (j < m && (i >= n || (dp[i * W + j + 1] as number) >= (dp[(i + 1) * W + j] as number))) {
      if (!cur) cur = { start: i, end: i, lines: [] };
      cur.lines.push(other[j] as string);
      j += 1;
    } else {
      if (!cur) cur = { start: i, end: i, lines: [] };
      cur.end = i + 1;
      i += 1;
    }
  }
  flush();
  return hunks;
}

/** A line-based 3-way merge; undefined when the two sides conflict. */
export function merge3(baseText: string, oursText: string, theirsText: string): string | undefined {
  if (oursText === theirsText) return oursText;
  if (oursText === baseText) return theirsText;
  if (theirsText === baseText) return oursText;
  const base = baseText === '' ? [] : baseText.split('\n');
  const oursHunks = diffHunks(base, oursText === '' ? [] : oursText.split('\n'));
  const theirsHunks = diffHunks(base, theirsText === '' ? [] : theirsText.split('\n'));
  const overlaps = (a: Hunk, b: Hunk): boolean => a.start < b.end && b.start < a.end;
  for (const o of oursHunks) {
    for (const t of theirsHunks) {
      if (overlaps(o, t)) {
        const sameChange = o.start === t.start && o.end === t.end && o.lines.join('\n') === t.lines.join('\n');
        if (!sameChange) return undefined;
      }
    }
  }
  const all = [...oursHunks, ...theirsHunks].sort((a, b) => a.start - b.start);
  const out: string[] = [];
  let pos = 0;
  const seen = new Set<string>();
  for (const h of all) {
    const key = `${h.start}:${h.end}:${h.lines.join('\n')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (let k = pos; k < h.start; k += 1) out.push(base[k] as string);
    out.push(...h.lines);
    pos = Math.max(pos, h.end);
  }
  for (let k = pos; k < base.length; k += 1) out.push(base[k] as string);
  return out.join('\n');
}

/** Merge two file maps against their common ancestor's; undefined on a content conflict. */
export function mergeFileMaps(
  objects: ObjectStore,
  base: Map<string, { oid: string; mode: string }>,
  ours: Map<string, { oid: string; mode: string }>,
  theirs: Map<string, { oid: string; mode: string }>,
): Map<string, { oid: string; mode: string }> | undefined {
  const out = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const text = (e: { oid: string } | undefined): string => (e ? (objects.get(e.oid)?.buf.toString('utf8') ?? '') : '');
  for (const p of paths) {
    const b = base.get(p);
    const o = ours.get(p);
    const t = theirs.get(p);
    if (o?.oid === t?.oid) {
      if (o) out.set(p, o);
      continue;
    }
    if (b?.oid === o?.oid) {
      if (t) out.set(p, t);
      continue;
    }
    if (b?.oid === t?.oid) {
      if (o) out.set(p, o);
      continue;
    }
    if (!o || !t) return undefined;
    const merged = merge3(text(b), text(o), text(t));
    if (merged === undefined) return undefined;
    const oid = objects.store('blob', Buffer.from(merged, 'utf8'));
    out.set(p, { oid, mode: o.mode });
  }
  return out;
}

// ---------------------------------------------------------------- git-backed helpers

export type FileMap = Map<string, { oid: string; mode: string }>;

/** The flattened file map of a commit (empty map for an unknown commit). */
export function filesAtCommit(store: Store, commitOid: string | undefined): FileMap {
  const out: FileMap = new Map();
  if (!commitOid) return out;
  const c = store.objects.get(commitOid);
  if (!c || c.type !== 'commit') return out;
  for (const [p, e] of flattenTree(store.objects, parseCommit(c.buf).tree)) out.set(p, { oid: e.oid, mode: e.mode });
  return out;
}

/** Resolve a branch name to its current tip commit within a repo. */
export function branchTip(store: Store, repo: RepoRec, branchName: string): string | undefined {
  const oid = repo.refs.get(branchRef(branchName));
  if (!oid) return undefined;
  return peelToCommit(store.objects, oid) ?? oid;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

/** The changed files of a pull request, base tip against head tip. */
export function pullFilesList(store: Store, repo: RepoRec, pull: PullRec): PullFile[] {
  const baseFiles = filesAtCommit(store, branchTip(store, repo, shortRef(pull.baseRef)) ?? pull.baseSha);
  const headFiles = filesAtCommit(store, branchTip(store, repo, shortRef(pull.headRef)) ?? pull.headSha);
  const out: PullFile[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const p of [...paths].sort()) {
    const b = baseFiles.get(p);
    const h = headFiles.get(p);
    if (b?.oid === h?.oid) continue;
    const bText = b ? (store.objects.get(b.oid)?.buf.toString('utf8') ?? '') : '';
    const hText = h ? (store.objects.get(h.oid)?.buf.toString('utf8') ?? '') : '';
    const { additions, deletions } = lineDiff(bText, hText);
    out.push({
      filename: p,
      status: !b ? 'added' : !h ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: h?.oid ?? b?.oid ?? '',
    });
  }
  return out;
}

/** Whether a pull request merges cleanly against the current base tip. */
export function pullMergeable(store: Store, repo: RepoRec, pull: PullRec): boolean {
  const baseTip = branchTip(store, repo, shortRef(pull.baseRef));
  const headTip = branchTip(store, repo, shortRef(pull.headRef)) ?? pull.headSha;
  if (!baseTip || !headTip) return false;
  const base = mergeBase(store.objects, baseTip, headTip);
  return mergeFileMaps(store.objects, filesAtCommit(store, base), filesAtCommit(store, baseTip), filesAtCommit(store, headTip)) !== undefined;
}

/**
 * Merge a pull request into its base branch. Returns the merge commit's sha, or undefined
 * when the merge conflicts. `method` is 'squash', 'merge' or 'rebase' (rebase lands as a
 * single commit, like squash, which is all the surfaces here can observe).
 */
export function performMerge(store: Store, repo: RepoRec, pull: PullRec, method: string): string | undefined {
  const baseTip = branchTip(store, repo, shortRef(pull.baseRef));
  const headTip = branchTip(store, repo, shortRef(pull.headRef)) ?? pull.headSha;
  if (!baseTip || !headTip) return undefined;
  const base = mergeBase(store.objects, baseTip, headTip);
  const mergedFiles = mergeFileMaps(store.objects, filesAtCommit(store, base), filesAtCommit(store, baseTip), filesAtCommit(store, headTip));
  if (!mergedFiles) return undefined;
  const tree = storeTreeFromFiles(store.objects, mergedFiles);
  const ident = viewerIdent();
  let message: string;
  let parents: string[];
  if (method === 'merge') {
    message = `Merge pull request #${pull.number} from ${shortRef(pull.headRef)}`;
    parents = [baseTip, headTip];
  } else {
    message = `${pull.title} (#${pull.number})`;
    parents = [baseTip];
  }
  const buf = buildCommit({ tree, parents, author: ident, committer: ident, message });
  const sha = store.objects.store('commit', buf);
  repo.refs.set(branchRef(pull.baseRef), sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = nowIso();
  pull.merge_commit_sha = sha;
  pull.baseSha = sha;
  pull.updated_at = nowIso();
  repo.updated_at = nowIso();
  return sha;
}

// ---------------------------------------------------------------- creation

/** Create an issue; the caller has already validated the labels exist. */
export function createIssueRecord(repo: RepoRec, input: { title: string; body: string; labels: string[] }): IssueRec {
  const ts = nowIso();
  const issue: IssueRec = {
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: input.labels,
    comments: [],
    user: VIEWER.login,
    created_at: ts,
    updated_at: ts,
    closed_at: null,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

/** Create a pull request between two existing branches; undefined when either is invalid. */
export function createPullRecord(store: Store, repo: RepoRec, input: { title: string; body: string; head: string; base: string }): PullRec | undefined {
  const headSha = branchTip(store, repo, input.head);
  const baseSha = branchTip(store, repo, input.base);
  if (!headSha || !baseSha || headSha === baseSha) return undefined;
  const ts = nowIso();
  const pull: PullRec = {
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    headRef: branchRef(input.head),
    headSha,
    baseRef: branchRef(input.base),
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
  return pull;
}

/** Add a comment to an issue or pull request; undefined when the number names neither. */
export function addCommentRecord(store: Store, repo: RepoRec, number: number, body: string): CommentRec | undefined {
  const list = store.commentsFor(repo, number);
  if (!list) return undefined;
  const ts = nowIso();
  const comment: CommentRec = { id: store.nextCommentId(), body, user: VIEWER.login, created_at: ts, updated_at: ts };
  list.push(comment);
  return comment;
}

// ---------------------------------------------------------------- JSON shapes (REST view)

export function userJson(login: string): Record<string, unknown> {
  const isViewer = login === VIEWER.login;
  return {
    login,
    id: isViewer ? VIEWER.id : 0,
    type: 'User',
    name: isViewer ? VIEWER.name : login,
    email: isViewer ? VIEWER.email : `${login}@example.invalid`,
  };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
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

export function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const rec = repo.labels.get(name);
  return { name, color: rec?.color ?? 'ededed', default: true, description: null };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
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

export function refJson(repo: RepoRec, refName: string, sha: string): Record<string, unknown> {
  return { ref: shortRef(refName), sha, label: `${repo.owner}:${shortRef(refName)}`, user: userJson(repo.owner), repo: repoJson(repo) };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
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

