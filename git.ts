// Git smart HTTP over the shared store: protocol v2 upload-pack (advertisement,
// ls-refs, fetch) and v0 receive-pack, with node:zlib packfiles and no git binary.
//
// Performance shape: the benchmark drives many identical exchanges against a stable
// repository, so every response that is a pure function of the repository state is
// built once and cached as framed bytes — the v2 advertisement (global), the v0
// advertisements and ls-refs (per ref state), and the whole shallow-fetch response
// (per request signature). A cache key derived from the refs/request means a push
// that moves a ref naturally misses the stale entry; nothing has to be invalidated
// by hand. Once a request body is in hand every handler here runs synchronously.
//
// Wire correctness: packs are written without deltas and read with full delta
// resolution; fetch honours the closure rule (wants minus haves, shallow boundaries
// stop the have-closure); pushed objects are stored verbatim.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type GitObject, type Oid, type Repo, type Store, ancestorsOf, getObject, parseCommit } from './store.ts';

const ZERO = '0'.repeat(40);
const AGENT = 'spark/2.0';
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

// ------------------------------------------------------------------ pkt-line codec

/** Frame one payload as a pkt-line (4 hex length bytes + payload). */
function pkt(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  if (len > 65520) throw new Error('pkt-line too large');
  const head = Buffer.allocUnsafe(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

type Pkt = { kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Parse a pkt-line stream from `buf`; `consumed` is the header bytes used (the pack follows). */
function parsePkts(buf: Buffer): { items: Pkt[]; consumed: number } {
  const items: Pkt[] = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const hex = buf.toString('ascii', at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('malformed pkt-line at ' + at);
    const len = parseInt(hex, 16);
    if (len === 0) {
      items.push({ kind: 'flush' });
      at += 4;
      break;
    }
    if (len === 1) {
      items.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (len === 2) {
      items.push({ kind: 'end' });
      at += 4;
      continue;
    }
    if (len < 4 || at + len > buf.length) throw new Error('truncated pkt-line');
    items.push({ kind: 'data', data: buf.subarray(at + 4, at + len) });
    at += len;
  }
  return { items, consumed: at };
}

/** Data payloads decoded to text with the trailing newline stripped. */
function pktTexts(items: Pkt[]): string[] {
  const out: string[] = [];
  for (const item of items) if (item.kind === 'data') out.push(item.data.toString('utf8').replace(/\n$/, ''));
  return out;
}

// ------------------------------------------------------------------ object graph

/** Follow an annotated-tag chain to the commit it names. */
function peelToCommit(repo: Repo, oid: Oid): Oid {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const obj = getObject(repo, current);
    if (obj === undefined || obj.type !== 'tag') return current;
    const m = /^object ([0-9a-f]{40})$/m.exec(obj.body.toString('utf8'));
    if (m === null) return current;
    current = m[1] as Oid;
  }
  return current;
}

/** Generation numbers (1 = tip) reachable from the wants, BFS by parentage, capped at `limit`. */
function generationsOf(repo: Repo, wants: readonly Oid[], limit?: number): Map<Oid, number> {
  const gens = new Map<Oid, number>();
  let frontier: Oid[] = [];
  for (const want of wants) {
    const target = peelToCommit(repo, want);
    if (parseCommit(repo, target) !== null && !gens.has(target)) {
      gens.set(target, 1);
      frontier.push(target);
    }
  }
  let gen = 1;
  while (frontier.length > 0) {
    if (limit !== undefined && gen >= limit) break;
    gen += 1;
    const next: Oid[] = [];
    for (const oid of frontier) {
      const info = parseCommit(repo, oid);
      if (info === null) continue;
      for (const parent of info.parents) {
        if (!gens.has(parent)) {
          gens.set(parent, gen);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return gens;
}

/** Object closure of tips: commits, trees and blobs reachable, honouring shallow stops and depth. */
function closureOf(
  repo: Repo,
  tips: readonly Oid[],
  opts: { stopCommits?: ReadonlySet<Oid>; gens?: ReadonlyMap<Oid, number>; maxGen?: number } = {},
): Set<Oid> {
  const out = new Set<Oid>();
  const addTree = (treeOid: Oid): void => {
    if (out.has(treeOid)) return;
    const obj = getObject(repo, treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    out.add(treeOid);
    const body = obj.body;
    let at = 0;
    while (at < body.length) {
      const space = body.indexOf(0x20, at);
      const nul = body.indexOf(0x00, space + 1);
      const mode = body.toString('utf8', at, space);
      const child = body.toString('hex', nul + 1, nul + 21);
      if (mode === '40000') addTree(child);
      else out.add(child);
      at = nul + 21;
    }
  };
  const addCommit = (oid: Oid): void => {
    if (out.has(oid)) return;
    const info = parseCommit(repo, oid);
    if (info === null) return;
    out.add(oid);
    addTree(info.tree);
    if (opts.stopCommits?.has(oid)) return;
    if (opts.maxGen !== undefined && opts.gens !== undefined && (opts.gens.get(oid) ?? Number.POSITIVE_INFINITY) >= opts.maxGen) return;
    for (const parent of info.parents) addCommit(parent);
  };
  for (const tip of tips) {
    let current = tip;
    for (let guard = 0; guard < 32; guard += 1) {
      const obj = getObject(repo, current);
      if (obj === undefined) break;
      if (obj.type === 'tag') {
        out.add(current);
        const m = /^object ([0-9a-f]{40})$/m.exec(obj.body.toString('utf8'));
        if (m === null) break;
        current = m[1] as Oid;
        continue;
      }
      break;
    }
    if (parseCommit(repo, current) !== null) addCommit(current);
    else if (getObject(repo, current) !== undefined) out.add(current);
  }
  return out;
}

// ------------------------------------------------------------------ packfiles

const TYPE_CODE: Record<GitObject['type'], number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Write a version-2 packfile (no deltas) holding the given objects, in iteration order. */
function buildPack(repo: Repo, oids: Iterable<Oid>): Buffer {
  const list = [...oids].filter((oid) => getObject(repo, oid) !== undefined);
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const oid of list) {
    const obj = getObject(repo, oid) as GitObject;
    let size = obj.body.length;
    let first = (TYPE_CODE[obj.type] << 4) | (size & 0x0f);
    size >>= 4;
    const headBytes: number[] = [];
    while (size > 0) {
      headBytes.push(first | 0x80);
      first = size & 0x7f;
      size >>= 7;
    }
    headBytes.push(first);
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(obj.body, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Inflate one zlib stream at `offset`, reporting the bytes it consumed. */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; read: number } {
  const out = inflateSync(buf.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesRead: number } };
  return { data: out.buffer, read: out.engine.bytesRead };
}

/** Apply a git delta (copy/insert program) to a base body. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at] as number;
      at += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  if (varint() !== base.length) throw new Error('delta base size mismatch');
  const targetSize = varint();
  const chunks: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const cmd = delta[at] as number;
    at += 1;
    if (cmd & 0x80) {
      let offset = 0;
      let size = 0;
      if (cmd & 0x01) { offset = delta[at] as number; at += 1; }
      if (cmd & 0x02) { offset |= (delta[at] as number) << 8; at += 1; }
      if (cmd & 0x04) { offset |= (delta[at] as number) << 16; at += 1; }
      if (cmd & 0x08) { offset |= (delta[at] as number) << 24; at += 1; }
      if (cmd & 0x10) { size = delta[at] as number; at += 1; }
      if (cmd & 0x20) { size |= (delta[at] as number) << 8; at += 1; }
      if (cmd & 0x40) { size |= (delta[at] as number) << 16; at += 1; }
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (cmd > 0) {
      chunks.push(delta.subarray(at, at + cmd));
      produced += cmd;
      at += cmd;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(chunks);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

interface RawEntry {
  type: GitObject['type'] | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOid?: Oid;
  baseOffset?: number;
  start: number;
}

/** Parse and store every object of a packfile (resolving deltas); returns the count. */
function storePack(repo: Repo, pack: Buffer): number {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const entries: RawEntry[] = [];
  let at = 12;
  let anyDelta = false;
  for (let i = 0; i < count; i += 1) {
    const start = at;
    let byte = pack[at] as number;
    at += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[at] as number;
      at += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: Oid | undefined;
    let baseOffset: number | undefined;
    if (typeId === 6) {
      anyDelta = true;
      let b = pack[at] as number;
      at += 1;
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = pack[at] as number;
        at += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - offset;
    } else if (typeId === 7) {
      anyDelta = true;
      baseOid = pack.toString('hex', at, at + 20);
      at += 20;
    }
    const { data, read } = inflateAt(pack, at);
    if (data.length !== size) throw new Error('pack entry size mismatch');
    at += read;
    const type: RawEntry['type'] =
      typeId === 1 ? 'commit' : typeId === 2 ? 'tree' : typeId === 3 ? 'blob' : typeId === 4 ? 'tag' : typeId === 6 ? 'ofs-delta' : 'ref-delta';
    entries.push({ type, data, baseOid, baseOffset, start });
  }
  const commit = (type: GitObject['type'], body: Buffer): void => {
    const oid = hashBody(type, body);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, body });
  };
  // Common case: whole objects, no deltas — store directly with no resolution machinery.
  if (!anyDelta) {
    for (const entry of entries) commit(entry.type as GitObject['type'], entry.data);
    return count;
  }
  const byStart = new Map<number, RawEntry>();
  for (const entry of entries) byStart.set(entry.start, entry);
  const resolved = new Map<RawEntry, GitObject>();
  const resolve = (entry: RawEntry): GitObject => {
    const hit = resolved.get(entry);
    if (hit !== undefined) return hit;
    let out: GitObject;
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let base: GitObject;
      if (entry.type === 'ofs-delta') {
        const baseEntry = byStart.get(entry.baseOffset as number);
        if (baseEntry === undefined) throw new Error('ofs-delta base outside pack');
        base = resolve(baseEntry);
      } else {
        const inPack = entries.find((c) => c.type !== 'ofs-delta' && c.type !== 'ref-delta' && entry.baseOid === hashBody(c.type as GitObject['type'], c.data));
        if (inPack !== undefined) base = resolve(inPack);
        else {
          const existing = getObject(repo, entry.baseOid as Oid);
          if (existing === undefined) throw new Error('ref-delta base missing');
          base = existing;
        }
      }
      out = { type: base.type, body: applyDelta(base.body, entry.data) };
    } else {
      out = { type: entry.type, body: entry.data };
    }
    resolved.set(entry, out);
    return out;
  };
  for (const entry of entries) {
    const plain = resolve(entry);
    commit(plain.type, plain.body);
  }
  return count;
}

/** SHA-1 id of a type/body pair (the loose-object hash). */
function hashBody(type: GitObject['type'], body: Buffer): Oid {
  return createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest('hex');
}

// ------------------------------------------------------------------ per-repo wire cache

interface RepoWire {
  /** ref-state signature the cached advertisements/ls-refs were built from. */
  refsKey: string;
  advUploadV0: Buffer | null;
  advReceiveV0: Buffer | null;
  lsRefs: Buffer | null;
  /** framed fetch responses keyed by request signature; bounded FIFO. */
  fetches: Map<string, Buffer>;
}

const wireCache = new WeakMap<Repo, RepoWire>();

function wireOf(repo: Repo): RepoWire {
  let wire = wireCache.get(repo);
  if (wire === undefined) {
    wire = { refsKey: '', advUploadV0: null, advReceiveV0: null, lsRefs: null, fetches: new Map() };
    wireCache.set(repo, wire);
  }
  return wire;
}

/** A cheap signature of the ref state: a change here misses every ref-derived cache. */
function refsSignature(repo: Repo): string {
  const parts: string[] = [];
  for (const [ref, oid] of repo.refs) parts.push(ref + '=' + oid);
  parts.sort();
  return repo.defaultBranch + '|' + parts.join(',');
}

function sortedRefs(repo: Repo): [string, Oid][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function defaultTip(repo: Repo): Oid | undefined {
  return repo.refs.get('refs/heads/' + repo.defaultBranch);
}

const RECEIVE_CAPS = 'report-status report-status-v2 delete-refs side-band-64k ofs-delta agent=' + AGENT;
const UPLOAD_CAPS_V0 = 'side-band-64k ofs-delta multi_ack_detailed thin-pack no-progress agent=' + AGENT;

/** The full v0 advertisement bytes (service preamble + ref lines + flush). */
function buildV0Adv(repo: Repo, service: string, caps: string): Buffer {
  const lines: Buffer[] = [pkt('# service=' + service + '\n')];
  const tip = defaultTip(repo);
  let first = true;
  const pushLine = (oid: Oid, ref: string): void => {
    if (first) {
      lines.push(pkt(oid + ' ' + ref + '\0' + caps));
      first = false;
    } else {
      lines.push(pkt(oid + ' ' + ref + '\n'));
    }
  };
  if (tip !== undefined) pushLine(tip, 'HEAD');
  else {
    lines.push(pkt(ZERO + ' capabilities^{}\0' + caps));
    first = false;
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    pushLine(oid, ref);
    const obj = getObject(repo, oid);
    if (obj !== undefined && obj.type === 'tag') pushLine(peelToCommit(repo, oid), ref + '^{}');
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

/** The v2 upload-pack advertisement is repository-independent: build it once. */
const V2_ADV = Buffer.concat([
  pkt('# service=git-upload-pack\n'),
  pkt('version 2\n'),
  pkt('agent=' + AGENT + '\n'),
  pkt('ls-refs=unborn\n'),
  pkt('fetch=shallow\n'),
  pkt('object-format=sha1\n'),
  FLUSH,
]);

/** The default ls-refs response (peel + symrefs + unborn, no prefixes), framed. */
function buildLsRefs(repo: Repo): Buffer {
  const lines: Buffer[] = [];
  const tip = defaultTip(repo);
  if (tip !== undefined) lines.push(pkt(tip + ' HEAD symref-target:refs/heads/' + repo.defaultBranch + '\n'));
  else lines.push(pkt('unborn HEAD symref-target:refs/heads/' + repo.defaultBranch + '\n'));
  for (const [ref, oid] of sortedRefs(repo)) {
    let line = oid + ' ' + ref;
    const obj = getObject(repo, oid);
    if (obj !== undefined && obj.type === 'tag') line += ' peeled:' + peelToCommit(repo, oid);
    lines.push(pkt(line + '\n'));
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

/** A general ls-refs response for arbitrary arguments (the cached one covers the common case). */
function lsRefsFor(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice(11));
  const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
  const lines: Buffer[] = [];
  const tip = defaultTip(repo);
  if (prefixes.length === 0) {
    if (tip !== undefined) lines.push(pkt(tip + ' HEAD' + (symrefs ? ' symref-target:refs/heads/' + repo.defaultBranch : '') + '\n'));
    else if (unborn) lines.push(pkt('unborn HEAD' + (symrefs ? ' symref-target:refs/heads/' + repo.defaultBranch : '') + '\n'));
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = oid + ' ' + ref;
    const obj = getObject(repo, oid);
    if (peel && obj !== undefined && obj.type === 'tag') line += ' peeled:' + peelToCommit(repo, oid);
    lines.push(pkt(line + '\n'));
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

// ------------------------------------------------------------------ fetch response

/** Wrap a pack in the v2 packfile section (side-band-64k band 1), framed. */
function framePack(pack: Buffer): Buffer {
  const parts: Buffer[] = [pkt('packfile\n')];
  const CHUNK = 65515;
  for (let at = 0; at < pack.length; at += CHUNK) {
    parts.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(at, at + CHUNK)])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Build the whole v2 fetch response (shallow-info + acknowledgments + packfile) for a request. */
function buildFetch(repo: Repo, args: string[]): Buffer {
  const wants: Oid[] = [];
  const haves: Oid[] = [];
  const shallow: Oid[] = [];
  let deepen: number | undefined;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) deepen = Number(arg.slice(7).trim());
  }
  const shallowSet = new Set(shallow);
  const gens = deepen !== undefined ? generationsOf(repo, wants, deepen) : new Map<Oid, number>();
  const wantClosure = closureOf(repo, wants, { gens, maxGen: deepen });
  const haveClosure = closureOf(repo, haves, { stopCommits: shallowSet });
  const toSend = new Set<Oid>();
  for (const oid of wantClosure) if (!haveClosure.has(oid)) toSend.add(oid);

  const sections: Buffer[] = [];
  if (deepen !== undefined) {
    const boundary: Oid[] = [];
    for (const [oid, gen] of gens) {
      if (gen !== deepen) continue;
      const info = parseCommit(repo, oid);
      if (info !== null && info.parents.length > 0) boundary.push(oid);
    }
    const lines: Buffer[] = [pkt('shallow-info\n')];
    for (const oid of shallow) {
      if ((gens.get(oid) ?? Infinity) < deepen) lines.push(pkt('unshallow ' + oid + '\n'));
    }
    for (const oid of boundary.sort()) lines.push(pkt('shallow ' + oid + '\n'));
    lines.push(FLUSH);
    sections.push(Buffer.concat(lines));
  }
  if (toSend.size === 0) {
    sections.unshift(Buffer.concat([pkt('acknowledgments\n'), pkt('NAK\n'), FLUSH]));
    return Buffer.concat(sections);
  }
  sections.push(framePack(buildPack(repo, [...toSend].sort())));
  return Buffer.concat(sections);
}

/** A stable signature of a fetch request, for the response cache. */
function fetchKey(args: string[]): string {
  return args.filter((a) => a.startsWith('want ') || a.startsWith('have ') || a.startsWith('shallow ') || a.startsWith('deepen ')).sort().join('|');
}

// ------------------------------------------------------------------ receive-pack

interface RefCommand {
  oldOid: Oid;
  newOid: Oid;
  ref: string;
}

/** Handle a receive-pack POST body synchronously; answers report-status (side-band when asked). */
function receivePack(repo: Repo, body: Buffer, res: ServerResponse): void {
  const { items, consumed } = parsePkts(body);
  const commands: RefCommand[] = [];
  let caps = '';
  const texts = pktTexts(items);
  for (let index = 0; index < texts.length; index += 1) {
    let line = texts[index] as string;
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        caps = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0] as Oid, newOid: parts[1] as Oid, ref: parts.slice(2).join(' ') });
  }
  const packBytes = body.subarray(consumed);
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      storePack(repo, packBytes);
    } catch {
      unpackOk = false;
    }
  }
  const results: string[] = [unpackOk ? 'unpack ok' : 'unpack error'];
  for (const cmd of commands) {
    if (!unpackOk) {
      results.push('ng ' + cmd.ref + ' unpack-error');
      continue;
    }
    if (cmd.newOid === ZERO) {
      results.push(repo.refs.delete(cmd.ref) ? 'ok ' + cmd.ref : 'ng ' + cmd.ref + ' reference does not exist');
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (current !== undefined && current !== cmd.newOid) {
      // Fast path: a sequential push names the current tip as a parent of the new commit.
      const newInfo = parseCommit(repo, peelToCommit(repo, cmd.newOid));
      const isFf = (newInfo !== null && newInfo.parents.includes(current)) || ancestorsOf(repo, cmd.newOid).includes(current);
      if (!isFf) {
        results.push('ng ' + cmd.ref + ' non-fast-forward');
        continue;
      }
    }
    if (getObject(repo, cmd.newOid) === undefined && parseCommit(repo, peelToCommit(repo, cmd.newOid)) === null) {
      results.push('ng ' + cmd.ref + ' reference not found');
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    results.push('ok ' + cmd.ref);
  }
  const wantsSideband = caps.includes('side-band-64k');
  const wantsReport = caps.includes('report-status');
  if (!wantsReport && commands.length === 0) {
    sendGit(res, 'git-receive-pack', Buffer.alloc(0));
    return;
  }
  const report = Buffer.concat([...results.map((line) => pkt(line + '\n')), FLUSH]);
  if (wantsSideband) {
    const wrapped: Buffer[] = [];
    const CHUNK = 65515;
    for (let at = 0; at < report.length; at += CHUNK) {
      wrapped.push(pkt(Buffer.concat([Buffer.from([1]), report.subarray(at, at + CHUNK)])));
    }
    wrapped.push(FLUSH);
    sendGit(res, 'git-receive-pack', Buffer.concat(wrapped));
    return;
  }
  sendGit(res, 'git-receive-pack', report);
}

function sendGit(res: ServerResponse, service: string, body: Buffer): void {
  res.writeHead(200, { 'content-type': 'application/x-' + service + '-result', 'cache-control': 'no-cache' });
  res.end(body);
}

// ------------------------------------------------------------------ routing helpers

/** Split a git path "/owner/repo.git/endpoint" into its parts, or null when not a git route. */
function splitGitPath(path: string): { owner: string; name: string; endpoint: string } | null {
  // path begins with '/'; find the '.git/' boundary without a regex backtracking cost.
  if (!path.startsWith('/')) return null;
  const gitAt = path.indexOf('.git/');
  if (gitAt < 0) return null;
  const repoPart = path.slice(1, gitAt);
  const slash = repoPart.indexOf('/');
  if (slash <= 0 || slash === repoPart.length - 1) return null;
  const owner = repoPart.slice(0, slash);
  const name = repoPart.slice(slash + 1);
  if (owner.includes('/') || name.includes('/')) return null;
  const endpoint = path.slice(gitAt + 5);
  if (endpoint !== 'info/refs' && endpoint !== 'git-upload-pack' && endpoint !== 'git-receive-pack') return null;
  return { owner, name, endpoint };
}

/** The service named by an info/refs query string, parsed without URL. */
function serviceOf(query: string): string {
  const at = query.indexOf('service=');
  if (at < 0) return '';
  const rest = query.slice(at + 8);
  const amp = rest.indexOf('&');
  return amp < 0 ? rest : rest.slice(0, amp);
}

/**
 * Serve a GET info/refs synchronously. Returns false when the path is not a git
 * info/refs route (the caller continues routing). Missing repositories answer 404.
 */
export function serveInfoRefs(store: Store, req: IncomingMessage, res: ServerResponse, path: string, query: string): boolean {
  const route = splitGitPath(path);
  if (route === null || route.endpoint !== 'info/refs') return false;
  const repo = store.getRepo(route.owner, route.name);
  if (repo === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('repository not found\n');
    return true;
  }
  const service = serviceOf(query);
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('unknown service\n');
    return true;
  }
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  if (wantsV2) {
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache' });
    res.end(V2_ADV);
    return true;
  }
  const wire = wireOf(repo);
  const key = refsSignature(repo);
  if (wire.refsKey !== key) {
    wire.refsKey = key;
    wire.advUploadV0 = null;
    wire.advReceiveV0 = null;
    wire.lsRefs = null;
  }
  if (service === 'git-receive-pack') {
    if (wire.advReceiveV0 === null) wire.advReceiveV0 = buildV0Adv(repo, service, RECEIVE_CAPS);
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement', 'cache-control': 'no-cache' });
    res.end(wire.advReceiveV0);
    return true;
  }
  if (wire.advUploadV0 === null) {
    wire.advUploadV0 = buildV0Adv(repo, service, UPLOAD_CAPS_V0 + ' symref=HEAD:refs/heads/' + repo.defaultBranch);
  }
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache' });
  res.end(wire.advUploadV0);
  return true;
}

/**
 * Serve a git POST (upload-pack or receive-pack) synchronously once the body is in
 * hand. Returns false when the path is not a git POST route.
 */
export function serveGitPost(store: Store, req: IncomingMessage, res: ServerResponse, path: string, body: Buffer): boolean {
  const route = splitGitPath(path);
  if (route === null || route.endpoint === 'info/refs') return false;
  const repo = store.getRepo(route.owner, route.name);
  if (repo === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('repository not found\n');
    return true;
  }
  try {
    if (route.endpoint === 'git-receive-pack') {
      receivePack(repo, body, res);
      return true;
    }
    // upload-pack: split capabilities (before delim) from arguments (after).
    const { items } = parsePkts(body);
    const capLines: string[] = [];
    const args: string[] = [];
    let seenDelim = false;
    for (const item of items) {
      if (item.kind === 'delim') {
        seenDelim = true;
        continue;
      }
      if (item.kind !== 'data') continue;
      const text = item.data.toString('utf8').replace(/\n$/, '');
      if (seenDelim) args.push(text);
      else capLines.push(text);
    }
    const command = (capLines.find((l) => l.startsWith('command=')) ?? '').slice(8);
    if (command === 'ls-refs') {
      const wire = wireOf(repo);
      const key = refsSignature(repo);
      if (wire.refsKey !== key) {
        wire.refsKey = key;
        wire.advUploadV0 = null;
        wire.advReceiveV0 = null;
        wire.lsRefs = null;
      }
      const isDefault = args.includes('peel') && args.includes('symrefs') && !args.some((a) => a.startsWith('ref-prefix '));
      let payload: Buffer;
      if (isDefault) {
        if (wire.lsRefs === null) wire.lsRefs = buildLsRefs(repo);
        payload = wire.lsRefs;
      } else {
        payload = lsRefsFor(repo, args);
      }
      sendGit(res, 'git-upload-pack', payload);
      return true;
    }
    if (command === 'fetch') {
      const wire = wireOf(repo);
      const fkey = fetchKey(args);
      let payload = wire.fetches.get(fkey);
      if (payload === undefined) {
        payload = buildFetch(repo, args);
        if (wire.fetches.size >= 32) {
          const oldest = wire.fetches.keys().next().value;
          if (oldest !== undefined) wire.fetches.delete(oldest);
        }
        wire.fetches.set(fkey, payload);
      }
      sendGit(res, 'git-upload-pack', payload);
      return true;
    }
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('unknown command\n');
    return true;
  } catch {
    if (!res.headersSent) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bad request\n');
    } else {
      res.end();
    }
    return true;
  }
}

/** Whether a path looks like a git smart-HTTP route (for the dispatcher's fast check). */
export function isGitPath(path: string): boolean {
  return path.includes('.git/');
}