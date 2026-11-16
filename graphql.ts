// graphql.ts — the GraphQL v4 surface the suite exercises: viewer, repository, node, issues and
// pull-request connections with cursor pagination, the five mutations the fixture performs
// (createIssue, closeIssue, createPullRequest, mergePullRequest, addComment), batched operation
// arrays, and introspection for Issue / PullRequest / Repository / SearchType. It is a small
// purpose-built parser and executor over the shared forge model — the same store REST serves,
// so ids and objects agree across surfaces.

import {
  type Forge,
  type Issue,
  type Pull,
  type Repo,
  VIEWER_LOGIN,
  createIssue,
  createPull,
  globalId,
  mergePull,
  parseGlobalId,
  pullMergeable,
} from './store.ts';
import { diffFiles } from './store.ts';

// ---------------------------------------------------------------- parsing

type Value =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'var'; name: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  name: string;
  alias?: string;
  args: Array<{ name: string; value: Value }>;
  selections: Selection[];
}

type Selection =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition?: string; selections: Selection[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, Selection[]>;
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (/\s|,/.test(char)) {
      index += 1;
      continue;
    }
    if (source.startsWith('...', index)) {
      tokens.push('...');
      index += 3;
      continue;
    }
    if (char === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        const text = source.slice(index + 3, end < 0 ? source.length : end);
        tokens.push(`"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
        index = end < 0 ? source.length : end + 3;
        continue;
      }
      let end = index + 1;
      let text = '';
      while (end < source.length && source[end] !== '"') {
        if (source[end] === '\\' && end + 1 < source.length) {
          text += source[end + 1] === 'n' ? '\n' : source[end + 1] === 't' ? '\t' : (source[end + 1] as string);
          end += 2;
        } else {
          text += source[end];
          end += 1;
        }
      }
      tokens.push(`"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      index = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end] as string)) end += 1;
      tokens.push(source.slice(index, end));
      index = end;
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let end = index;
      while (end < source.length && /[0-9.eE+-]/.test(source[end] as string)) end += 1;
      tokens.push(source.slice(index, end));
      index = end;
      continue;
    }
    tokens.push(char);
    index += 1;
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    this.pos += 1;
    if (token === undefined) throw new Error('unexpected end of document');
    return token;
  }

  private expect(token: string): void {
    const actual = this.next();
    if (actual !== token) throw new Error(`expected ${token}, found ${actual}`);
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, Selection[]>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === 'query' || token === 'mutation' || token === 'subscription') {
        this.next();
        let name: string | undefined;
        if (this.peek() !== '(' && this.peek() !== '{') name = this.next();
        if (this.peek() === '(') this.skipParens();
        if (this.peek() === '@') this.skipDirectives();
        operations.push({ type: token === 'mutation' ? 'mutation' : 'query', name, selections: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        this.next();
        const name = this.next();
        this.expect('on');
        this.next(); // the type condition
        if (this.peek() === '@') this.skipDirectives();
        fragments.set(name, this.parseSelectionSet());
      } else if (token === '{') {
        operations.push({ type: 'query', selections: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return { operations, fragments };
  }

  private skipParens(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0 && this.pos < this.tokens.length) {
      const token = this.next();
      if (token === '(') depth += 1;
      else if (token === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek() === '(') this.skipParens();
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          if (this.peek() === '@') this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else {
          const name = this.next();
          if (this.peek() === '@') this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expect('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.next();
    let alias: string | undefined;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Array<{ name: string; value: Value }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    if (this.peek() === '@') this.skipDirectives();
    const selections = this.peek() === '{' ? this.parseSelectionSet() : [];
    return { name, alias, args, selections };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') {
      // The tokenizer keeps $ as its own token only when separate; handle glued names too.
      return { kind: 'var', name: this.next() };
    }
    if (token.startsWith('$')) return { kind: 'var', name: token.slice(1) };
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true') return { kind: 'bool', value: true };
    if (token === 'false') return { kind: 'bool', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d*\.\d/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    return { kind: 'enum', value: token };
  }
}

/** Materialize a parsed argument value against the operation's variables. */
function materialize(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'var':
      return variables[value.name];
    case 'list':
      return value.items.map((item) => materialize(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = materialize(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- node wrappers

type Node =
  | { kind: 'User'; login: string }
  | { kind: 'Repository'; repo: Repo }
  | { kind: 'Issue'; repo: Repo; issue: Issue }
  | { kind: 'PullRequest'; repo: Repo; pull: Pull }
  | { kind: 'IssueComment'; repo: Repo; issue: Issue; commentId: number; body: string }
  | { kind: 'Ref'; name: string }
  | { kind: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { kind: 'Connection'; nodeKind: string; nodes: Node[]; pageInfo: Node }
  | { kind: 'PullRequestFile'; path: string }
  | { kind: 'Payload'; payloadKind: string; node?: Node; commentEdge?: Node }
  | { kind: 'CommentEdge'; node: Node }
  | { kind: '__Type'; name: string }
  | { kind: '__Field'; name: string }
  | { kind: '__EnumValue'; name: string };

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'repository', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'url', 'closed'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'repository', 'author', 'createdAt', 'updatedAt', 'url', 'closed', 'isDraft'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, Selection[]>;
  errors: Array<{ message: string }>;
}

function repoByDbId(forge: Forge, dbId: number): Repo | undefined {
  for (const repo of forge.repos.values()) if (repo.dbId === dbId) return repo;
  return undefined;
}

function nodeByGlobalId(forge: Forge, id: string): Node | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.type === 'Repository') {
    const repo = repoByDbId(forge, Number(parsed.parts[0]));
    return repo === undefined ? null : { kind: 'Repository', repo };
  }
  if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
    const repo = repoByDbId(forge, Number(parsed.parts[0]));
    if (repo === undefined) return null;
    const number = Number(parsed.parts[1]);
    if (parsed.type === 'Issue') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : { kind: 'Issue', repo, issue };
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : { kind: 'PullRequest', repo, pull };
  }
  if (parsed.type === 'User') return { kind: 'User', login: String(parsed.parts[0] ?? VIEWER_LOGIN) };
  return null;
}

function cursorFor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

function offsetFor(cursor: unknown): number {
  if (typeof cursor !== 'string') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? 0 : Number(match[1]);
  } catch {
    return 0;
  }
}

function paginate<T>(items: readonly T[], args: Record<string, unknown>): { page: T[]; hasNextPage: boolean; endCursor: string | null } {
  const first = typeof args['first'] === 'number' ? Math.max(0, Math.trunc(args['first'] as number)) : items.length;
  const start = offsetFor(args['after']);
  const page = items.slice(start, start + first);
  const nextOffset = start + page.length;
  return {
    page,
    hasNextPage: nextOffset < items.length,
    endCursor: page.length > 0 ? cursorFor(nextOffset) : null,
  };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

// ---------------------------------------------------------------- field resolution

function resolveField(ctx: Ctx, typeName: string, source: Node | null, field: FieldNode): unknown {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = materialize(arg.value, ctx.variables);
  const forge = ctx.forge;

  if (field.name === '__typename') return typeName;

  if (typeName === 'Query') {
    switch (field.name) {
      case 'viewer':
        return { kind: 'User', login: VIEWER_LOGIN } as Node;
      case 'repository': {
        const repo = forge.getRepo(String(args['owner'] ?? ''), String(args['name'] ?? ''));
        return repo === undefined ? null : ({ kind: 'Repository', repo } as Node);
      }
      case 'node':
        return typeof args['id'] === 'string' ? nodeByGlobalId(forge, args['id']) : null;
      case '__type':
        return { kind: '__Type', name: String(args['name'] ?? '') } as Node;
      case '__schema':
        return { kind: '__Type', name: '__Schema' } as Node;
      default:
        break;
    }
  }

  if (typeName === 'Mutation') {
    const input = (args['input'] ?? {}) as Record<string, unknown>;
    switch (field.name) {
      case 'createIssue': {
        const parsed = parseGlobalId(String(input['repositoryId'] ?? ''));
        const repo = parsed !== null && parsed.type === 'Repository' ? repoByDbId(forge, Number(parsed.parts[0])) : undefined;
        if (repo === undefined) throw new Error('createIssue: repository not found');
        const issue = createIssue(repo, { title: String(input['title'] ?? ''), body: String(input['body'] ?? '') });
        return { kind: 'Payload', payloadKind: 'CreateIssuePayload', node: { kind: 'Issue', repo, issue } } as Node;
      }
      case 'closeIssue': {
        const node = nodeByGlobalId(forge, String(input['issueId'] ?? ''));
        if (node === null || node.kind !== 'Issue') throw new Error('closeIssue: issue not found');
        node.issue.state = 'closed';
        return { kind: 'Payload', payloadKind: 'CloseIssuePayload', node } as Node;
      }
      case 'createPullRequest': {
        const parsed = parseGlobalId(String(input['repositoryId'] ?? ''));
        const repo = parsed !== null && parsed.type === 'Repository' ? repoByDbId(forge, Number(parsed.parts[0])) : undefined;
        if (repo === undefined) throw new Error('createPullRequest: repository not found');
        const pull = createPull(repo, {
          title: String(input['title'] ?? ''),
          body: String(input['body'] ?? ''),
          headRef: String(input['headRefName'] ?? ''),
          baseRef: String(input['baseRefName'] ?? 'main'),
        });
        return { kind: 'Payload', payloadKind: 'CreatePullRequestPayload', node: { kind: 'PullRequest', repo, pull } } as Node;
      }
      case 'mergePullRequest': {
        const node = nodeByGlobalId(forge, String(input['pullRequestId'] ?? ''));
        if (node === null || node.kind !== 'PullRequest') throw new Error('mergePullRequest: pull request not found');
        if (!node.pull.merged) {
          const outcome = mergePull(forge, node.repo, node.pull);
          if (!outcome.ok || outcome.commit === undefined) throw new Error(`mergePullRequest: ${outcome.reason ?? 'conflict'}`);
          node.pull.merged = true;
          node.pull.state = 'closed';
          node.pull.mergeCommitSha = outcome.commit;
          node.pull.mergedAt = new Date(1_700_000_000_000 + node.pull.number * 1000).toISOString();
        }
        return { kind: 'Payload', payloadKind: 'MergePullRequestPayload', node } as Node;
      }
      case 'addComment': {
        const node = nodeByGlobalId(forge, String(input['subjectId'] ?? ''));
        if (node === null || node.kind !== 'Issue') throw new Error('addComment: subject not found');
        const comment = { id: node.repo.nextCommentId, body: String(input['body'] ?? '') };
        node.repo.nextCommentId += 1;
        node.issue.comments.push(comment);
        const commentNode: Node = { kind: 'IssueComment', repo: node.repo, issue: node.issue, commentId: comment.id, body: comment.body };
        return { kind: 'Payload', payloadKind: 'AddCommentPayload', commentEdge: { kind: 'CommentEdge', node: commentNode } } as Node;
      }
      default:
        break;
    }
  }

  if (source === null) {
    if (typeName === 'Query' || typeName === 'Mutation') {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
    }
    return null;
  }

  switch (source.kind) {
    case 'User':
      if (field.name === 'login') return source.login;
      if (field.name === 'id') return globalId('User', source.login);
      if (field.name === 'name') return source.login;
      break;
    case 'Repository': {
      const repo = source.repo;
      switch (field.name) {
        case 'id':
          return globalId('Repository', repo.dbId);
        case 'databaseId':
          return repo.dbId;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return { kind: 'User', login: repo.owner } as Node;
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.isPrivate;
        case 'defaultBranchRef':
          return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? ({ kind: 'Ref', name: repo.defaultBranch } as Node) : null;
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const issue = repo.issues.get(Number(args['number']));
          return issue === undefined ? null : ({ kind: 'Issue', repo, issue } as Node);
        }
        case 'issues': {
          let issues = [...repo.issues.values()];
          const states = args['states'];
          if (Array.isArray(states)) {
            const wanted = new Set(states.map((state) => String(state).toLowerCase()));
            issues = issues.filter((issue) => wanted.has(issue.state));
          }
          const orderBy = args['orderBy'] as { field?: string; direction?: string } | undefined;
          issues.sort((a, b) => a.number - b.number);
          if (orderBy !== undefined && String(orderBy.direction ?? 'ASC') === 'DESC') issues.reverse();
          const { page, hasNextPage, endCursor } = paginate(issues, args);
          return {
            kind: 'Connection',
            nodeKind: 'Issue',
            nodes: page.map((issue) => ({ kind: 'Issue', repo, issue }) as Node),
            pageInfo: { kind: 'PageInfo', hasNextPage, endCursor } as Node,
          } as Node;
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args['number']));
          return pull === undefined ? null : ({ kind: 'PullRequest', repo, pull } as Node);
        }
        case 'pullRequests': {
          const pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
          const { page, hasNextPage, endCursor } = paginate(pulls, args);
          return {
            kind: 'Connection',
            nodeKind: 'PullRequest',
            nodes: page.map((pull) => ({ kind: 'PullRequest', repo, pull }) as Node),
            pageInfo: { kind: 'PageInfo', hasNextPage, endCursor } as Node,
          } as Node;
        }
        default:
          break;
      }
      break;
    }
    case 'Issue': {
      const issue = source.issue;
      switch (field.name) {
        case 'id':
          return globalId('Issue', source.repo.dbId, issue.number);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issueState(issue);
        case 'closed':
          return issue.state === 'closed';
        case 'repository':
          return { kind: 'Repository', repo: source.repo } as Node;
        default:
          break;
      }
      break;
    }
    case 'PullRequest': {
      const pull = source.pull;
      switch (field.name) {
        case 'id':
          return globalId('PullRequest', source.repo.dbId, pull.number);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'closed':
          return pull.state === 'closed';
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable':
          if (pull.merged) return 'UNKNOWN';
          return pullMergeable(forge, source.repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'files': {
          const baseFiles = forge.filesAtRef(source.repo, pull.baseRef);
          const headFiles = forge.filesAtRef(source.repo, pull.headRef);
          const files = diffFiles(forge, baseFiles, headFiles);
          const { page, hasNextPage, endCursor } = paginate(files, args);
          return {
            kind: 'Connection',
            nodeKind: 'PullRequestFile',
            nodes: page.map((file) => ({ kind: 'PullRequestFile', path: file.filename }) as Node),
            pageInfo: { kind: 'PageInfo', hasNextPage, endCursor } as Node,
          } as Node;
        }
        case 'repository':
          return { kind: 'Repository', repo: source.repo } as Node;
        default:
          break;
      }
      break;
    }
    case 'IssueComment':
      if (field.name === 'id') return globalId('IssueComment', source.repo.dbId, source.commentId);
      if (field.name === 'body') return source.body;
      break;
    case 'Ref':
      if (field.name === 'name') return source.name;
      if (field.name === 'prefix') return 'refs/heads/';
      break;
    case 'PageInfo':
      if (field.name === 'hasNextPage') return source.hasNextPage;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'endCursor') return source.endCursor;
      if (field.name === 'startCursor') return source.endCursor;
      break;
    case 'Connection':
      if (field.name === 'nodes') return source.nodes;
      if (field.name === 'pageInfo') return source.pageInfo;
      if (field.name === 'totalCount') return source.nodes.length;
      if (field.name === 'edges') {
        return source.nodes.map((node) => ({ kind: 'CommentEdge', node }) as Node);
      }
      break;
    case 'PullRequestFile':
      if (field.name === 'path') return source.path;
      break;
    case 'Payload':
      if (field.name === 'issue' && source.node?.kind === 'Issue') return source.node;
      if (field.name === 'pullRequest' && source.node?.kind === 'PullRequest') return source.node;
      if (field.name === 'commentEdge' && source.commentEdge !== undefined) return source.commentEdge;
      if (field.name === 'clientMutationId') return null;
      break;
    case 'CommentEdge':
      if (field.name === 'node') return source.node;
      if (field.name === 'cursor') return cursorFor(0);
      break;
    case '__Type': {
      if (field.name === 'name') return source.name;
      if (field.name === 'kind') return TYPE_ENUMS[source.name] !== undefined ? 'ENUM' : 'OBJECT';
      if (field.name === 'fields') {
        const names = TYPE_FIELDS[source.name] ?? [];
        return names.map((name) => ({ kind: '__Field', name }) as Node);
      }
      if (field.name === 'enumValues') {
        const values = TYPE_ENUMS[source.name] ?? [];
        return values.map((name) => ({ kind: '__EnumValue', name }) as Node);
      }
      if (field.name === 'possibleTypes') return [];
      if (field.name === 'inputFields') return [];
      if (field.name === 'ofType') return null;
      if (field.name === 'description') return null;
      break;
    }
    case '__Field':
      if (field.name === 'name') return source.name;
      if (field.name === 'description') return null;
      if (field.name === 'args') return [];
      if (field.name === 'type') return { kind: '__Type', name: 'String' } as Node;
      if (field.name === 'isDeprecated') return false;
      if (field.name === 'deprecationReason') return null;
      break;
    case '__EnumValue':
      if (field.name === 'name') return source.name;
      if (field.name === 'description') return null;
      if (field.name === 'isDeprecated') return false;
      if (field.name === 'deprecationReason') return null;
      break;
  }

  ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
  return null;
}

/** The GraphQL type name a node answers to (for fragments and error messages). */
function typeNameOf(node: Node | null, rootType: string): string {
  if (node === null) return rootType;
  switch (node.kind) {
    case 'Payload':
      return node.payloadKind;
    case 'Connection':
      return `${node.nodeKind}Connection`;
    default:
      return node.kind;
  }
}

function executeSelections(ctx: Ctx, typeName: string, source: Node | null, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === undefined || selection.typeCondition === typeName) {
        Object.assign(out, executeSelections(ctx, typeName, source, selection.selections));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) Object.assign(out, executeSelections(ctx, typeName, source, fragment));
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    let value: unknown;
    try {
      value = resolveField(ctx, typeName, source, field);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      value = null;
    }
    if (field.selections.length > 0 && value !== null && value !== undefined) {
      if (Array.isArray(value)) {
        value = value.map((item) => {
          const node = item as Node;
          return executeSelections(ctx, typeNameOf(node, typeName), node, field.selections);
        });
      } else if (typeof value === 'object') {
        const node = value as Node;
        value = executeSelections(ctx, typeNameOf(node, typeName), node, field.selections);
      }
    }
    out[key] = value === undefined ? null : value;
  }
  return out;
}

export interface GraphQLRequest {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

/** Execute one GraphQL operation body ({query, variables}) and return the response body. */
export function executeGraphQL(forge: Forge, body: GraphQLRequest): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as Record<string, unknown>;
  let document: Document;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'could not parse the document' }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  const operation = document.operations.find((candidate) => operationName === undefined || candidate.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in the document' }] };
  const ctx: Ctx = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, rootType, null, operation.selections);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response['errors'] = ctx.errors;
  return response;
}
