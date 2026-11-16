// app.ts — the forge's HTTP surface: REST v3 under /api/v3, git smart HTTP at
// /{owner}/{repo}.git, GraphQL at /api/graphql and MCP at /mcp, all over the one forge model
// (store.ts). Every reply is JSON (never HTML) with a non-empty X-GitHub-Request-Id header;
// errors are JSON with a string message; an unknown route is a JSON 404; a request without the
// trial's bearer token is a 401.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { parseTree } from './git.ts';
import {
  Forge,
  type Repo,
  VIEWER_LOGIN,
  createIssue,
  createPull,
  diffFiles,
  mergePull,
} from './store.ts';
import {
  advertiseV0,
  advertiseV2,
  handleFetchV0,
  handleFetchV2,
  handleLsRefs,
  handleReceivePack,
  parsePktLines,
  splitPktAndPack,
  wrapReport,
} from './gitproto.ts';
import { executeGraphQL, type GraphQLRequest } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { commentJson, issueJson, labelJson, pullJson, repoJson } from './shapes.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const INSTALLED_VERSION = 'forge-1.0.0';
/** The fixed timestamp merges carry (deterministic across a trial and its replay). */
const MERGED_AT = '2023-11-14T22:13:20Z';

const forge = new Forge();
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}-${((requestCounter * 2654435761) % 0xffffffff).toString(16)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    'cache-control': 'no-cache, max-age=0, must-revalidate',
    expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
    pragma: 'no-cache',
  });
  res.end(body);
}

function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON request body; {} for an empty body, null (after answering 400) for malformed. */
function parseJsonBody(res: ServerResponse, raw: Buffer): Record<string, unknown> | null {
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return null;
  }
}

function authed(req: IncomingMessage): boolean {
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

// ---------------------------------------------------------------- pagination

interface Page<T> {
  items: T[];
  link?: string;
}

function paginate<T>(req: IncomingMessage, url: URL, all: readonly T[]): Page<T> {
  const perPageRaw = Number.parseInt(url.searchParams.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, perPageRaw) : 30;
  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  let link: string | undefined;
  if (start + items.length < all.length) {
    const origin = `http://${req.headers.host ?? 'localhost'}`;
    const lastPage = Math.max(1, Math.ceil(all.length / perPage));
    const build = (target: number): string => {
      const params = new URLSearchParams(url.searchParams);
      params.set('per_page', String(perPage));
      params.set('page', String(target));
      return `<${origin}${url.pathname}?${params.toString()}>`;
    };
    link = `${build(page + 1)}; rel="next", ${build(lastPage)}; rel="last"`;
  }
  return { items, link };
}

// ---------------------------------------------------------------- REST helpers

function repoOr404(res: ServerResponse, owner: string, name: string): Repo | null {
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) {
    notFound(res);
    return null;
  }
  return repo;
}

/** Walk the tree at a ref to the entry for `path` (file, directory, or missing). */
function treeEntryAt(repo: Repo, ref: string, path: string):
  | { kind: 'file'; oid: string; size: number }
  | { kind: 'dir'; oid: string; entries: Array<{ mode: string; name: string; oid: string }> }
  | null {
  const commit = forge.resolveCommit(repo, ref);
  if (commit === null) return null;
  const rootTree = forge.treeOfCommit(commit);
  if (rootTree === null) return null;
  if (path === '') {
    const object = forge.objects.get(rootTree);
    if (object === undefined) return null;
    return { kind: 'dir', oid: rootTree, entries: parseTree(object.data) };
  }
  const parts = path.split('/');
  let treeOid = rootTree;
  for (let index = 0; index < parts.length; index += 1) {
    const object = forge.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === parts[index]);
    if (entry === undefined) return null;
    if (index === parts.length - 1) {
      if (entry.mode === '40000' || entry.mode === '040000') {
        const dirObject = forge.objects.get(entry.oid);
        if (dirObject === undefined) return null;
        return { kind: 'dir', oid: entry.oid, entries: parseTree(dirObject.data) };
      }
      const blob = forge.objects.get(entry.oid);
      return { kind: 'file', oid: entry.oid, size: blob?.data.length ?? 0 };
    }
    if (entry.mode !== '40000' && entry.mode !== '040000') return null;
    treeOid = entry.oid;
  }
  return null;
}

function base64Wrap(data: Buffer): string {
  const encoded = data.toString('base64');
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += 60) lines.push(encoded.slice(index, index + 60));
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- REST routes

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, rawBody: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const rest = url.pathname.slice('/api/v3'.length).replace(/^\//, '');
  const segments = rest === '' ? [] : rest.split('/').map((segment) => decodeURIComponent(segment));

  // Root and meta.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound(res);
    return sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return notFound(res);
    return sendJson(res, 200, { installed_version: INSTALLED_VERSION, hook_id: 0, git_url: 'git://forge.invalid/' });
  }
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return notFound(res);
    return sendJson(res, 200, { login: VIEWER_LOGIN, id: 1000, type: 'User', site_admin: false });
  }

  // The viewer's repositories.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const { items, link } = paginate(req, url, forge.listRepos(VIEWER_LOGIN));
      return sendJson(res, 200, items.map(repoJson), link !== undefined ? { link } : {});
    }
    if (method === 'POST') {
      const body = parseJsonBody(res, rawBody);
      if (body === null) return;
      const name = typeof body['name'] === 'string' ? body['name'] : '';
      if (name === '') return sendJson(res, 422, { message: 'Repository creation failed: name is required' });
      if (forge.getRepo(VIEWER_LOGIN, name) !== undefined) {
        return sendJson(res, 422, { message: 'Repository creation failed: name already exists on this account' });
      }
      const repo = forge.createRepo(VIEWER_LOGIN, name, {
        description: typeof body['description'] === 'string' ? body['description'] : '',
        isPrivate: typeof body['private'] === 'boolean' ? body['private'] : false,
      });
      return sendJson(res, 201, repoJson(repo));
    }
    return notFound(res);
  }

  if (segments[0] !== 'repos' || segments.length < 3) return notFound(res);
  const owner = segments[1] as string;
  const repoName = segments[2] as string;
  const tail = segments.slice(3);

  // The repository itself.
  if (tail.length === 0) {
    const repo = repoOr404(res, owner, repoName);
    if (repo === null) return;
    if (method === 'GET') return sendJson(res, 200, repoJson(repo));
    if (method === 'PATCH') {
      const body = parseJsonBody(res, rawBody);
      if (body === null) return;
      if (typeof body['description'] === 'string') repo.description = body['description'];
      if (typeof body['private'] === 'boolean') repo.isPrivate = body['private'];
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, repoName);
      return sendJson(res, 204, undefined);
    }
    return notFound(res);
  }

  const repo = repoOr404(res, owner, repoName);
  if (repo === null) return;

  // Branches and refs.
  if (tail[0] === 'branches' && tail.length === 1 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
    return sendJson(res, 200, branches);
  }
  if (tail[0] === 'branches' && tail.length >= 2 && method === 'GET') {
    const branch = tail.slice(1).join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) return notFound(res);
    return sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
  }
  if (tail[0] === 'git' && tail[1] === 'refs' && tail.length === 2 && method === 'POST') {
    const body = parseJsonBody(res, rawBody);
    if (body === null) return;
    const ref = typeof body['ref'] === 'string' ? body['ref'] : '';
    const sha = typeof body['sha'] === 'string' ? body['sha'] : '';
    const object = forge.objects.get(sha);
    if (ref === '' || object === undefined) return sendJson(res, 422, { message: 'Reference could not be created' });
    repo.refs.set(ref, sha);
    return sendJson(res, 201, { ref, object: { sha, type: object.type } });
  }
  if (tail[0] === 'git' && tail[1] === 'refs' && tail.length >= 3 && method === 'GET') {
    const ref = `refs/${tail.slice(2).join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) return notFound(res);
    const object = forge.objects.get(sha);
    return sendJson(res, 200, { ref, object: { sha, type: object?.type ?? 'commit' } });
  }

  // Commits.
  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
    const ref = url.searchParams.get('sha') ?? repo.defaultBranch;
    const tip = forge.resolveCommit(repo, ref);
    if (tip === null) return sendJson(res, 200, []);
    const commits = forge.ancestorsOf(tip).map((sha) => {
      const object = forge.objects.get(sha);
      let message = '';
      if (object !== undefined && object.type === 'commit') {
        const blank = object.data.indexOf('\n\n');
        message = blank < 0 ? '' : object.data.subarray(blank + 2).toString('utf8');
      }
      return { sha, commit: { message } };
    });
    return sendJson(res, 200, commits);
  }

  // Contents.
  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') {
      const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
      const found = treeEntryAt(repo, ref, path);
      if (found === null) return notFound(res);
      if (found.kind === 'file') {
        const blob = forge.objects.get(found.oid);
        const data = blob?.data ?? Buffer.alloc(0);
        return sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          name: path.split('/').pop() ?? path,
          path,
          sha: found.oid,
          size: data.length,
          content: base64Wrap(data),
        });
      }
      const listing = found.entries.map((entry) => {
        const isDir = entry.mode === '40000' || entry.mode === '040000';
        const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
        const blob = forge.objects.get(entry.oid);
        return {
          type: isDir ? 'dir' : 'file',
          name: entry.name,
          path: childPath,
          sha: entry.oid,
          size: isDir ? 0 : (blob?.data.length ?? 0),
        };
      });
      return sendJson(res, 200, listing);
    }
    if (method === 'PUT') {
      const body = parseJsonBody(res, rawBody);
      if (body === null) return;
      const branch = typeof body['branch'] === 'string' ? body['branch'] : repo.defaultBranch;
      const message = typeof body['message'] === 'string' ? body['message'] : 'update';
      const content = typeof body['content'] === 'string' ? Buffer.from(body['content'], 'base64') : Buffer.alloc(0);
      const existing = treeEntryAt(repo, branch, path);
      const existingSha = existing !== null && existing.kind === 'file' ? existing.oid : null;
      if (typeof body['sha'] === 'string' && body['sha'] !== existingSha) {
        return sendJson(res, 409, { message: 'Conflict: the sha does not match the current content' });
      }
      const commit = forge.commitFileChange(repo, branch, path, content, message);
      const blobSha = forge.objects.put('blob', content);
      return sendJson(res, existingSha === null ? 201 : 200, {
        content: {
          type: 'file',
          name: path.split('/').pop() ?? path,
          path,
          sha: blobSha,
          size: content.length,
          encoding: 'base64',
        },
        commit: { sha: commit },
      });
    }
    if (method === 'DELETE') {
      const body = parseJsonBody(res, rawBody);
      if (body === null) return;
      const branch = typeof body['branch'] === 'string' ? body['branch'] : repo.defaultBranch;
      const message = typeof body['message'] === 'string' ? body['message'] : 'delete';
      const existing = treeEntryAt(repo, branch, path);
      if (existing === null || existing.kind !== 'file') return notFound(res);
      if (typeof body['sha'] === 'string' && body['sha'] !== existing.oid) {
        return sendJson(res, 409, { message: 'Conflict: the sha does not match the current content' });
      }
      const commit = forge.commitFileChange(repo, branch, path, null, message);
      return sendJson(res, 200, { content: null, commit: { sha: commit } });
    }
    return notFound(res);
  }

  // Labels.
  if (tail[0] === 'labels' && tail.length === 1 && method === 'POST') {
    const body = parseJsonBody(res, rawBody);
    if (body === null) return;
    const name = typeof body['name'] === 'string' ? body['name'] : '';
    if (name === '') return sendJson(res, 422, { message: 'Validation failed: name is required' });
    if (repo.labels.has(name)) return sendJson(res, 422, { message: 'Validation failed: label already exists' });
    const color = typeof body['color'] === 'string' ? body['color'].replace(/^#/, '') : '000000';
    const label = { name, color };
    repo.labels.set(name, label);
    return sendJson(res, 201, labelJson(label));
  }
  if (tail[0] === 'labels' && tail.length === 1 && method === 'GET') {
    return sendJson(res, 200, [...repo.labels.values()].map(labelJson));
  }

  // Issues and their comments.
  if (tail[0] === 'issues' && tail.length === 1) {
    if (method === 'POST') {
      const body = parseJsonBody(res, rawBody);
      if (body === null) return;
      const labelNames: string[] = [];
      if (Array.isArray(body['labels'])) {
        for (const label of body['labels'] as unknown[]) {
          if (typeof label === 'string') labelNames.push(label);
          else if (typeof label === 'object' && label !== null && typeof (label as { name?: unknown }).name === 'string') {
            labelNames.push((label as { name: string }).name);
          }
        }
      }
      for (const name of labelNames) {
        if (!repo.labels.has(name)) return sendJson(res, 422, { message: `Validation failed: label '${name}' does not exist` });
      }
      const issue = createIssue(repo, {
        title: typeof body['title'] === 'string' ? body['title'] : '',
        body: typeof body['body'] === 'string' ? body['body'] : '',
        labels: labelNames,
      });
      return sendJson(res, 201, issueJson(repo, issue));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      const direction = url.searchParams.get('direction') ?? (url.searchParams.get('sort') !== null ? 'desc' : 'asc');
      issues.sort((a, b) => (direction === 'desc' ? b.number - a.number : a.number - b.number));
      const { items, link } = paginate(req, url, issues);
      return sendJson(res, 200, items.map((issue) => issueJson(repo, issue)), link !== undefined ? { link } : {});
    }
    return notFound(res);
  }
  if (tail[0] === 'issues' && tail.length >= 2) {
    const number = Number.parseInt(tail[1] as string, 10);
    const issue = repo.issues.get(number);
    if (tail.length === 2) {
      if (issue === undefined) return notFound(res);
      if (method === 'GET') return sendJson(res, 200, issueJson(repo, issue));
      if (method === 'PATCH') {
        const body = parseJsonBody(res, rawBody);
        if (body === null) return;
        if (body['state'] === 'closed' || body['state'] === 'open') issue.state = body['state'];
        if (typeof body['title'] === 'string') issue.title = body['title'];
        if (typeof body['body'] === 'string') issue.body = body['body'];
        return sendJson(res, 200, issueJson(repo, issue));
      }
      return notFound(res);
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (issue === undefined) return notFound(res);
      if (method === 'POST') {
        const body = parseJsonBody(res, rawBody);
        if (body === null) return;
        const comment = { id: repo.nextCommentId, body: typeof body['body'] === 'string' ? body['body'] : '' };
        repo.nextCommentId += 1;
        issue.comments.push(comment);
        return sendJson(res, 201, commentJson(repo, comment));
      }
      if (method === 'GET') return sendJson(res, 200, issue.comments.map((comment) => commentJson(repo, comment)));
      return notFound(res);
    }
    return notFound(res);
  }

  // Pull requests.
  if (tail[0] === 'pulls' && tail.length === 1) {
    if (method === 'POST') {
      const body = parseJsonBody(res, rawBody);
      if (body === null) return;
      const stripOwner = (ref: string): string => (ref.includes(':') ? (ref.split(':').pop() as string) : ref);
      const head = stripOwner(typeof body['head'] === 'string' ? body['head'] : '');
      const base = stripOwner(typeof body['base'] === 'string' ? body['base'] : repo.defaultBranch);
      if (repo.refs.get(`refs/heads/${head}`) === undefined) {
        return sendJson(res, 422, { message: `Validation failed: head branch '${head}' does not exist` });
      }
      if (repo.refs.get(`refs/heads/${base}`) === undefined) {
        return sendJson(res, 422, { message: `Validation failed: base branch '${base}' does not exist` });
      }
      if (head === base) return sendJson(res, 422, { message: 'Validation failed: head and base are the same' });
      const pull = createPull(repo, {
        title: typeof body['title'] === 'string' ? body['title'] : '',
        body: typeof body['body'] === 'string' ? body['body'] : '',
        headRef: head,
        baseRef: base,
      });
      return sendJson(res, 201, pullJson(forge, repo, pull));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open' && !pull.merged);
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed' || pull.merged);
      pulls.sort((a, b) => a.number - b.number);
      return sendJson(res, 200, pulls.map((pull) => pullJson(forge, repo, pull)));
    }
    return notFound(res);
  }
  if (tail[0] === 'pulls' && tail.length >= 2) {
    const number = Number.parseInt(tail[1] as string, 10);
    const pull = repo.pulls.get(number);
    if (tail.length === 2 && method === 'GET') {
      if (pull === undefined) return notFound(res);
      return sendJson(res, 200, pullJson(forge, repo, pull));
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      if (pull === undefined) return notFound(res);
      const baseFiles = forge.filesAtRef(repo, pull.baseRef);
      const headFiles = forge.filesAtRef(repo, pull.headRef);
      const files = diffFiles(forge, baseFiles, headFiles).map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      }));
      return sendJson(res, 200, files);
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      if (pull === undefined) return notFound(res);
      const body = parseJsonBody(res, rawBody);
      if (body === null) return;
      if (pull.merged) return sendJson(res, 405, { message: 'Pull request has already been merged' });
      const outcome = mergePull(forge, repo, pull);
      if (!outcome.ok || outcome.commit === undefined) {
        return sendJson(res, 405, { message: `Merge conflict: ${outcome.reason ?? 'the pull request is not mergeable'}` });
      }
      pull.merged = true;
      pull.state = 'closed';
      pull.mergeCommitSha = outcome.commit;
      pull.mergedAt = MERGED_AT;
      return sendJson(res, 200, { sha: outcome.commit, merged: true, message: 'Pull Request successfully merged' });
    }
    return notFound(res);
  }

  return notFound(res);
}

// ---------------------------------------------------------------- git smart HTTP

function handleGit(req: IncomingMessage, res: ServerResponse, url: URL, rawBody: Buffer, owner: string, repoName: string, action: string): void {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return notFound(res);
  const method = req.method ?? 'GET';

  if (action === 'info/refs' && method === 'GET') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return sendJson(res, 400, { message: 'Unknown service' });
    }
    const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    if (service === 'git-upload-pack' && wantsV2) {
      return sendRaw(res, 200, advertiseV2(service), 'application/x-git-upload-pack-advertisement');
    }
    return sendRaw(res, 200, advertiseV0(forge, repo, service), `application/x-${service}-advertisement`);
  }

  if (action === 'git-upload-pack' && method === 'POST') {
    const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    try {
      if (wantsV2) {
        const { packets } = splitPktAndPack(rawBody);
        const lines: string[] = [];
        for (const packet of packets) {
          if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
        }
        const command = lines[0] ?? '';
        const args = lines.slice(1);
        if (command === 'command=ls-refs') {
          return sendRaw(res, 200, handleLsRefs(forge, repo, args), 'application/x-git-upload-pack-result');
        }
        if (command === 'command=fetch') {
          return sendRaw(res, 200, handleFetchV2(forge.objects, args), 'application/x-git-upload-pack-result');
        }
        return sendJson(res, 400, { message: `Unknown command ${command}` });
      }
      const packets = parsePktLines(rawBody);
      return sendRaw(res, 200, handleFetchV0(forge.objects, packets), 'application/x-git-upload-pack-result');
    } catch {
      return sendJson(res, 400, { message: 'Malformed upload-pack request' });
    }
  }

  if (action === 'git-receive-pack' && method === 'POST') {
    try {
      const outcome = handleReceivePack(forge, repo, rawBody);
      return sendRaw(res, 200, wrapReport(outcome.report, outcome.sideband), 'application/x-git-receive-pack-result');
    } catch {
      return sendJson(res, 400, { message: 'Malformed receive-pack request' });
    }
  }

  return notFound(res);
}

// ---------------------------------------------------------------- GraphQL and MCP

function handleGraphQLRoute(res: ServerResponse, rawBody: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return sendJson(res, 400, { message: 'Problems parsing JSON' });
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => executeGraphQL(forge, (entry ?? {}) as GraphQLRequest));
    return sendJson(res, 200, results);
  }
  const result = executeGraphQL(forge, (parsed ?? {}) as GraphQLRequest);
  return sendJson(res, 200, result);
}

function handleMcpRoute(res: ServerResponse, rawBody: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      const outcome = handleMcp(forge, (entry ?? {}) as Record<string, unknown>);
      return outcome.body;
    });
    return sendJson(res, 200, results);
  }
  const outcome = handleMcp(forge, (parsed ?? {}) as Record<string, unknown>);
  if (outcome.status === 202) {
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return;
  }
  return sendJson(res, outcome.status, outcome.body);
}

// ---------------------------------------------------------------- the server

export function createApp(): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;

        if (path === '/healthz' && (req.method ?? 'GET') === 'GET') {
          return sendJson(res, 200, { ok: true });
        }

        const rawBody = await readBody(req);

        if (!authed(req)) {
          return sendJson(res, 401, { message: 'Requires authentication' });
        }

        if (path === '/api/graphql' && (req.method ?? 'GET') === 'POST') {
          return handleGraphQLRoute(res, rawBody);
        }
        if (path === '/mcp' && (req.method ?? 'GET') === 'POST') {
          return handleMcpRoute(res, rawBody);
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          return handleRest(req, res, url, rawBody);
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          return handleGit(req, res, url, rawBody, decodeURIComponent(gitMatch[1] as string), decodeURIComponent(gitMatch[2] as string), gitMatch[3] as string);
        }

        return notFound(res);
      } catch (err) {
        if (!res.writableEnded) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
        }
      }
    })();
  });
  return server;
}
