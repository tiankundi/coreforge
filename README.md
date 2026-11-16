# Forge — a GitHub-compatible git forge in one Node process

A standalone GitHub-compatible forge for the make.fun competition
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01). One Node process, no
database, no git binary, no outside service: repositories, issues, comments, labels and pull
requests live in memory over a from-scratch git object store (SHA-1 objects, trees, commits,
tags, packfiles with delta resolution — implemented on `node:crypto` and `node:zlib` only).

## Surfaces

- **Git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 (capability advertisement,
  `ls-refs`, `fetch` with shallow/deepen and the acknowledgments state machine) and protocol v0
  (advertisement, fetch, `git-receive-pack` with `report-status`, `side-band-64k` and
  `delete-refs`). Fast-forward-only pushes: a non-fast-forward ref is refused per ref with
  `ng <ref> non-fast-forward` while the other refs in the same push still apply. A real git
  client can clone, fetch, deepen, unshallow and push against it.
- **REST v3** under `/api/v3` — repositories (create/list with `Link`-header pagination, get,
  patch, delete), branches and git refs, commits, the contents API (create/update with stale-sha
  409, directory listings, delete), labels (an issue may only carry labels that exist), issues
  and comments, and pull requests with file diffs and three-way squash merges (405 on conflict).
- **GraphQL v4** at `/api/graphql` — `viewer`, `repository`, `node`, issue/pull-request
  connections with cursor pagination and `orderBy`, the `createIssue`, `closeIssue`,
  `createPullRequest`, `mergePullRequest` and `addComment` mutations, batched operation arrays,
  and introspection for the types the API exposes.
- **MCP** at `/mcp` — JSON-RPC 2.0 with `server/discover`, `initialize`, `tools/list` and
  `tools/call` for `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request` and `merge_pull_request`, acting on the same store REST serves.

All four surfaces share one model, so a file written through the contents API is visible to
`git fetch`, a branch pushed over git can host a pull request, and a squash merge lands as a
real commit. Requests carry `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; the token's user owns
every repository, and the same repository name under another owner is a 404, never a 403. Every
reply is JSON with an `X-GitHub-Request-Id` header. Server-made commits use a fixed identity and
counter-based timestamps, never the wall clock, so a replayed trial derives identical state.

## Run it

The harness lifecycle is `main.ts` (kept from the starter): it binds an ephemeral port, POSTs
the port to `$MAKEFUN_ENV_URL/register`, polls `$MAKEFUN_ENV_URL/done`, and exits 0.

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> \
  node --experimental-strip-types main.ts
```

Requires Node 22.18 or later (type stripping). No dependencies to install.

## Layout

- `main.ts` — the entry ↔ env lifecycle (unchanged from the starter).
- `app.ts` — the HTTP server: routing, auth, REST v3, git HTTP wiring, GraphQL/MCP endpoints.
- `store.ts` — the forge model: repositories, refs, issues, pulls, tree editing, merges, diffs.
- `git.ts` — the git object model: hashing, trees/commits/tags, packfile read/write, deltas.
- `gitproto.ts` — pkt-lines, advertisements, ls-refs, fetch planning (shallow/deepen),
  receive-pack with per-ref report-status.
- `graphql.ts` — a small GraphQL parser/executor for the surface above.
- `mcp.ts` — the MCP tools and JSON-RPC handling.
- `shapes.ts` — the JSON object shapes REST and MCP share.
