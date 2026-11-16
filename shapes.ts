// shapes.ts — the JSON shapes the REST surface returns, shared with MCP so a tool result and a
// REST response for the same object are the same object (the suite checks parity across them).

import type { Forge, Issue, Pull, Repo } from './store.ts';

/** GET /repos/{owner}/{repo} and friends. */
export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: '2023-11-14T22:13:20Z',
    updated_at: '2023-11-14T22:13:20Z',
    pushed_at: '2023-11-14T22:13:20Z',
  };
}

/** A numeric id for an issue, unique per repository and stable across surfaces. */
export function issueId(repo: Repo, issue: Issue): number {
  return repo.dbId * 1_000_000 + issue.number;
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000' };
    }),
    comments: issue.comments.length,
    created_at: '2023-11-14T22:13:20Z',
    updated_at: '2023-11-14T22:13:20Z',
  };
}

export function commentJson(repo: Repo, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: repo.dbId * 1_000_000 + comment.id,
    body: comment.body,
    created_at: '2023-11-14T22:13:20Z',
    updated_at: '2023-11-14T22:13:20Z',
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = forge.resolveCommit(repo, pull.headRef) ?? '0'.repeat(40);
  const baseSha = forge.resolveCommit(repo, pull.baseRef) ?? '0'.repeat(40);
  return {
    id: repo.dbId * 1_000_000 + pull.number,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: '2023-11-14T22:13:20Z',
    updated_at: '2023-11-14T22:13:20Z',
  };
}

export function labelJson(label: { name: string; color: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, default: false, description: null };
}
