// store.ts — the forge's data model: repositories, refs, labels, issues, comments and pull
// requests over the shared git object store (git.ts). The contents API, pull-request merges and
// the git protocol all operate on this one model, so a change made on any surface is visible on
// every other. Server-made commits use a fixed identity and a counter-based timestamp, never
// the wall clock, so a replayed trial derives identical objects.

import {
  ObjectStore,
  buildCommitBytes,
  buildTree,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type TreeEntry,
} from './git.ts';

/** The login the trial's bearer token names (the suite's fixed scenario viewer). */
export const VIEWER_LOGIN = 'adaiversen';
/** The default branch name for every repository this forge creates. */
export const DEFAULT_BRANCH = 'main';
/** Committer identity for commits the forge itself creates (contents API, merges). */
const FORGE_IDENTITY = 'ada iversen <adaiversen@example.invalid>';
/** Fixed epoch the forge's own commit timestamps count up from (deterministic, replay-safe). */
const FORGE_EPOCH_SEC = 1_700_000_000;

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface Repo {
  dbId: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  /** Full ref name (refs/heads/…, refs/tags/…) -> object id. */
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** One shared sequence for issues and pull requests, as on GitHub. */
  nextNumber: number;
  nextCommentId: number;
}

export class Forge {
  readonly objects = new ObjectStore();
  readonly repos = new Map<string, Repo>();
  private repoCounter = 0;
  private commitCounter = 0;

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, input: { description?: string; isPrivate?: boolean }): Repo {
    this.repoCounter += 1;
    const repo: Repo = {
      dbId: this.repoCounter,
      owner,
      name,
      description: input.description ?? '',
      isPrivate: input.isPrivate ?? false,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner);
  }

  /** A deterministic timestamp for the forge's next commit. */
  private nextTimestamp(): number {
    this.commitCounter += 1;
    return FORGE_EPOCH_SEC + this.commitCounter;
  }

  /** Create a commit object in the store and return its id. */
  makeCommit(tree: string, parents: readonly string[], message: string): string {
    const bytes = buildCommitBytes({
      tree,
      parents,
      author: FORGE_IDENTITY,
      committer: FORGE_IDENTITY,
      timestamp: this.nextTimestamp(),
      message,
    });
    return this.objects.put('commit', bytes);
  }

  /** The commit id a ref or ref-ish name resolves to in this repo; null when it does not. */
  resolveCommit(repo: Repo, refOrOid: string): string | null {
    let oid: string | undefined;
    if (/^[0-9a-f]{40}$/.test(refOrOid)) oid = refOrOid;
    else if (refOrOid === 'HEAD') oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    else if (refOrOid.startsWith('refs/')) oid = repo.refs.get(refOrOid);
    else oid = repo.refs.get(`refs/heads/${refOrOid}`) ?? repo.refs.get(`refs/tags/${refOrOid}`);
    if (oid === undefined) return null;
    return peelToCommit(this.objects, oid);
  }

  /** The tree id of a commit; null when the commit is unknown. */
  treeOfCommit(commitOid: string): string | null {
    const object = this.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** Flatten a tree (recursively) into path -> {mode, oid} for blobs. */
  flattenTree(treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
    const object = this.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000' || entry.mode === '040000') this.flattenTree(entry.oid, path, out);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
    return out;
  }

  /** The flattened file map at a ref; empty when the ref does not resolve. */
  filesAtRef(repo: Repo, refOrOid: string): Map<string, { mode: string; oid: string }> {
    const commit = this.resolveCommit(repo, refOrOid);
    if (commit === null) return new Map();
    const tree = this.treeOfCommit(commit);
    if (tree === null) return new Map();
    return this.flattenTree(tree);
  }

  /**
   * Write a flattened file map back into a tree object (nested trees rebuilt bottom-up) and
   * return the root tree id. An empty map yields the empty tree.
   */
  buildTreeFromFiles(files: Map<string, { mode: string; oid: string }>): string {
    interface Dir {
      files: Map<string, { mode: string; oid: string }>;
      dirs: Map<string, Dir>;
    }
    const root: Dir = { files: new Map(), dirs: new Map() };
    for (const [path, file] of files) {
      const parts = path.split('/');
      let dir = root;
      for (const part of parts.slice(0, -1)) {
        let next = dir.dirs.get(part);
        if (next === undefined) {
          next = { files: new Map(), dirs: new Map() };
          dir.dirs.set(part, next);
        }
        dir = next;
      }
      dir.files.set(parts[parts.length - 1] ?? path, file);
    }
    const build = (dir: Dir): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of dir.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
      return this.objects.put('tree', buildTree(entries));
    };
    return build(root);
  }

  /**
   * Commit a file change (or deletion, when content is null) on a branch, creating the branch
   * from the default branch's tip when it does not exist yet, and the repository's first commit
   * when the repository is unborn. Returns the new commit id.
   */
  commitFileChange(repo: Repo, branch: string, path: string, content: Buffer | null, message: string): string {
    const ref = `refs/heads/${branch}`;
    let parent = repo.refs.get(ref);
    if (parent === undefined) parent = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const files = parent === undefined ? new Map<string, { mode: string; oid: string }>() : this.filesAtRef(repo, parent);
    if (content === null) files.delete(path);
    else files.set(path, { mode: '100644', oid: this.objects.put('blob', content) });
    const tree = this.buildTreeFromFiles(files);
    const commit = this.makeCommit(tree, parent === undefined ? [] : [parent], message);
    repo.refs.set(ref, commit);
    return commit;
  }

  /** Ancestors of a commit (including itself), breadth-first; used for histories and merges. */
  ancestorsOf(commitOid: string): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    const queue = [commitOid];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || seen.has(current)) continue;
      seen.add(current);
      order.push(current);
      const object = this.objects.get(current);
      if (object !== undefined && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
    }
    return order;
  }

  isAncestor(maybeAncestor: string, commitOid: string): boolean {
    return this.ancestorsOf(commitOid).includes(maybeAncestor);
  }

  /** The best common ancestor of two commits (first shared commit in breadth order), or null. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsOfB = new Set(this.ancestorsOf(b));
    for (const candidate of this.ancestorsOf(a)) {
      if (ancestorsOfB.has(candidate)) return candidate;
    }
    return null;
  }
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Line counts of a blob's bytes (a final unterminated line still counts as a line). */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (const byte of data) if (byte === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}

/** The file-level diff between two flattened file maps, sorted by path. */
export function diffFiles(
  forge: Forge,
  baseFiles: Map<string, { mode: string; oid: string }>,
  headFiles: Map<string, { mode: string; oid: string }>,
): FileDiff[] {
  const diffs: FileDiff[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base !== undefined && head !== undefined && base.oid === head.oid) continue;
    const baseLines = base === undefined ? 0 : countLines(forge.objects.get(base.oid)?.data ?? Buffer.alloc(0));
    const headLines = head === undefined ? 0 : countLines(forge.objects.get(head.oid)?.data ?? Buffer.alloc(0));
    if (base === undefined) {
      diffs.push({ filename: path, status: 'added', additions: headLines, deletions: 0, changes: headLines });
    } else if (head === undefined) {
      diffs.push({ filename: path, status: 'removed', additions: 0, deletions: baseLines, changes: baseLines });
    } else {
      diffs.push({ filename: path, status: 'modified', additions: headLines, deletions: baseLines, changes: headLines + baseLines });
    }
  }
  return diffs;
}

export interface MergeOutcome {
  ok: boolean;
  /** The squash commit created on the base branch, when ok. */
  commit?: string;
  /** Why the merge conflicts, when not ok. */
  reason?: string;
}

/**
 * Three-way file-level merge: apply the head branch's changes (relative to the merge base) onto
 * the base branch's tip. A path both sides changed differently — including one side deleting
 * what the other modified — conflicts. Shared by the REST and GraphQL merge paths and by the
 * mergeability computation, so all surfaces agree.
 */
export function threeWayMerge(
  forge: Forge,
  baseFiles: Map<string, { mode: string; oid: string }>,
  headFiles: Map<string, { mode: string; oid: string }>,
  ancestorFiles: Map<string, { mode: string; oid: string }>,
): { merged: Map<string, { mode: string; oid: string }> } | { conflict: string } {
  const merged = new Map(baseFiles);
  const paths = new Set([...ancestorFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const ancestor = ancestorFiles.get(path);
    const head = headFiles.get(path);
    const base = baseFiles.get(path);
    const headChanged = (head?.oid ?? null) !== (ancestor?.oid ?? null);
    if (!headChanged) continue;
    const baseChanged = (base?.oid ?? null) !== (ancestor?.oid ?? null);
    if (baseChanged && (base?.oid ?? null) !== (head?.oid ?? null)) {
      return { conflict: `both sides changed ${path} differently` };
    }
    if (head === undefined) merged.delete(path);
    else merged.set(path, head);
  }
  return { merged };
}

/** Whether a pull request (by ref names) can merge cleanly right now. */
export function pullMergeable(forge: Forge, repo: Repo, pull: Pull): boolean {
  const baseCommit = forge.resolveCommit(repo, pull.baseRef);
  const headCommit = forge.resolveCommit(repo, pull.headRef);
  if (baseCommit === null || headCommit === null) return false;
  const base = forge.mergeBase(baseCommit, headCommit);
  const ancestorFiles = base === null ? new Map<string, { mode: string; oid: string }>() : forge.filesAtRef(repo, base);
  const outcome = threeWayMerge(forge, forge.filesAtRef(repo, baseCommit), forge.filesAtRef(repo, headCommit), ancestorFiles);
  return 'merged' in outcome;
}

/** Perform the squash merge of a pull request onto its base branch; conflict -> {ok:false}. */
export function mergePull(forge: Forge, repo: Repo, pull: Pull): MergeOutcome {
  const baseRef = `refs/heads/${pull.baseRef}`;
  const baseCommit = forge.resolveCommit(repo, pull.baseRef);
  const headCommit = forge.resolveCommit(repo, pull.headRef);
  if (baseCommit === null || headCommit === null) return { ok: false, reason: 'a branch does not resolve' };
  const base = forge.mergeBase(baseCommit, headCommit);
  const ancestorFiles = base === null ? new Map<string, { mode: string; oid: string }>() : forge.filesAtRef(repo, base);
  const outcome = threeWayMerge(forge, forge.filesAtRef(repo, baseCommit), forge.filesAtRef(repo, headCommit), ancestorFiles);
  if ('conflict' in outcome) return { ok: false, reason: outcome.conflict };
  const tree = forge.buildTreeFromFiles(outcome.merged);
  const commit = forge.makeCommit(tree, [baseCommit], `${pull.title}\n`);
  repo.refs.set(baseRef, commit);
  return { ok: true, commit };
}

/** Create an issue on a repo (shared by REST, GraphQL and MCP so numbering stays one sequence). */
export function createIssue(repo: Repo, input: { title: string; body: string; labels?: string[] }): Issue {
  const issue: Issue = {
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: input.labels ?? [],
    comments: [],
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

/** Create a pull request on a repo, from the same number sequence as issues. */
export function createPull(repo: Repo, input: { title: string; body: string; headRef: string; baseRef: string }): Pull {
  const pull: Pull = {
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    headRef: input.headRef,
    baseRef: input.baseRef,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** A stable Relay-style global id: base64 of "Type:parts", never the bare database id. */
export function globalId(type: string, ...parts: readonly (string | number)[]): string {
  return Buffer.from(`${type}:${parts.join(':')}`, 'utf8').toString('base64');
}

/** Decode a global id back into its type and parts; null when it is not one of ours. */
export function parseGlobalId(id: string): { type: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { type: text.slice(0, colon), parts: text.slice(colon + 1).split(':') };
  } catch {
    return null;
  }
}

export { parseTag };
