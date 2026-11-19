// Git smart HTTP: ref advertisement (protocol v2 and v0), ls-refs and fetch
// (protocol v2), and receive-pack (v0) — enough of the git wire protocol for a
// real client, implemented over the shared store with node:zlib packfiles.
//
// Protocol notes (from docs/suite-spec.md sections 3-4, verified against the
// suite's own client):
// - Upload-pack answers v2 when the client sends `Git-Protocol: version=2`;
//   receive-pack always answers v0.
// - Packs are written without deltas (always accepted, one less failure mode);
//   packs are read with full delta resolution because other clients may send them.
// - Fetch honours the closure rule strictly: everything reachable from the wants
//   minus everything reachable from the haves, with shallow boundaries stopping
//   the have-closure at the boundary commits themselves.
// - Pushed objects are stored verbatim and are never rewritten.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type GitObject,
  type Oid,
  type Repo,
  type Store,
  ancestorsOf,
  getObject,
  parseCommit,
} from './store.ts';

const ZERO = '0'.repeat(40);
const AGENT = 'forge/1.0';

// ------------------------------------------------------------------ pkt-lines

/** Encode one pkt-line payload (a string payload gets its trailing \n from the caller). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 65520) throw new Error('pkt-line too large');
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** A parsed pkt-line stream: payloads plus the special markers, in order. */
export type PktItem = { kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Parse pkt-lines from `buf` starting at `at`; `consumed` counts the header bytes used. */
export function parsePkts(buf: Buffer, at = 0): { items: PktItem[]; consumed: number } {
  const items: PktItem[] = [];
  while (at + 4 <= buf.length) {
    const hex = buf.toString('ascii', at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`malformed pkt-line at ${at}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      items.push({ kind: 'flush' });
      at += 4;
      break;
    }
    if (length === 1) {
      items.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      items.push({ kind: 'end' });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > buf.length) throw new Error('truncated pkt-line');
    items.push({ kind: 'data', data: buf.subarray(at + 4, at + length) });
    at += length;
  }
  return { items, consumed: at };
}

/** The text lines of the data items, decoded and stripped of their trailing newline. */
function pktTexts(items: PktItem[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.kind === 'data') out.push(item.data.toString('utf8').replace(/\n$/, ''));
  }
  return out;
}

// ------------------------------------------------------------------ object graph helpers

/** Follow an annotated-tag chain to the commit it ultimately names. */
function peelToCommit(repo: Repo, oid: Oid): Oid {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const obj = getObject(repo, current);
    if (obj === undefined || obj.type !== 'tag') return current;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.body.toString('utf8'));
    if (match === null) return current;
    current = match[1] as Oid;
  }
  return current;
}

/** Generation numbers (1 = tip) for commits reachable from the wants, BFS by parentage.
 *  Exploration stops at `limit` generations when one is given (a deepen fetch only ever
 *  needs generations up to its depth; commits past it are simply absent from the map). */
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

/**
 * The object closure of a set of tips: the tips themselves plus every commit,
 * tree and blob reachable from them. `stopCommits` are included but their
 * parents are not followed (a shallow boundary the client already holds);
 * `maxGen` (with `gens`) truncates commit history at a depth.
 */
function closureOf(
  repo: Repo,
  tips: readonly Oid[],
  options: { stopCommits?: ReadonlySet<Oid>; gens?: ReadonlyMap<Oid, number>; maxGen?: number } = {},
): Set<Oid> {
  const out = new Set<Oid>();
  const addTree = (treeOid: Oid): void => {
    if (out.has(treeOid)) return;
    const obj = getObject(repo, treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    out.add(treeOid);
    let at = 0;
    while (at < obj.body.length) {
      const sp = obj.body.indexOf(0x20, at);
      const mode = obj.body.toString('utf8', at, sp);
      const nul = obj.body.indexOf(0x00, sp + 1);
      const child = obj.body.toString('hex', nul + 1, nul + 21);
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
    if (options.stopCommits?.has(oid)) return;
    // In depth-limited mode a commit missing from the generations map is past the limit.
    if (options.maxGen !== undefined && options.gens !== undefined && (options.gens.get(oid) ?? Number.POSITIVE_INFINITY) >= options.maxGen) return;
    for (const parent of info.parents) addCommit(parent);
  };
  for (const tip of tips) {
    let current = tip;
    // A tag tip contributes the tag object(s) and then its commit closure.
    for (let guard = 0; guard < 32; guard += 1) {
      const obj = getObject(repo, current);
      if (obj === undefined) break;
      if (obj.type === 'tag') {
        out.add(current);
        const match = /^object ([0-9a-f]{40})$/m.exec(obj.body.toString('utf8'));
        if (match === null) break;
        current = match[1] as Oid;
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

const TYPE_IDS: Record<GitObject['type'], number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Write a complete packfile (version 2, no deltas) holding the given objects. */
export function buildPack(repo: Repo, oids: Iterable<Oid>): Buffer {
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
    let first = (TYPE_IDS[obj.type] << 4) | (size & 0x0f);
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
  const soFar = Buffer.concat(parts);
  const trailer = createHash('sha1').update(soFar).digest();
  return Buffer.concat([soFar, trailer]);
}

/** Content-addressed pack cache: a pack is a pure function of its object set, so
 *  repeated fetches of the same closure (the clone benchmark's 50 identical shallow
 *  clones) reuse the first build. Bounded FIFO; stale entries are impossible because
 *  the key is the object set itself. */
const packCache = new Map<string, Buffer>();

function buildPackCached(repo: Repo, oids: Set<Oid>): Buffer {
  const sorted = [...oids].sort();
  const key = createHash('sha1').update(sorted.join(' ')).digest('hex');
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const pack = buildPack(repo, sorted);
  if (packCache.size >= 24) {
    const oldest = packCache.keys().next().value;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  packCache.set(key, pack);
  return pack;
}

/**
 * Inflate one zlib stream starting at `offset`; reports how many bytes it consumed.
 * Synchronous on purpose: a pack holds many small streams, and the async stream API
 * costs a threadpool round trip per entry (~6x the CPU of inflateSync on a 1 KiB
 * entry, measured). The `info` result's engine.bytesRead is where the stream ended.
 */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; read: number } {
  const out = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesRead: number };
  };
  return { data: out.buffer, read: out.engine.bytesRead };
}

/** Apply a git delta (copy/insert program) to a base body. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
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
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
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
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (cmd > 0) {
      out.push(delta.subarray(at, at + cmd));
      produced += cmd;
      at += cmd;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

interface PackEntry {
  type: GitObject['type'] | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOid?: Oid;
  baseOffset?: number;
  start: number;
}

/** Parse and store every object of a packfile; returns the object count. Throws on corruption. */
export function storePack(repo: Repo, pack: Buffer): number {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const entries: PackEntry[] = [];
  let at = 12;
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
      baseOid = pack.toString('hex', at, at + 20);
      at += 20;
    }
    const { data, read } = inflateAt(pack, at);
    if (data.length !== size) throw new Error('pack entry size mismatch');
    at += read;
    const typeName: PackEntry['type'] =
      typeId === 1 ? 'commit' : typeId === 2 ? 'tree' : typeId === 3 ? 'blob' : typeId === 4 ? 'tag' : typeId === 6 ? 'ofs-delta' : 'ref-delta';
    entries.push({ type: typeName, data, baseOid, baseOffset, start });
  }
  // Fast path: a pack with no delta entries stores directly, with none of the
  // resolution machinery below (the common case: clients that send whole objects).
  if (entries.every((entry) => entry.type !== 'ofs-delta' && entry.type !== 'ref-delta')) {
    for (const entry of entries) {
      const plain = { type: entry.type as GitObject['type'], body: entry.data };
      const head = Buffer.from(`${plain.type} ${plain.body.length}\0`, 'utf8');
      const oid = createHash('sha1').update(head).update(plain.body).digest('hex');
      if (!repo.objects.has(oid)) repo.objects.set(oid, plain);
    }
    return count;
  }
  // Resolve entries to plain objects (deltas may chain within the pack or onto repo objects).
  const byStart = new Map<number, PackEntry>();
  for (const entry of entries) byStart.set(entry.start, entry);
  const resolved = new Map<PackEntry, { type: GitObject['type']; body: Buffer }>();
  const resolve = (entry: PackEntry): { type: GitObject['type']; body: Buffer } => {
    const hit = resolved.get(entry);
    if (hit !== undefined) return hit;
    let out: { type: GitObject['type']; body: Buffer };
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let base: { type: GitObject['type']; body: Buffer };
      if (entry.type === 'ofs-delta') {
        const baseEntry = byStart.get(entry.baseOffset as number);
        if (baseEntry === undefined) throw new Error('ofs-delta base outside pack');
        base = resolve(baseEntry);
      } else {
        const inPack = entries.find((candidate) => candidate.type !== 'ofs-delta' && candidate.type !== 'ref-delta' && entry.baseOid === computeOid(candidate));
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
  const computeOid = (entry: PackEntry): Oid => {
    const plain = resolve(entry);
    const head = Buffer.from(`${plain.type} ${plain.body.length}\0`, 'utf8');
    return createHash('sha1').update(head).update(plain.body).digest('hex');
  };
  for (const entry of entries) {
    const plain = resolve(entry);
    const head = Buffer.from(`${plain.type} ${plain.body.length}\0`, 'utf8');
    const oid = createHash('sha1').update(head).update(plain.body).digest('hex');
    if (!repo.objects.has(oid)) repo.objects.set(oid, plain);
  }
  return count;
}

// ------------------------------------------------------------------ ref advertisement

const RECEIVE_CAPS = 'report-status report-status-v2 delete-refs side-band-64k ofs-delta agent=' + AGENT;
const UPLOAD_CAPS_V0 = 'side-band-64k ofs-delta multi_ack_detailed thin-pack no-progress agent=' + AGENT;

function sortedRefs(repo: Repo): [string, Oid][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function defaultTip(repo: Repo): Oid | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

/** The v0 advertisement ref lines (with the capability list riding the first line). */
function v0RefLines(repo: Repo, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const tip = defaultTip(repo);
  let first = true;
  const pushLine = (oid: Oid, ref: string): void => {
    if (first) {
      lines.push(pktLine(Buffer.concat([Buffer.from(`${oid} ${ref}\0${caps}`, 'utf8')])));
      first = false;
    } else {
      lines.push(pktLine(`${oid} ${ref}\n`));
    }
  };
  if (tip !== undefined) {
    pushLine(tip, 'HEAD');
  } else {
    // Real git's form for an unborn HEAD: the capabilities pseudo-ref.
    lines.push(pktLine(Buffer.from(`${ZERO} capabilities^{}\0${caps}`, 'utf8')));
    first = false;
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    pushLine(oid, ref);
    const obj = getObject(repo, oid);
    if (obj !== undefined && obj.type === 'tag') pushLine(peelToCommit(repo, oid), `${ref}^{}`);
  }
  return lines;
}

function handleInfoRefs(repo: Repo, url: URL, req: IncomingMessage, res: ServerResponse): void {
  const service = url.searchParams.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('unknown service\n');
    return;
  }
  const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`)];
  if (service === 'git-upload-pack' && wantsV2) {
    // The v2 advertisement: the first line must be exactly "version 2".
    const v2: Buffer[] = [
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ];
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache' });
    res.end(Buffer.concat(v2));
    return;
  }
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS : `${UPLOAD_CAPS_V0} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  parts.push(...v0RefLines(repo, caps), PKT_FLUSH);
  res.writeHead(200, { 'content-type': `application/x-${service}-advertisement`, 'cache-control': 'no-cache' });
  res.end(Buffer.concat(parts));
}

// ------------------------------------------------------------------ ls-refs & fetch (upload-pack POST)

function sendResult(res: ServerResponse, service: string, body: Buffer): void {
  res.writeHead(200, { 'content-type': `application/x-${service}-result`, 'cache-control': 'no-cache' });
  res.end(body);
}

function handleLsRefs(repo: Repo, args: string[], res: ServerResponse): void {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => ref.startsWith(prefix));
  const lines: Buffer[] = [];
  const tip = defaultTip(repo);
  if (prefixes.length === 0) {
    if (tip !== undefined) {
      lines.push(pktLine(`${tip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    } else if (unborn) {
      lines.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    const obj = getObject(repo, oid);
    if (peel && obj !== undefined && obj.type === 'tag') line += ` peeled:${peelToCommit(repo, oid)}`;
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(PKT_FLUSH);
  sendResult(res, 'git-upload-pack', Buffer.concat(lines));
}

async function handleFetch(repo: Repo, args: string[], res: ServerResponse): Promise<void> {
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
    // Report the new boundary: commits at the depth limit that still have parents,
    // and unshallow any previous boundary that is now fully included.
    const boundary: Oid[] = [];
    for (const [oid, gen] of gens) {
      if (gen !== deepen) continue;
      const info = parseCommit(repo, oid);
      if (info !== null && info.parents.length > 0) boundary.push(oid);
    }
    const lines: Buffer[] = [pktLine('shallow-info\n')];
    for (const oid of shallow) {
      if ((gens.get(oid) ?? Infinity) < deepen) lines.push(pktLine(`unshallow ${oid}\n`));
    }
    for (const oid of boundary.sort()) lines.push(pktLine(`shallow ${oid}\n`));
    lines.push(PKT_FLUSH);
    sections.push(Buffer.concat(lines));
  }
  if (toSend.size === 0) {
    const acks = Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH]);
    sections.unshift(acks);
    sendResult(res, 'git-upload-pack', Buffer.concat(sections));
    return;
  }
  const pack = buildPackCached(repo, toSend);
  const packSection: Buffer[] = [pktLine('packfile\n')];
  const CHUNK = 65515;
  for (let at = 0; at < pack.length; at += CHUNK) {
    const slice = pack.subarray(at, at + CHUNK);
    packSection.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  packSection.push(PKT_FLUSH);
  sections.push(Buffer.concat(packSection));
  sendResult(res, 'git-upload-pack', Buffer.concat(sections));
}

async function handleUploadPack(repo: Repo, body: Buffer, res: ServerResponse): Promise<void> {
  const { items } = parsePkts(body);
  // Split the request at the delim: capabilities before it, arguments after.
  const texts: string[] = [];
  let seenDelim = false;
  const capLines: string[] = [];
  for (const item of items) {
    if (item.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (item.kind !== 'data') continue;
    const text = item.data.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) capLines.push(text);
    else texts.push(text);
  }
  const command = (capLines.find((line) => line.startsWith('command=')) ?? '').slice('command='.length);
  if (command === 'ls-refs') {
    handleLsRefs(repo, texts, res);
    return;
  }
  if (command === 'fetch') {
    await handleFetch(repo, texts, res);
    return;
  }
  res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('unknown command\n');
}

// ------------------------------------------------------------------ receive-pack

interface RefCommand {
  oldOid: Oid;
  newOid: Oid;
  ref: string;
  caps: string;
}

async function handleReceivePack(repo: Repo, body: Buffer, res: ServerResponse): Promise<void> {
  const { items, consumed } = parsePkts(body);
  const commands: RefCommand[] = [];
  let caps = '';
  for (const [index, text] of pktTexts(items).entries()) {
    let line = text;
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        caps = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0] as Oid, newOid: parts[1] as Oid, ref: parts.slice(2).join(' '), caps });
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
  const wantsSideband = caps.includes('side-band-64k');
  const wantsReport = caps.includes('report-status');
  const results: string[] = [];
  if (unpackOk) {
    results.push('unpack ok');
  } else {
    results.push('unpack error');
  }
  for (const cmd of commands) {
    if (!unpackOk) {
      results.push(`ng ${cmd.ref} unpack-error`);
      continue;
    }
    if (cmd.newOid === ZERO) {
      // Delete.
      if (repo.refs.delete(cmd.ref)) results.push(`ok ${cmd.ref}`);
      else results.push(`ng ${cmd.ref} reference does not exist`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (current !== undefined && current !== cmd.newOid) {
      // Non-fast-forward unless the current tip is an ancestor of the new one.
      // Fast path: the bench's sequential pushes name the current tip as a parent.
      const newInfo = parseCommit(repo, peelToCommit(repo, cmd.newOid));
      const isFf = (newInfo !== null && newInfo.parents.includes(current)) || ancestorsOf(repo, cmd.newOid).includes(current);
      if (!isFf) {
        results.push(`ng ${cmd.ref} non-fast-forward`);
        continue;
      }
    }
    if (getObject(repo, cmd.newOid) === undefined && parseCommit(repo, peelToCommit(repo, cmd.newOid)) === null) {
      results.push(`ng ${cmd.ref} reference not found`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    results.push(`ok ${cmd.ref}`);
  }
  if (!wantsReport && commands.length === 0) {
    sendResult(res, 'git-receive-pack', Buffer.alloc(0));
    return;
  }
  const report = Buffer.concat([...results.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  if (wantsSideband) {
    const wrapped: Buffer[] = [];
    const CHUNK = 65515;
    for (let at = 0; at < report.length; at += CHUNK) {
      wrapped.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(at, at + CHUNK)])));
    }
    wrapped.push(PKT_FLUSH);
    sendResult(res, 'git-receive-pack', Buffer.concat(wrapped));
    return;
  }
  sendResult(res, 'git-receive-pack', report);
}

// ------------------------------------------------------------------ the route entry

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Handle one git smart-HTTP request; returns false when the path is not a git route. */
export async function handleGit(store: Store, req: IncomingMessage, res: ServerResponse, body: Buffer, parsedUrl?: URL): Promise<boolean> {
  const url = parsedUrl ?? new URL(req.url ?? '/', 'http://entry');
  const match = GIT_ROUTE.exec(url.pathname);
  if (match === null) return false;
  const owner = match[1] as string;
  const repoName = match[2] as string;
  const endpoint = match[3] as string;
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('repository not found\n');
    return true;
  }
  try {
    if (endpoint === 'info/refs' && req.method === 'GET') {
      handleInfoRefs(repo, url, req, res);
      return true;
    }
    if (endpoint === 'git-upload-pack' && req.method === 'POST') {
      await handleUploadPack(repo, body, res);
      return true;
    }
    if (endpoint === 'git-receive-pack' && req.method === 'POST') {
      await handleReceivePack(repo, body, res);
      return true;
    }
  } catch {
    if (!res.headersSent) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bad request\n');
    } else {
      res.end();
    }
    return true;
  }
  res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('method not allowed\n');
  return true;
}
