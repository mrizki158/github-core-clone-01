// The forge's in-memory store: repositories with their refs, issues, pull requests, labels and
// comments, over one shared git object database.
import { ObjectStore } from './git.ts';

/** The account the suite's bearer token names (wire.ts's seeded viewer, a suite constant). */
export const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };

/** GitHub's default label set, as a fresh repository carries. */
export const DEFAULT_LABELS: ReadonlyArray<{ name: string; color: string }> = [
  { name: 'bug', color: 'd73a4a' },
  { name: 'documentation', color: '0075ca' },
  { name: 'duplicate', color: 'cfd3d7' },
  { name: 'enhancement', color: 'a2eeef' },
  { name: 'good first issue', color: '7057ff' },
  { name: 'help wanted', color: '008672' },
  { name: 'invalid', color: 'e4e669' },
  { name: 'question', color: 'd876e3' },
  { name: 'wontfix', color: 'ffffff' },
];

export function nowIso(): string {
  return new Date().toISOString();
}

/** A git ident line for commits the API itself authors: "Name <email> ts +0000". */
export function viewerIdent(): string {
  const ts = Math.floor(Date.now() / 1000);
  return `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
}

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
  user: string;
  created_at: string;
  updated_at: string;
}

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  user: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  user: string;
  created_at: string;
  updated_at: string;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  default_branch: string;
  /** Full refname ("refs/heads/main") -> object id. */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
  created_at: string;
  updated_at: string;
}

export class Store {
  readonly objects = new ObjectStore();
  readonly repos = new Map<string, RepoRec>();
  /** Comments left on pull requests through the issue-comment route, keyed repoId:number. */
  readonly pullComments = new Map<string, CommentRec[]>();
  private repoSeq = 0;
  private commentSeq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean; defaultBranch?: string }): RepoRec {
    const ts = nowIso();
    const repo: RepoRec = {
      id: (this.repoSeq += 1),
      owner,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      default_branch: opts.defaultBranch ?? 'main',
      refs: new Map(),
      labels: new Map(DEFAULT_LABELS.map((l) => [l.name, { ...l }])),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      created_at: ts,
      updated_at: ts,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  viewerRepos(): RepoRec[] {
    return [...this.repos.values()].filter((r) => r.owner === VIEWER.login).sort((a, b) => a.id - b.id);
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  /** The comment list for an issue or pull request number (empty when neither exists). */
  commentsFor(repo: RepoRec, number: number): CommentRec[] | undefined {
    const issue = repo.issues.get(number);
    if (issue) return issue.comments;
    if (repo.pulls.has(number)) {
      const key = `${repo.id}:${number}`;
      if (!this.pullComments.has(key)) this.pullComments.set(key, []);
      return this.pullComments.get(key);
    }
    return undefined;
  }
}

/** The branch tip of a repo's ref, or undefined when the ref does not exist. */
export function refTip(repo: RepoRec, ref: string): string | undefined {
  return repo.refs.get(ref);
}

/** Short branch name for a full ref, and the full ref for a branch name. */
export function branchRef(name: string): string {
  return name.startsWith('refs/') ? name : `refs/heads/${name}`;
}

export function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, '');
}
