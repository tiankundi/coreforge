// mcp.ts — the Model Context Protocol surface at POST /mcp: JSON-RPC 2.0 over plain JSON
// responses. server/discover is implemented (the modern era the suite's client prefers, which
// also answers initialize and server/discover checks), initialize answers for legacy probes,
// and the six canonical tools act on the same forge store REST serves, returning the same JSON
// shapes (shapes.ts), so cross-surface parity holds.

import { type Forge, VIEWER_LOGIN, createIssue, createPull, mergePull } from './store.ts';
import { issueJson, pullJson, repoJson } from './shapes.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, string>,
  required: string[],
): ToolDef {
  const props: ToolDef['inputSchema']['properties'] = {};
  for (const [key, text] of Object.entries(properties)) {
    props[key] = { type: key === 'private' ? 'boolean' : 'string', description: text };
  }
  return { name, description, inputSchema: { type: 'object', properties: props, required } };
}

/** The tool list: a constant, so two tools/list calls are identical. */
export const TOOLS: ToolDef[] = [
  tool('create_repo', 'Create a new repository for the authenticated user', {
    name: 'The repository name',
    description: 'The repository description',
    private: 'Whether the repository is private',
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name', {
    owner: 'The repository owner login',
    repo: 'The repository name',
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository', {
    owner: 'The repository owner login',
    repo: 'The repository name',
    title: 'The issue title',
    body: 'The issue body',
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository', {
    owner: 'The repository owner login',
    repo: 'The repository name',
    state: 'Filter by state: open, closed or all',
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request in a repository', {
    owner: 'The repository owner login',
    repo: 'The repository name',
    title: 'The pull request title',
    head: 'The head branch name',
    base: 'The base branch name',
    body: 'The pull request body',
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request by number', {
    owner: 'The repository owner login',
    repo: 'The repository name',
    pull_number: 'The pull request number',
  }, ['owner', 'repo', 'pull_number']),
];

export interface McpOutcome {
  /** HTTP status to answer with. */
  status: number;
  /** JSON body to answer with; undefined means an empty body (notifications). */
  body?: unknown;
}

function rpcError(id: unknown, code: number, message: string): McpOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function rpcResult(id: unknown, result: unknown): McpOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function toolResult(payload: unknown, isError = false): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  // structuredContent must be a JSON object; list payloads ride in the text content alone.
  const structured =
    !isError && typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? { structuredContent: payload as Record<string, unknown> }
      : {};
  return {
    content: [{ type: 'text', text }],
    ...structured,
    isError,
  };
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const owner = typeof args['owner'] === 'string' ? args['owner'] : VIEWER_LOGIN;
  const repoName = typeof args['repo'] === 'string' ? args['repo'] : '';
  const needRepo = (): ReturnType<Forge['getRepo']> => forge.getRepo(owner, repoName);
  switch (name) {
    case 'create_repo': {
      const repoNameToCreate = String(args['name'] ?? '');
      if (forge.getRepo(VIEWER_LOGIN, repoNameToCreate) !== undefined) {
        return toolResult(`repository ${VIEWER_LOGIN}/${repoNameToCreate} already exists`, true);
      }
      const repo = forge.createRepo(VIEWER_LOGIN, repoNameToCreate, {
        description: typeof args['description'] === 'string' ? args['description'] : '',
        isPrivate: typeof args['private'] === 'boolean' ? args['private'] : false,
      });
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = needRepo();
      if (repo === undefined) return toolResult(`repository ${owner}/${repoName} not found`, true);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = needRepo();
      if (repo === undefined) return toolResult(`repository ${owner}/${repoName} not found`, true);
      const issue = createIssue(repo, {
        title: String(args['title'] ?? ''),
        body: typeof args['body'] === 'string' ? args['body'] : '',
      });
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = needRepo();
      if (repo === undefined) return toolResult(`repository ${owner}/${repoName} not found`, true);
      const state = typeof args['state'] === 'string' ? args['state'] : 'open';
      const issues = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
      return toolResult(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = needRepo();
      if (repo === undefined) return toolResult(`repository ${owner}/${repoName} not found`, true);
      const pull = createPull(repo, {
        title: String(args['title'] ?? ''),
        body: typeof args['body'] === 'string' ? args['body'] : '',
        headRef: String(args['head'] ?? ''),
        baseRef: String(args['base'] ?? 'main'),
      });
      return toolResult(pullJson(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = needRepo();
      if (repo === undefined) return toolResult(`repository ${owner}/${repoName} not found`, true);
      const number = Number(args['pull_number']);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolResult(`pull request ${number} not found`, true);
      if (!pull.merged) {
        const outcome = mergePull(forge, repo, pull);
        if (!outcome.ok || outcome.commit === undefined) {
          return toolResult(`merge conflict: ${outcome.reason ?? 'the pull request is not mergeable'}`, true);
        }
        pull.merged = true;
        pull.state = 'closed';
        pull.mergeCommitSha = outcome.commit;
        pull.mergedAt = '2023-11-14T22:13:20Z';
      }
      return toolResult(pullJson(forge, repo, pull));
    }
    default:
      return toolResult(`unknown tool ${name}`, true);
  }
}

/** The required argument names a tool call must carry (from its own inputSchema). */
function missingArgs(def: ToolDef, args: Record<string, unknown>): string[] {
  return def.inputSchema.required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

/** Handle one parsed JSON-RPC message. Auth and JSON parsing live in app.ts. */
export function handleMcp(forge: Forge, message: Record<string, unknown>): McpOutcome {
  const id = message['id'];
  const method = typeof message['method'] === 'string' ? message['method'] : '';
  const params = (typeof message['params'] === 'object' && message['params'] !== null ? message['params'] : {}) as Record<string, unknown>;

  // A message with no id is a notification: accept it with 202 and no body.
  if (id === undefined) return { status: 202 };

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-06-18';
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params['name'] === 'string' ? params['name'] : '';
      const def = TOOLS.find((candidate) => candidate.name === name);
      if (def === undefined) return rpcError(id, -32602, `unknown tool ${JSON.stringify(name)}`);
      const args = (typeof params['arguments'] === 'object' && params['arguments'] !== null ? params['arguments'] : {}) as Record<string, unknown>;
      const missing = missingArgs(def, args);
      if (missing.length > 0) {
        return rpcResult(id, toolResult(`missing required argument(s): ${missing.join(', ')}`, true));
      }
      try {
        return rpcResult(id, callTool(forge, name, args));
      } catch (err) {
        return rpcResult(id, toolResult(err instanceof Error ? err.message : 'tool failed', true));
      }
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}
