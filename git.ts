// Git object model, packfiles and pkt-lines, implemented from the protocol's own rules:
// no git binary, no dependencies beyond node: builtins.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const NUM_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface GitObject {
  type: ObjType;
  buf: Buffer;
}

/** The object database: one content-addressed map for every repository (objects are immutable). */
export class ObjectStore {
  readonly map = new Map<string, GitObject>();
  /** Tag object ids, kept beside the map so a fetch never scans every object to find them. */
  readonly tags = new Set<string>();

  oidOf(type: ObjType, buf: Buffer): string {
    const head = Buffer.from(`${type} ${buf.length}\0`, 'utf8');
    return createHash('sha1').update(head).update(buf).digest('hex');
  }

  store(type: ObjType, buf: Buffer): string {
    const oid = this.oidOf(type, buf);
    if (!this.map.has(oid)) {
      this.map.set(oid, { type, buf });
      if (type === 'tag') this.tags.add(oid);
    }
    return oid;
  }

  get(oid: string): GitObject | undefined {
    return this.map.get(oid);
  }

  has(oid: string): boolean {
    return this.map.has(oid);
  }
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '120000' | '40000' | '160000'
  name: string;
  oid: string;
}

const treeParseCache = new WeakMap<Buffer, TreeEntry[]>();

export function parseTree(buf: Buffer): TreeEntry[] {
  const cached = treeParseCache.get(buf);
  if (cached) return cached;
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    const mode = buf.toString('utf8', i, sp);
    const nul = buf.indexOf(0x00, sp + 1);
    const name = buf.toString('utf8', sp + 1, nul);
    const oid = buf.toString('hex', nul + 1, nul + 21);
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  treeParseCache.set(buf, out);
  return out;
}

/** Git's tree order: by name, directories as if the name ended in '/'. */
export function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree into path -> entry, recursing into subtrees. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, TreeEntry & { path: string }>()): Map<string, TreeEntry & { path: string }> {
  const obj = store.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.buf)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(store, e.oid, path, out);
    else out.set(path, { ...e, path });
  }
  return out;
}

/** Build (and store) nested trees from a flat path -> {oid, mode} map; returns the root tree oid. */
export function storeTreeFromFiles(store: ObjectStore, files: Map<string, { oid: string; mode: string }>): string {
  interface Dir {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, f] of files) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      if (!dir.dirs.has(part)) dir.dirs.set(part, { files: new Map(), dirs: new Map() });
      dir = dir.dirs.get(part) as Dir;
    }
    dir.files.set(parts[parts.length - 1] as string, f);
  }
  const build = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, f] of dir.files) entries.push({ mode: f.mode, name, oid: f.oid });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
    return store.store('tree', buildTree(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

const commitParseCache = new WeakMap<Buffer, CommitInfo>();

export function parseCommit(buf: Buffer): CommitInfo {
  const cached = commitParseCache.get(buf);
  if (cached) return cached;
  const text = buf.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  commitParseCache.set(buf, info);
  return info;
}

export function buildCommit(info: CommitInfo): Buffer {
  let head = `tree ${info.tree}\n`;
  for (const p of info.parents) head += `parent ${p}\n`;
  head += `author ${info.author}\ncommitter ${info.committer}\n`;
  return Buffer.from(`${head}\n${info.message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(buf: Buffer): TagInfo {
  const text = buf.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const info: TagInfo = { object: '', type: '', tag: '', tagger: '', message: split === -1 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

/** Peel an oid to a commit: follow tags until a commit (or undefined). */
export function peelToCommit(store: ObjectStore, oid: string): string | undefined {
  let cur = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = store.get(cur);
    if (!obj) return undefined;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      cur = parseTag(obj.buf).object;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** All ancestors of a commit (including itself), breadth-first by generation. */
export function ancestors(store: ObjectStore, tip: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue = [tip];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (seen.has(cur)) continue;
    const obj = store.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(cur);
    order.push(cur);
    for (const p of parseCommit(obj.buf).parents) queue.push(p);
  }
  return order;
}

/** Whether `anc` is `desc` itself or one of its ancestors; walks from `desc` and stops at the first hit. */
export function isAncestor(store: ObjectStore, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>([desc]);
  const stack = [desc];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    const obj = store.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.buf).parents) {
      if (p === anc) return true;
      if (!seen.has(p)) {
        seen.add(p);
        stack.push(p);
      }
    }
  }
  return false;
}

/** The merge base of two commits: their first common ancestor in breadth-first order from b. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | undefined {
  const ancA = new Set(ancestors(store, a));
  for (const cand of ancestors(store, b)) if (ancA.has(cand)) return cand;
  return undefined;
}

// ---------------------------------------------------------------- deltas

/** Apply a git delta buffer to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let n = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[i] as number;
      i += 1;
      n |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return n;
  };
  readVarint(); // base size
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (i < delta.length) {
    const op = delta[i] as number;
    i += 1;
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) if (op & (1 << bit)) { off |= (delta[i] as number) << (8 * bit); i += 1; }
      for (let bit = 0; bit < 3; bit += 1) if (op & (0x10 << bit)) { size |= (delta[i] as number) << (8 * bit); i += 1; }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(off, off + size));
      produced += size;
    } else if (op > 0) {
      parts.push(delta.subarray(i, i + op));
      produced += op;
      i += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize || produced !== targetSize) throw new Error('delta size mismatch');
  return out;
}

// ---------------------------------------------------------------- packfiles

interface PackEntry {
  type: ObjType;
  buf: Buffer;
  /** For delta entries: the base's oid (ref-delta) or offset (ofs-delta). */
  baseOid?: string;
  baseOffset?: number;
  offset: number;
}

/** Inflate one zlib stream starting at `offset`; returns the data and the offset just past it. */
export function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/**
 * Parse a packfile into the store. Returns the number of objects. Delta bases may live in the
 * pack itself or already in the store (thin packs from a fetch negotiation never reach here:
 * receive-pack packs are self-contained, but a base the client names from the destination's
 * advertised refs can occur, so the store is consulted too).
 */
export function parsePack(store: ObjectStore, pack: Buffer): number {
  if (pack.length < 12 + 20 || pack.toString('utf8', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');
  const raw: PackEntry[] = [];
  let offset = 12;
  for (let n = 0; n < count; n += 1) {
    const start = offset;
    let byte = pack[offset] as number;
    offset += 1;
    let typeNum = (byte >> 4) & 7;
    // size is informational here; the zlib stream delimits the object
    while (byte & 0x80) { byte = pack[offset] as number; offset += 1; }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeNum === 6) { // ofs-delta
      let b = pack[offset] as number;
      offset += 1;
      let off = b & 0x7f;
      while (b & 0x80) { b = pack[offset] as number; offset += 1; off = ((off + 1) << 7) | (b & 0x7f); }
      baseOffset = start - off;
    } else if (typeNum === 7) { // ref-delta
      baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const { data, next } = inflateAt(pack, offset);
    offset = next;
    if (typeNum === 6 || typeNum === 7) {
      raw.push({ type: 'blob', buf: data, baseOid, baseOffset, offset: start });
    } else {
      const type = NUM_TYPE[typeNum];
      if (!type) throw new Error(`pack object type ${typeNum}`);
      raw.push({ type, buf: data, offset: start });
    }
    typeNum = typeNum; // no-op, keeps the variable visibly used
  }
  // Resolve in passes: an entry is ready when it is whole, or its base is already resolved.
  const byOffset = new Map<number, PackEntry>();
  for (const e of raw) byOffset.set(e.offset, e);
  const resolvedOid = new Map<number, string>();
  let pending = [...raw];
  let guard = 0;
  while (pending.length > 0) {
    guard += 1;
    if (guard > count + 2) throw new Error('pack deltas do not resolve');
    const nextPending: PackEntry[] = [];
    for (const e of pending) {
      if (e.baseOid === undefined && e.baseOffset === undefined) {
        resolvedOid.set(e.offset, store.store(e.type, e.buf));
        continue;
      }
      let baseObj: GitObject | undefined;
      if (e.baseOid !== undefined) baseObj = store.get(e.baseOid);
      else {
        const baseEntry = byOffset.get(e.baseOffset as number);
        const baseStored = baseEntry ? resolvedOid.get(baseEntry.offset) : undefined;
        if (baseStored) baseObj = store.get(baseStored);
      }
      if (!baseObj) { nextPending.push(e); continue; }
      const applied = applyDelta(baseObj.buf, e.buf);
      resolvedOid.set(e.offset, store.store(baseObj.type, applied));
    }
    pending = nextPending;
  }
  return count;
}

/** Build a packfile holding the given objects whole (no deltas); the caller picks the set. */
const deflateCache = new WeakMap<Buffer, Buffer>();

/** Deflate an object body once; stored object buffers are immutable, so the result is reusable. */
function deflateCached(buf: Buffer): Buffer {
  let out = deflateCache.get(buf);
  if (!out) {
    out = deflateSync(buf);
    deflateCache.set(buf, out);
  }
  return out;
}

export function buildPack(store: ObjectStore, oids: readonly string[]): Buffer {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'utf8');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(oids.length, 8);
  const parts: Buffer[] = [head];
  for (const oid of oids) {
    const obj = store.get(oid);
    if (!obj) throw new Error(`pack: missing object ${oid}`);
    const typeNum = TYPE_NUM[obj.type];
    const size = obj.buf.length;
    const bytes: number[] = [];
    let first = (typeNum << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    bytes.push(first);
    while (rest > 0) {
      let b = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) b |= 0x80;
      bytes.push(b);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateCached(obj.buf));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * The closure of objects a fetch of `wants` needs, minus everything reachable from `haves`.
 * Commits are walked newest-first; trees and blobs follow their commits.
 */
export function fetchClosure(store: ObjectStore, wants: readonly string[], haves: ReadonlySet<string>): string[] {
  const haveCommits = new Set<string>();
  for (const h of haves) {
    const c = peelToCommit(store, h) ?? h;
    for (const a of ancestors(store, c)) haveCommits.add(a);
  }
  const out: string[] = [];
  const emitted = new Set<string>();
  const emitTree = (treeOid: string): void => {
    if (emitted.has(treeOid) || haveCommits.has(treeOid)) return;
    const obj = store.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    emitted.add(treeOid);
    out.push(treeOid);
    for (const e of parseTree(obj.buf)) {
      if (e.mode === '40000') emitTree(e.oid);
      else if (!emitted.has(e.oid)) { emitted.add(e.oid); out.push(e.oid); }
    }
  };
  const queue: string[] = [];
  const seenCommit = new Set<string>();
  for (const w of wants) {
    const c = peelToCommit(store, w);
    if (c && !haveCommits.has(c)) queue.push(c);
    else if (store.get(w)?.type === 'tag') { emitted.add(w); out.push(w); }
  }
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (seenCommit.has(cur) || haveCommits.has(cur)) continue;
    seenCommit.add(cur);
    const obj = store.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    emitted.add(cur);
    out.push(cur);
    const info = parseCommit(obj.buf);
    emitTree(info.tree);
    for (const p of info.parents) queue.push(p);
  }
  // Tags pointing at wanted commits ride along (only tag objects are scanned).
  for (const oid of store.tags) {
    if (emitted.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'tag') continue;
    const target = parseTag(obj.buf).object;
    if (emitted.has(target)) {
      emitted.add(oid);
      out.push(oid);
    }
  }
  return out;
}

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  data: Buffer;
}

/** Parse as many pkt-lines as the buffer holds; returns them plus the unparsed remainder. */
export function parsePkts(buf: Buffer): { pkts: Pkt[]; rest: Buffer } {
  const pkts: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const head = buf.toString('ascii', i, i + 4);
    if (!/^[0-9a-f]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) { pkts.push({ kind: 'flush', data: Buffer.alloc(0) }); i += 4; continue; }
    if (len === 1) { pkts.push({ kind: 'delim', data: Buffer.alloc(0) }); i += 4; continue; }
    if (len === 2) { pkts.push({ kind: 'response-end', data: Buffer.alloc(0) }); i += 4; continue; }
    if (len < 4 || i + len > buf.length) break;
    pkts.push({ kind: 'data', data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { pkts, rest: buf.subarray(i) };
}

/** Sideband-64k framing: band 1 carries data, band 2 progress text; ends with a flush. */
export function sideband(pack: Buffer, progress: readonly string[] = []): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65519 - 5;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const slice = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  for (const line of progress) parts.push(pktLine(Buffer.concat([Buffer.from([2]), Buffer.from(line, 'utf8')])));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/**
 * The sideband-framed pack for an object list, cached: a pack's bytes depend only on the
 * (immutable, content-addressed) objects it carries, so identical fetches — the clone
 * workload's 50 depth-1 clones of one tip — build it once. Bounded, oldest first out.
 */
const packCache = new WeakMap<ObjectStore, Map<string, Buffer>>();
const PACK_CACHE_MAX_ENTRIES = 32;
const PACK_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const PACK_CACHE_MAX_PACK_BYTES = 1024 * 1024;

export function packSideband(store: ObjectStore, oids: readonly string[]): Buffer {
  const key = oids.join(',');
  let perStore = packCache.get(store);
  if (perStore === undefined) {
    perStore = new Map<string, Buffer>();
    packCache.set(store, perStore);
  }
  const hit = perStore.get(key);
  if (hit !== undefined) return hit;
  const framed = sideband(buildPack(store, oids));
  if (framed.length <= PACK_CACHE_MAX_PACK_BYTES) {
    let total = 0;
    for (const value of perStore.values()) total += value.length;
    while (perStore.size > 0 && (perStore.size >= PACK_CACHE_MAX_ENTRIES || total + framed.length > PACK_CACHE_MAX_BYTES)) {
      const oldest = perStore.keys().next().value as string;
      total -= perStore.get(oldest)?.length ?? 0;
      perStore.delete(oldest);
    }
    perStore.set(key, framed);
  }
  return framed;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export { inflateSync };

// ---------------------------------------------------------------- fetch planning

export interface FetchPlan {
  /** Object ids to pack, in a valid order (tags and commits before their trees). */
  objects: string[];
  /** Boundary commits of the sent history (cut parents), to report as shallow. */
  shallow: string[];
  /** Client shallow oids that this fetch completes, to report as unshallow. */
  unshallow: string[];
}

/**
 * Plan a fetch: the objects reachable from `wants` (peeled), excluding everything reachable
 * from `haves`/`exclude`, optionally cut at `maxDepth` generations or at a `sinceTs` committer
 * time. The cut commits are the shallow boundary.
 */
export function planFetch(
  store: ObjectStore,
  wants: readonly string[],
  haves: readonly string[],
  opts: { maxDepth?: number; sinceTs?: number; exclude?: readonly string[]; clientShallow?: ReadonlySet<string> } = {},
): FetchPlan {
  const clientShallowSet = new Set<string>();
  for (const s of opts.clientShallow ?? []) clientShallowSet.add(peelToCommit(store, s) ?? s);
  const haveCommits = new Set<string>();
  const haveObjects = new Set<string>();
  const addClosure = (tip: string, commits: Set<string>, objects: Set<string>): void => {
    const commit = peelToCommit(store, tip) ?? tip;
    // Walk ancestry, but never descend below a commit the client holds as a shallow
    // boundary: it has that commit and its tree, and nothing underneath.
    const queue = [commit];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const a = queue.shift() as string;
      if (seen.has(a)) continue;
      seen.add(a);
      const obj = store.get(a);
      if (!obj || obj.type !== 'commit') continue;
      commits.add(a);
      objects.add(a);
      const walk = (treeOid: string): void => {
        if (objects.has(treeOid)) return;
        const t = store.get(treeOid);
        if (!t || t.type !== 'tree') return;
        objects.add(treeOid);
        for (const e of parseTree(t.buf)) {
          if (e.mode === '40000') walk(e.oid);
          else objects.add(e.oid);
        }
      };
      walk(parseCommit(obj.buf).tree);
      if (clientShallowSet.has(a)) continue;
      for (const p of parseCommit(obj.buf).parents) queue.push(p);
    }
    if (store.get(tip)?.type === 'tag') objects.add(tip);
  };
  for (const h of haves) addClosure(h, haveCommits, haveObjects);
  const excludeCommits = new Set<string>();
  for (const e of opts.exclude ?? []) {
    const c = peelToCommit(store, e) ?? e;
    for (const a of ancestors(store, c)) excludeCommits.add(a);
  }

  // The client's shallow boundary: it already holds those commits and their trees, but not
  // their parents. They are walked through (for a deepen) without being re-sent.
  const presentCommits = new Set<string>();
  for (const s of opts.clientShallow ?? []) {
    const c = peelToCommit(store, s) ?? s;
    presentCommits.add(c);
    const obj = store.get(c);
    if (obj && obj.type === 'commit') {
      const walk = (treeOid: string): void => {
        if (haveObjects.has(treeOid)) return;
        const t = store.get(treeOid);
        if (!t || t.type !== 'tree') return;
        haveObjects.add(treeOid);
        for (const e of parseTree(t.buf)) {
          if (e.mode === '40000') walk(e.oid);
          else haveObjects.add(e.oid);
        }
      };
      walk(parseCommit(obj.buf).tree);
    }
  }

  const objects: string[] = [];
  const emitted = new Set<string>();
  const emit = (oid: string): void => {
    if (!emitted.has(oid) && !haveObjects.has(oid) && store.has(oid)) {
      emitted.add(oid);
      objects.push(oid);
    }
  };
  const emitTree = (treeOid: string): void => {
    if (emitted.has(treeOid) || haveObjects.has(treeOid)) return;
    const t = store.get(treeOid);
    if (!t || t.type !== 'tree') return;
    emit(treeOid);
    for (const e of parseTree(t.buf)) {
      if (e.mode === '40000') emitTree(e.oid);
      else emit(e.oid);
    }
  };

  // Breadth-first by generation from the wants.
  const gen = new Map<string, number>();
  const queue: Array<{ commit: string; g: number }> = [];
  for (const w of wants) {
    if (store.get(w)?.type === 'tag') emit(w);
    const c = peelToCommit(store, w);
    // A want the client holds as a shallow boundary is still walked (a deepen starts there);
    // a want it holds in full ends the walk at once.
    if (c && !excludeCommits.has(c) && (!haveCommits.has(c) || presentCommits.has(c))) queue.push({ commit: c, g: 1 });
  }
  const included = new Set<string>();
  const boundary = new Set<string>();
  while (queue.length > 0) {
    const { commit, g } = queue.shift() as { commit: string; g: number };
    const known = gen.get(commit);
    if (known !== undefined && known <= g) continue;
    gen.set(commit, g);
    if (haveCommits.has(commit) && !presentCommits.has(commit)) continue;
    const obj = store.get(commit);
    if (!obj || obj.type !== 'commit') continue;
    const info = parseCommit(obj.buf);
    let include = true;
    if (opts.maxDepth !== undefined && g > opts.maxDepth) include = false;
    if (opts.sinceTs !== undefined) {
      const match = / (\d+) [+-]\d{4}$/.exec(info.committer);
      const ts = match ? Number(match[1]) : 0;
      if (ts <= opts.sinceTs) include = false;
    }
    if (!include) {
      // A parent reached past the cut: the child that named it is the boundary.
      continue;
    }
    included.add(commit);
    if (!presentCommits.has(commit)) {
      emit(commit);
      emitTree(info.tree);
    }
    for (const p of info.parents) {
      if (haveCommits.has(p) || excludeCommits.has(p)) continue;
      queue.push({ commit: p, g: g + 1 });
    }
  }
  // Boundary: an included commit with a parent that exists but was not included (and is not
  // already the client's).
  for (const c of included) {
    const obj = store.get(c);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.buf).parents) {
      if (!included.has(p) && !haveCommits.has(p) && !excludeCommits.has(p) && store.has(p)) boundary.add(c);
    }
  }
  // Tags riding along on included commits (only tag objects are scanned).
  for (const oid of store.tags) {
    if (emitted.has(oid) || haveObjects.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'tag') continue;
    if (included.has(parseTag(obj.buf).object)) emit(oid);
  }
  const unshallow: string[] = [];
  for (const s of opts.clientShallow ?? []) {
    if (!boundary.has(s) && (included.has(s) || haveCommits.has(s))) unshallow.push(s);
  }
  return { objects, shallow: [...boundary], unshallow };
}
