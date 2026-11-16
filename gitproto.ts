// gitproto.ts — git smart HTTP: protocol v2 (advertisement, ls-refs, fetch with shallow/deepen)
// and protocol v0 (advertisement, fetch, receive-pack with report-status). Framing is pkt-line
// throughout; packfiles come from git.ts. Refs live in the shared forge model (store.ts), so the
// git surface and the REST contents API always agree.

import {
  ObjectStore,
  ZERO_OID,
  parseCommit,
  parseTag,
  parseTree,
  readPackInto,
  writePack,
  type StoredObject,
} from './git.ts';
import type { Forge, Repo } from './store.ts';

export const AGENT = 'forge/1.0';

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'latin1');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'latin1');
export const PKT_DELIM = Buffer.from('0001', 'latin1');
export const PKT_RESPONSE_END = Buffer.from('0002', 'latin1');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Parse a complete pkt-line stream; throws on malformed framing. */
export function parsePktLines(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('latin1');
    if (!/^[0-9a-f]{4}$/.test(header)) throw new Error(`bad pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else {
      if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line overruns the body');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/** Split a request body into the pkt-line command part and any raw pack bytes after the flush. */
export function splitPktAndPack(buffer: Buffer): { packets: Packet[]; pack: Buffer } {
  let offset = 0;
  const packets: Packet[] = [];
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('latin1');
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      return { packets, pack: buffer.subarray(offset) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, pack: buffer.subarray(offset) };
}

// ---------------------------------------------------------------- ref listing

export interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
}

/** Every ref the repo advertises, HEAD first, then refs in name order, tags peeled. */
export function listRefs(forge: Forge, repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (headOid !== undefined) lines.push({ oid: headOid, name: 'HEAD', symrefTarget: headRef });
  else lines.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: headRef });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name);
    if (oid === undefined) continue;
    const line: RefLine = { oid, name };
    const object = forge.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = forge.objects.get(target);
      if (targetObject !== undefined && targetObject.type === 'commit') line.peeled = target;
      else {
        // Peel through nested tags to the commit when there is one.
        let current = target;
        for (let hops = 0; hops < 8; hops += 1) {
          const next = forge.objects.get(current);
          if (next === undefined || next.type !== 'tag') break;
          current = parseTag(next.data).object;
        }
        const finalObject = forge.objects.get(current);
        if (finalObject !== undefined && finalObject.type === 'commit') line.peeled = current;
      }
    }
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------- advertisements

const UPLOAD_CAPS_V0 = ['multi_ack_detailed', 'thin-pack', 'side-band-64k', 'ofs-delta', 'shallow', `agent=${AGENT}`];
const RECEIVE_CAPS_V0 = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`];

export function advertiseV2(service: string): Buffer {
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
}

export function advertiseV0(forge: Forge, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  if (repo.refs.size === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`));
  } else {
    let first = true;
    for (const line of listRefs(forge, repo)) {
      if (line.name === 'HEAD' && line.oid === ZERO_OID) continue;
      let capText = '';
      if (first) {
        capText = `\0${caps.join(' ')}`;
        if (service === 'git-upload-pack') capText += ` symref=HEAD:refs/heads/${repo.defaultBranch}`;
      }
      parts.push(pktLine(`${line.oid} ${line.name}${capText}\n`));
      first = false;
      if (line.peeled !== undefined) parts.push(pktLine(`${line.peeled} ${line.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ls-refs (v2)

export function handleLsRefs(forge: Forge, repo: Repo, args: readonly string[]): Buffer {
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
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  for (const line of listRefs(forge, repo)) {
    if (!matches(line.name)) continue;
    if (line.oid === ZERO_OID) {
      if (!unborn) continue;
      out.push(pktLine(`unborn HEAD${symrefs && line.symrefTarget !== undefined ? ` symref-target:${line.symrefTarget}` : ''}\n`));
      continue;
    }
    let text = `${line.oid} ${line.name}`;
    if (symrefs && line.symrefTarget !== undefined) text += ` symref-target:${line.symrefTarget}`;
    if (peel && line.peeled !== undefined) text += ` peeled:${line.peeled}`;
    out.push(pktLine(`${text}\n`));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- fetch

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

interface FetchPlan {
  objects: StoredObject[];
  shallowLines: string[];
  unshallowLines: string[];
}

/** Commit closure of `starts`, never descending into `boundary` commits' parents. */
function commitClosure(store: ObjectStore, starts: readonly string[], boundary: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const start of starts) {
    const object = store.get(start);
    if (object !== undefined && object.type === 'commit') queue.push(start);
  }
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (boundary.has(current)) continue;
    const object = store.get(current);
    if (object !== undefined && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return seen;
}

/** Add a tree and everything under it (subtrees and blobs) to the object set. */
function addTreeClosure(store: ObjectStore, treeOid: string, into: Set<string>): void {
  if (into.has(treeOid)) return;
  const object = store.get(treeOid);
  if (object === undefined || object.type !== 'tree') return;
  into.add(treeOid);
  for (const entry of parseTree(object.data)) {
    if (entry.mode === '40000' || entry.mode === '040000') addTreeClosure(store, entry.oid, into);
    else into.add(entry.oid);
  }
}

/** Every object id the client already holds: haves' closure (cut at its shallow boundary). */
function possessedObjects(store: ObjectStore, haves: readonly string[], shallowBoundary: ReadonlySet<string>): Set<string> {
  const commits = commitClosure(store, haves, shallowBoundary);
  const objects = new Set<string>();
  for (const commit of commits) {
    objects.add(commit);
    const object = store.get(commit);
    if (object !== undefined && object.type === 'commit') addTreeClosure(store, parseCommit(object.data).tree, objects);
  }
  // Tag/ tree / blob haves count as possessed too.
  for (const have of haves) if (store.has(have)) objects.add(have);
  return objects;
}

export function planFetch(store: ObjectStore, request: FetchRequest): FetchPlan {
  const boundary = new Set(request.shallow);
  const possessed = possessedObjects(store, request.haves, boundary);
  const possessedCommits = commitClosure(store, request.haves, boundary);

  // Included commits: by depth (BFS distance from the wants) or full closure.
  const includedCommits = new Set<string>();
  const wantCommits: string[] = [];
  const extraObjects = new Set<string>();
  for (const want of request.wants) {
    const object = store.get(want);
    if (object === undefined) continue;
    if (object.type === 'commit') wantCommits.push(want);
    else if (object.type === 'tag') {
      extraObjects.add(want);
      const target = parseTag(object.data).object;
      const targetObject = store.get(target);
      if (targetObject !== undefined && targetObject.type === 'commit') wantCommits.push(target);
      else if (targetObject !== undefined) extraObjects.add(target);
    } else {
      extraObjects.add(want);
    }
  }
  if (request.depth !== null) {
    const distance = new Map<string, number>();
    const queue: Array<{ oid: string; dist: number }> = wantCommits.map((oid) => ({ oid, dist: 0 }));
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) continue;
      const known = distance.get(item.oid);
      if (known !== undefined && known <= item.dist) continue;
      distance.set(item.oid, item.dist);
      const object = store.get(item.oid);
      if (object !== undefined && object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, dist: item.dist + 1 });
      }
    }
    for (const [oid, dist] of distance) {
      if (dist < request.depth && !possessedCommits.has(oid)) includedCommits.add(oid);
    }
  } else {
    for (const oid of commitClosure(store, wantCommits, new Set<string>())) {
      if (!possessedCommits.has(oid)) includedCommits.add(oid);
    }
  }

  const send = new Set<string>();
  for (const oid of extraObjects) if (!possessed.has(oid)) send.add(oid);
  for (const commit of includedCommits) {
    send.add(commit);
    const object = store.get(commit);
    if (object !== undefined && object.type === 'commit') addTreeClosure(store, parseCommit(object.data).tree, send);
  }
  for (const oid of possessed) send.delete(oid);

  const shallowLines: string[] = [];
  const unshallowLines: string[] = [];
  if (request.depth !== null || request.shallow.length > 0) {
    for (const commit of includedCommits) {
      const object = store.get(commit);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length > 0 && !parents.some((parent) => includedCommits.has(parent) || possessedCommits.has(parent))) {
        shallowLines.push(commit);
      }
    }
    for (const boundaryCommit of request.shallow) {
      const object = store.get(boundaryCommit);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length > 0 && parents.every((parent) => includedCommits.has(parent) || possessedCommits.has(parent))) {
        unshallowLines.push(boundaryCommit);
      }
    }
  }

  const objects: StoredObject[] = [];
  for (const oid of send) {
    const object = store.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return { objects, shallowLines, unshallowLines };
}

/** Wrap pack bytes in side-band-64k band-1 packets (each at most 65516 payload bytes). */
export function sidebandWrap(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  // A pkt-line is at most 65520 bytes including its 4-byte header and the band byte.
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
}

export function handleFetchV2(store: ObjectStore, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7).trim(), 10);
    else if (arg === 'done') done = true;
  }
  // Protocol v2 negotiation, as git's own state machine drives it:
  //   - a request with `done` is answered with the shallow-info (when shallow is in play) and
  //     the packfile, and no acknowledgments section;
  //   - a request without `done` but with a have the server knows is answered with an
  //     acknowledgments section (ACK + ready) followed by the packfile in the same response;
  //   - a request without `done` and without a common have gets a bare NAK acknowledgments
  //     section, and the client continues the negotiation.
  const plan = planFetch(store, { wants, haves, shallow, depth: Number.isFinite(depth as number) ? depth : null });
  const packfileParts: Buffer[] = [];
  if (depth !== null || shallow.length > 0) {
    packfileParts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallowLines) packfileParts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallowLines) packfileParts.push(pktLine(`unshallow ${oid}\n`));
    packfileParts.push(PKT_DELIM);
  }
  packfileParts.push(pktLine('packfile\n'));
  packfileParts.push(...sidebandWrap(writePack(plan.objects)));
  packfileParts.push(PKT_FLUSH);

  if (done) return Buffer.concat(packfileParts);
  const ackHave = haves.find((have) => {
    const object = store.get(have);
    return object !== undefined && object.type === 'commit';
  });
  if (ackHave === undefined) {
    return Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH]);
  }
  return Buffer.concat([
    pktLine('acknowledgments\n'),
    pktLine(`ACK ${ackHave}\n`),
    pktLine('ready\n'),
    PKT_DELIM,
    ...packfileParts,
  ]);
}

/** Protocol v0 fetch: wants/haves/done over two pkt-line rounds flattened into one body. */
export function handleFetchV0(store: ObjectStore, packets: readonly Packet[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
  }
  const plan = planFetch(store, { wants, haves, shallow, depth });
  const parts: Buffer[] = [];
  for (const oid of plan.shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(...sidebandWrap(writePack(plan.objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushOutcome {
  /** The report-status stream (pkt-lines, before any sideband wrapping). */
  report: Buffer;
  sideband: boolean;
}

/** Whether `candidate` is `ancestor` or descends from it in the store's history. */
function isAncestorOrSelf(store: ObjectStore, ancestor: string, candidate: string): boolean {
  const seen = new Set<string>();
  const queue = [candidate];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    if (current === ancestor) return true;
    seen.add(current);
    const object = store.get(current);
    if (object !== undefined && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return false;
}

export function handleReceivePack(forge: Forge, repo: Repo, body: Buffer): PushOutcome {
  const { packets, pack } = splitPktAndPack(body);
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      const caps = line.slice(nul + 1);
      if (caps.split(' ').includes('side-band-64k')) sideband = true;
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length === 3 && /^[0-9a-f]{40}$/.test(parts[0] ?? '') && /^[0-9a-f]{40}$/.test(parts[1] ?? '')) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (needsPack) {
    if (pack.length === 0) {
      unpackOk = false;
      unpackDetail = 'no packfile for a ref update';
    } else {
      try {
        readPackInto(forge.objects, pack);
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack failed';
      }
    }
  }

  const lines: string[] = [`unpack ${unpackOk ? 'ok' : `err ${unpackDetail}`}\n`];
  for (const command of commands) {
    if (!unpackOk) {
      lines.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      lines.push(`ok ${command.ref}\n`);
      continue;
    }
    const target = forge.objects.get(command.newOid);
    if (target === undefined) {
      lines.push(`ng ${command.ref} new object is missing\n`);
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (current !== ZERO_OID && target.type === 'commit') {
      const currentObject = forge.objects.get(current);
      if (currentObject !== undefined && currentObject.type === 'commit' && !isAncestorOrSelf(forge.objects, current, command.newOid)) {
        lines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    lines.push(`ok ${command.ref}\n`);
  }

  const report = Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
  return { report, sideband };
}

/** Wrap a report-status stream in band-1 sideband packets when the client negotiated it. */
export function wrapReport(report: Buffer, sideband: boolean): Buffer {
  if (!sideband) return report;
  const packets: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < report.length; offset += CHUNK) {
    const slice = report.subarray(offset, Math.min(report.length, offset + CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  packets.push(PKT_FLUSH);
  return Buffer.concat(packets);
}
