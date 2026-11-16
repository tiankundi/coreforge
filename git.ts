// git.ts — the git object model, implemented from scratch on node:crypto and node:zlib.
// Objects are stored byte-exactly as received (never re-serialized), indexed by their SHA-1.
// Packfiles are parsed (OFS_DELTA / REF_DELTA resolved, thin packs against the store) and
// generated (plain objects, no deltas — a valid pack needs none).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export const ZERO_OID = '0'.repeat(40);
const TYPE_BY_CODE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };
const CODE_BY_TYPE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export interface StoredObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

/** The content-addressed object store shared by every repository in the process. */
export class ObjectStore {
  readonly objects = new Map<string, StoredObject>();

  put(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putKnown(oid: string, type: ObjectType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }

  get(oid: string): StoredObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object's bytes into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries compare by name, directories as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitInfo {
  readonly tree: string;
  readonly parents: string[];
  readonly message: string;
  readonly raw: Buffer;
}

export function parseCommit(data: Buffer): CommitInfo {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message, raw: data };
}

export function buildCommitBytes(input: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  timestamp: number;
  message: string;
}): Buffer {
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author} ${input.timestamp} +0000`);
  lines.push(`committer ${input.committer} ${input.timestamp} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

/** The object a tag points at (and its type), from a tag object's bytes. */
export function parseTag(data: Buffer): { object: string; type: string } {
  let object = '';
  let type = '';
  for (const line of data.toString('utf8').split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line === '') break;
  }
  return { object, type };
}

/** Follow tag objects to the commit they ultimately name; null when the chain ends elsewhere. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

/** The commit at the end of a ref value, following tags; null when unresolvable. */
export function refCommit(store: ObjectStore, oid: string): string | null {
  return peelToCommit(store, oid);
}

// ---------------------------------------------------------------- packs

/** Inflate the zlib stream starting at `offset`; returns the data and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const rest = buffer.subarray(offset);
  let lo = 1;
  let hi = rest.length;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(rest.subarray(0, mid));
      best = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (best < 0) throw new Error('pack entry does not inflate');
  return { data: inflateSync(rest.subarray(0, best)), next: offset + best };
}

/** Apply a git delta (from a pack delta entry) to its base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] ?? 0;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] ?? 0;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] ?? 0) * 2 ** (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize += (delta[offset] ?? 0) * 2 ** (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

export interface PackReadResult {
  /** Every object the pack carried, fully resolved, keyed by object id. */
  readonly objects: Map<string, StoredObject>;
}

/**
 * Parse a packfile into the store. Delta bases may come from earlier in the pack or, for a thin
 * pack, from the store itself. Throws on any malformation; nothing is stored unless the whole
 * pack parses and its trailer checksum verifies.
 */
export function readPackInto(store: ObjectStore, pack: Buffer): PackReadResult {
  if (pack.length < 12 + 20) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('latin1') !== 'PACK') throw new Error('pack has no PACK signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack trailer checksum mismatch');

  const resolved = new Map<string, StoredObject>();
  const pendingDeltas: Array<{ entryOffset: number; baseOid?: string; baseOffset?: number; delta: Buffer }> = [];
  const byOffset = new Map<number, string>();
  let offset = 12;

  const resolveWith = (oid: string): StoredObject | undefined => resolved.get(oid) ?? store.get(oid);

  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset] ?? 0;
    offset += 1;
    const typeCode = (byte >> 4) & 0x7;
    // The entry's declared size is not needed: the zlib stream is self-terminating.
    while (byte & 0x80) {
      byte = pack[offset] ?? 0;
      offset += 1;
    }
    const typeName = TYPE_BY_CODE[typeCode];
    if (typeName === undefined) throw new Error(`pack entry has unknown type code ${typeCode}`);
    if (typeName === 'ofs-delta') {
      let back = pack[offset] ?? 0;
      offset += 1;
      let backOffset = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset] ?? 0;
        offset += 1;
        backOffset = ((backOffset + 1) << 7) | (back & 0x7f);
      }
      const { data, next } = inflateAt(pack, offset);
      offset = next;
      pendingDeltas.push({ entryOffset, baseOffset: entryOffset - backOffset, delta: data });
    } else if (typeName === 'ref-delta') {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data, next } = inflateAt(pack, offset);
      offset = next;
      pendingDeltas.push({ entryOffset, baseOid, delta: data });
    } else {
      const { data, next } = inflateAt(pack, offset);
      offset = next;
      const oid = hashObject(typeName, data);
      resolved.set(oid, { type: typeName, data });
      byOffset.set(entryOffset, oid);
    }
  }

  // Resolve deltas, possibly in chains (an OFS_DELTA's base may itself be a delta entry):
  // repeat until no delta makes progress; resolving one records its entry offset's object id,
  // which may unblock a delta that points at it.
  const queue = [...pendingDeltas];
  let progress = true;
  while (queue.length > 0 && progress) {
    progress = false;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const item = queue[index];
      if (item === undefined) continue;
      const baseOid = item.baseOid ?? (item.baseOffset !== undefined ? byOffset.get(item.baseOffset) : undefined);
      if (baseOid === undefined) continue;
      const base = resolveWith(baseOid);
      if (base === undefined) continue;
      const data = applyDelta(base.data, item.delta);
      const oid = hashObject(base.type, data);
      resolved.set(oid, { type: base.type, data });
      byOffset.set(item.entryOffset, oid);
      queue.splice(index, 1);
      progress = true;
    }
  }
  if (queue.length > 0) throw new Error('pack has a delta whose base is missing');

  for (const [oid, object] of resolved) store.putKnown(oid, object.type, object.data);
  return { objects: resolved };
}

/** One pack entry's header: the type/size varint git writes before the deflated bytes. */
function packEntryHeader(type: ObjectType, size: number): Buffer {
  const code = CODE_BY_TYPE[type] ?? 3;
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Serialize objects into a complete packfile (header, deflated plain entries, SHA-1 trailer). */
export function writePack(objects: readonly StoredObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** A valid empty pack: header with count 0 and its trailer (32 bytes). */
export function emptyPack(): Buffer {
  return writePack([]);
}
