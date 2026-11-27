/**
 * Reference layout retrieval (RFC 11 §8.6, implementation spec §7.2b), the
 * local sources: native KiCad boards on this machine (KiCad demos, the PCBench
 * qualification boards, the repo's reference boards, `pcb.referenceDesigns`)
 * and RFC 1 teardown outputs (`pcb.teardownCorpus`). For every block anchor,
 * candidate blocks are cut from the source around a similar part, scored,
 * cached under `.copperhead/layout-refs/`, and gated by the license policy.
 * Network sources (datasheet figures, GitHub) are Phase 4 and need a model;
 * nothing here calls one.
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { copperStack } from '../ir/layers.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { uuidv5 } from '../../kicad/emit.js';
import type { PcbDesign, ComponentInstance, Nm, Mdeg } from '../ir/types.js';
import { importBoard } from '../ir/kicad/import.js';
import { rotatePoint } from '../ir/geometry.js';
import { normMdeg } from '../ir/units.js';
import { normalizeLicense, needsApproval } from './licenses.js';
import { isConnector, type Block } from './blocks.js';
import type { LayoutBlockSpec } from '../engines/placers/layout-reuse/adapter.js';

const CUT_RADIUS_NM = 15_000_000;

export interface ReferenceBlock {
  id: string;
  source: { kind: 'datasheet' | 'design' | 'teardown'; locator: string; commit?: string; retrieved: string; contentHash: string; license: string };
  anchor: { role: string; mpn?: string; footprint?: string; libId?: string; ref: string };
  members: { role: string; ref: string; footprint?: string; value?: string; rel: { x: Nm; y: Nm; rotation: Mdeg }; side: 'front' | 'back' }[];
  edges: { fromRole: string; fromPad: string; toRole: string; toPad: string; net: string }[];
  rules: { text: string; ref: string; to: string; max_distance_nm: number }[];
  similarity: { score: number; mpn: boolean; family: boolean; footprint: boolean; pattern: boolean; connectors: number; boardClass: boolean };
  confidence: number;
  approvedBy?: string;
  /** Target anchor this block was retrieved for (component id) and the target refdes per member role. */
  target: { anchorId: string; anchorRef: string; memberRefs: Record<string, string> };
}

export interface ReferenceSource {
  id: string;
  kind: 'datasheet' | 'design' | 'teardown';
  network: boolean;
  search(query: AnchorQuery): Promise<ReferenceBlock[]>;
}

export interface AnchorQuery {
  design: PcbDesign;
  anchor: ComponentInstance;
  /** The anchor's block members in the target design, for role mapping. */
  members: ComponentInstance[];
}

function hashText(t: string): string {
  return createHash('sha256').update(t).digest('hex');
}

/** A part-number-looking value: letters and digits, 5+ chars, not a plain quantity like 10k or 100nF. */
function looksLikeMpn(v: string): boolean {
  return /[A-Za-z]/.test(v) && /\d/.test(v) && v.replace(/[^A-Za-z0-9]/g, '').length >= 5 && !/^\d+(\.\d+)?\s*[kKmMuUnNpPrRfFhHvVaA]?[FHΩRohm]*$/.test(v.trim());
}

function familyKey(v: string): string {
  return v.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 5);
}

const copperLayers = (d: PcbDesign) => copperStack(d).length;

/** Cut a block out of `src` around `srcAnchor`: every part sharing a net with it within 15 mm. */
export function cutBlock(src: PcbDesign, srcAnchor: ComponentInstance): { members: ComponentInstance[]; edges: ReferenceBlock['edges'] } {
  const compOfPad = new Map<string, ComponentInstance>();
  for (const c of src.components) for (const p of c.pads) compOfPad.set(p.id, c);
  const padById = new Map(src.components.flatMap((c) => c.pads.map((p) => [p.id, p] as const)));
  const near = new Map<string, ComponentInstance>();
  const edges: ReferenceBlock['edges'] = [];
  for (const n of src.nets) {
    const anchorPads = n.padIds.filter((pid) => compOfPad.get(pid)?.id === srcAnchor.id);
    if (!anchorPads.length) continue;
    for (const pid of n.padIds) {
      const c = compOfPad.get(pid);
      if (!c || c.id === srcAnchor.id) continue;
      if (Math.hypot(c.at.x - srcAnchor.at.x, c.at.y - srcAnchor.at.y) > CUT_RADIUS_NM) continue;
      near.set(c.id, c);
      edges.push({ fromRole: srcAnchor.reference, fromPad: padById.get(anchorPads[0]!)?.number ?? '', toRole: c.reference, toPad: padById.get(pid)?.number ?? '', net: n.name });
    }
  }
  return { members: [...near.values()], edges };
}

/** Map the reference block's members onto the target block's members by footprint then value; unmapped members are dropped. */
function mapRoles(refMembers: ComponentInstance[], target: ComponentInstance[]): Map<string, ComponentInstance> {
  const free = [...target];
  const out = new Map<string, ComponentInstance>();
  for (const m of refMembers) {
    let i = free.findIndex((t) => t.footprint.libId === m.footprint.libId && t.value.toLowerCase() === m.value.toLowerCase());
    if (i < 0) i = free.findIndex((t) => t.footprint.libId === m.footprint.libId);
    if (i < 0) i = free.findIndex((t) => t.reference[0] === m.reference[0] && t.pads.length === m.pads.length);
    if (i < 0) continue;
    out.set(m.id, free[i]!);
    free.splice(i, 1);
  }
  return out;
}

export function similarity(q: AnchorQuery, src: PcbDesign, srcAnchor: ComponentInstance, cut: ReturnType<typeof cutBlock>, mapped: Map<string, ComponentInstance>): ReferenceBlock['similarity'] {
  const mpn = looksLikeMpn(q.anchor.value) && q.anchor.value.trim().toLowerCase() === srcAnchor.value.trim().toLowerCase();
  const family = !mpn && familyKey(q.anchor.value) === familyKey(srcAnchor.value) && familyKey(q.anchor.value).length >= 4;
  const footprint = q.anchor.footprint.libId === srcAnchor.footprint.libId || (q.anchor.pads.length === srcAnchor.pads.length && q.anchor.pads.length >= 8);
  const pattern = cut.members.length > 0 && mapped.size >= Math.ceil(cut.members.length / 2);
  const connectors = cut.members.filter(isConnector).length;
  const boardClass = copperLayers(src) === copperLayers(q.design);
  let score = mpn ? 1 : family && footprint ? 0.7 : pattern ? 0.5 : 0;
  score += 0.1 * (Math.min(connectors, 3) / 3) + (boardClass ? 0.1 : 0);
  return { score: Math.min(1, score), mpn, family, footprint, pattern, connectors, boardClass };
}

/** Build a ReferenceBlock from a source board around one of its parts, for the query's anchor. */
export function blockFromDesign(q: AnchorQuery, src: PcbDesign, srcAnchor: ComponentInstance, source: { locator: string; license: string; contentHash: string }, now: string): ReferenceBlock | null {
  const cut = cutBlock(src, srcAnchor);
  if (!cut.members.length) return null;
  const mapped = mapRoles(cut.members, q.members.filter((m) => m.id !== q.anchor.id));
  const sim = similarity(q, src, srcAnchor, cut, mapped);
  if (sim.score < 0.5) return null;
  const members = cut.members.filter((m) => mapped.has(m.id)).map((m) => {
    const d = rotatePoint({ x: m.at.x - srcAnchor.at.x, y: m.at.y - srcAnchor.at.y }, -srcAnchor.rotation);
    return { role: m.reference, ref: m.reference, footprint: m.footprint.libId, value: m.value, rel: { x: Math.round(d.x), y: Math.round(d.y), rotation: normMdeg(m.rotation - srcAnchor.rotation) }, side: m.attributes.side };
  });
  if (!members.length) return null;
  const id = uuidv5(`layout-ref/design/${source.locator}/${srcAnchor.reference}/${q.anchor.id}`);
  const memberRefs: Record<string, string> = {};
  for (const [srcId, tgt] of mapped) memberRefs[cut.members.find((m) => m.id === srcId)!.reference] = tgt.reference;
  return {
    id,
    source: { kind: 'design', locator: source.locator, retrieved: now, contentHash: source.contentHash, license: normalizeLicense(source.license) },
    anchor: { role: srcAnchor.reference, ref: srcAnchor.reference, ...(looksLikeMpn(srcAnchor.value) ? { mpn: srcAnchor.value } : {}), footprint: srcAnchor.footprint.libId },
    members,
    edges: cut.edges.filter((e) => mapped.has(cut.members.find((m) => m.reference === e.toRole)?.id ?? '')),
    rules: [],
    similarity: sim,
    confidence: Math.min(1, 0.4 + 0.6 * sim.score),
    target: { anchorId: q.anchor.id, anchorRef: q.anchor.reference, memberRefs },
  };
}

/** Candidate source parts in a board: same footprint, or same pad count for ICs. */
function candidateAnchors(src: PcbDesign, anchor: ComponentInstance): ComponentInstance[] {
  return src.components.filter((c) => c.footprint.libId === anchor.footprint.libId || (c.pads.length === anchor.pads.length && anchor.pads.length >= 8 && !isConnector(c)));
}

export interface LocalBoard {
  path: string;
  license: string;
  /** 'user' for the user's own boards (`pcb.referenceDesigns`): applied without approval. */
  approvedBy?: string;
}

/** The `design` source over local boards. */
export class LocalDesignSource implements ReferenceSource {
  readonly id = 'design-local';
  readonly kind = 'design' as const;
  readonly network = false;
  private cache = new Map<string, { design: PcbDesign; hash: string } | null>();
  constructor(private readonly boards: LocalBoard[], private readonly now = new Date().toISOString()) {}
  private async load(p: string): Promise<{ design: PcbDesign; hash: string } | null> {
    if (this.cache.has(p)) return this.cache.get(p)!;
    let out: { design: PcbDesign; hash: string } | null = null;
    try {
      const text = await readFile(p, 'utf8');
      out = { design: importBoard({ boardText: text, boardPath: p, now: 'ref' }).design, hash: hashText(text) };
    } catch {
      out = null;
    }
    this.cache.set(p, out);
    return out;
  }
  async search(q: AnchorQuery): Promise<ReferenceBlock[]> {
    const out: ReferenceBlock[] = [];
    for (const b of this.boards) {
      const loaded = await this.load(b.path);
      if (!loaded) continue;
      for (const srcAnchor of candidateAnchors(loaded.design, q.anchor)) {
        const block = blockFromDesign(q, loaded.design, srcAnchor, { locator: b.path, license: b.license, contentHash: loaded.hash }, this.now);
        if (block) out.push(b.approvedBy ? { ...block, approvedBy: b.approvedBy } : block);
      }
    }
    return out;
  }
}

/**
 * The `teardown` source over RFC 1 outputs. RFC 1 fixes the file names, not the
 * fields; copperhead reads `placement-analysis.yaml` / `circuit-patterns.yaml`
 * (JSON or YAML) with this shape:
 *   patterns: [{ id, name?, license?, anchor: { role, mpn?, footprint? },
 *                members: [{ role, footprint?, value?, rel_mm: [x, y], rotation_deg?, side? }],
 *                rules: [{ text, ref: <role>, to: <role or role.pin>, max_distance_mm }] }]
 */
export class TeardownSource implements ReferenceSource {
  readonly id = 'teardown-local';
  readonly kind = 'teardown' as const;
  readonly network = false;
  constructor(private readonly dirs: string[], private readonly now = new Date().toISOString()) {}
  private async patterns(): Promise<{ file: string; hash: string; pattern: TeardownPattern }[]> {
    const out: { file: string; hash: string; pattern: TeardownPattern }[] = [];
    for (const dir of this.dirs) {
      for (const f of await walk(dir, /(placement-analysis|circuit-patterns)\.(ya?ml|json)$/)) {
        try {
          const text = await readFile(f, 'utf8');
          const doc = await parseYamlOrJson(text);
          for (const p of (doc as { patterns?: TeardownPattern[] })?.patterns ?? []) out.push({ file: f, hash: hashText(text), pattern: p });
        } catch {
          // an unreadable file is skipped; the report lists sources that yielded nothing
        }
      }
    }
    return out;
  }
  async search(q: AnchorQuery): Promise<ReferenceBlock[]> {
    const out: ReferenceBlock[] = [];
    for (const { file, hash, pattern } of await this.patterns()) {
      const a = pattern.anchor;
      const mpn = !!a.mpn && looksLikeMpn(q.anchor.value) && a.mpn.trim().toLowerCase() === q.anchor.value.trim().toLowerCase();
      const footprint = !!a.footprint && a.footprint === q.anchor.footprint.libId;
      const family = !mpn && !!a.mpn && familyKey(a.mpn) === familyKey(q.anchor.value) && familyKey(q.anchor.value).length >= 4;
      // members map by footprint then value onto the target block
      const free = q.members.filter((m) => m.id !== q.anchor.id);
      const memberRefs: Record<string, string> = {};
      const members: ReferenceBlock['members'] = [];
      for (const m of pattern.members ?? []) {
        let i = free.findIndex((t) => (m.footprint && t.footprint.libId === m.footprint) || (m.value && t.value.toLowerCase() === m.value.toLowerCase()));
        if (i < 0) continue;
        const t = free.splice(i, 1)[0]!;
        memberRefs[m.role] = t.reference;
        members.push({ role: m.role, ref: t.reference, ...(m.footprint ? { footprint: m.footprint } : {}), ...(m.value ? { value: m.value } : {}), rel: { x: Math.round((m.rel_mm?.[0] ?? 0) * 1e6), y: Math.round((m.rel_mm?.[1] ?? 0) * 1e6), rotation: normMdeg(Math.round((m.rotation_deg ?? 0) * 1000)) }, side: m.side === 'back' ? 'back' : 'front' });
      }
      const pattern_ = members.length > 0 && members.length >= Math.ceil((pattern.members?.length ?? 1) / 2);
      if (!mpn && !(family && footprint) && !pattern_) continue;
      let score = mpn ? 1 : family && footprint ? 0.7 : 0.5;
      score += copperLayers(q.design) === 2 ? 0.1 : 0;
      const rules = (pattern.rules ?? []).filter((r) => !!memberRefs[r.ref] && (r.to.split('.')[0] === a.role || !!memberRefs[r.to.split('.')[0]!])).map((r) => ({ text: r.text, ref: memberRefs[r.ref]!, to: r.to.split('.')[0] === a.role ? `${q.anchor.reference}${r.to.includes('.') ? '.' + r.to.split('.')[1] : ''}` : memberRefs[r.to.split('.')[0]!]!, max_distance_nm: Math.round((r.max_distance_mm ?? 2) * 1e6) }));
      out.push({
        id: uuidv5(`layout-ref/teardown/${file}/${pattern.id}/${q.anchor.id}`),
        source: { kind: 'teardown', locator: `${file}#${pattern.id}`, retrieved: this.now, contentHash: hash, license: normalizeLicense(pattern.license ?? 'unknown') },
        anchor: { role: a.role, ref: a.role, ...(a.mpn ? { mpn: a.mpn } : {}), ...(a.footprint ? { footprint: a.footprint } : {}) },
        members,
        edges: [],
        rules,
        similarity: { score: Math.min(1, score), mpn, family, footprint, pattern: pattern_, connectors: 0, boardClass: copperLayers(q.design) === 2 },
        confidence: Math.min(1, 0.3 + 0.6 * Math.min(1, score)),
        target: { anchorId: q.anchor.id, anchorRef: q.anchor.reference, memberRefs },
      });
    }
    return out;
  }
}

interface TeardownPattern {
  id: string;
  name?: string;
  license?: string;
  anchor: { role: string; mpn?: string; footprint?: string };
  members?: { role: string; footprint?: string; value?: string; rel_mm?: [number, number]; rotation_deg?: number; side?: string }[];
  rules?: { text: string; ref: string; to: string; max_distance_mm?: number }[];
}

async function parseYamlOrJson(text: string): Promise<unknown> {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) return JSON.parse(t);
  const yaml = await import('yaml');
  return yaml.parse(text);
}

async function walk(dir: string, pattern: RegExp, depth = 4): Promise<string[]> {
  if (!existsSync(dir) || depth < 0) return [];
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, pattern, depth - 1)));
    else if (pattern.test(e.name)) out.push(p);
  }
  return out;
}

/** The local boards copperhead knows about, with the license it can vouch for. */
export async function localBoards(repoRoot: string, opts: { referenceDesigns?: string[]; pcbenchLicenses?: Record<string, string> } = {}): Promise<LocalBoard[]> {
  const out: LocalBoard[] = [];
  for (const rel of opts.referenceDesigns ?? []) {
    const p = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
    if (p.endsWith('.kicad_pcb')) out.push({ path: p, license: 'user', approvedBy: 'user' });
    else for (const f of await walk(p, /\.kicad_pcb$/)) out.push({ path: f, license: 'user', approvedBy: 'user' });
  }
  for (const d of ['manual-tests/reference-boards', 'manual-tests/runs/reference-boards']) for (const f of await walk(path.join(repoRoot, d), /\.kicad_pcb$/)) out.push({ path: f, license: 'Apache-2.0' });
  const upgraded = path.join(repoRoot, 'bench', 'var', 'corpora', 'pcbench-upgraded');
  for (const f of await walk(upgraded, /\.kicad_pcb$/, 1)) {
    const id = path.basename(f, '.kicad_pcb');
    out.push({ path: f, license: opts.pcbenchLicenses?.[id] ?? 'unknown' });
  }
  for (const f of await walk('/usr/share/kicad/demos', /\.kicad_pcb$/)) out.push({ path: f, license: 'unknown' });
  return out;
}

export interface FindOptions {
  repoRoot: string;
  sources: ReferenceSource[];
  /** Search anchors that already have a cached block too. */
  refresh?: boolean;
  maxPerAnchor?: number;
  now?: string;
}

export interface FindResult {
  /** Best blocks per anchor, best first. */
  blocks: ReferenceBlock[];
  /** Blocks whose license needs an approver before they apply. */
  holds: ReferenceBlock[];
  searched: number;
  fromCache: number;
}

export function cacheDir(repoRoot: string): string {
  return path.join(repoRoot, '.copperhead', 'layout-refs');
}

export async function readCache(repoRoot: string): Promise<ReferenceBlock[]> {
  const dir = cacheDir(repoRoot);
  if (!existsSync(dir)) return [];
  const out: ReferenceBlock[] = [];
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    try {
      out.push(JSON.parse(await readFile(path.join(dir, f), 'utf8')) as ReferenceBlock);
    } catch {
      // a corrupt cache entry is ignored; --refresh rewrites it
    }
  }
  return out;
}

export async function writeCache(repoRoot: string, blocks: ReferenceBlock[]): Promise<void> {
  const dir = cacheDir(repoRoot);
  await mkdir(dir, { recursive: true });
  const all = new Map((await readCache(repoRoot)).map((b) => [b.id, b]));
  for (const b of blocks) all.set(b.id, b);
  for (const b of blocks) await writeFile(path.join(dir, `${b.id}.json`), JSON.stringify(b, null, 2), 'utf8');
  const index = [...all.values()].map((b) => ({ id: b.id, anchor: b.target.anchorRef, source: b.source.locator, score: b.similarity.score, license: b.source.license, approvedBy: b.approvedBy ?? null })).sort((a, b) => a.anchor.localeCompare(b.anchor) || b.score - a.score);
  await writeFile(path.join(dir, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
}

export async function approveReference(repoRoot: string, id: string, approver: string): Promise<ReferenceBlock | null> {
  const b = (await readCache(repoRoot)).find((x) => x.id === id);
  if (!b) return null;
  b.approvedBy = approver;
  await writeCache(repoRoot, [b]);
  return b;
}

const AUTHORITY = { datasheet: 3, teardown: 2, design: 1 } as const;

export async function findReferences(design: PcbDesign, blocks: Block[], opts: FindOptions): Promise<FindResult> {
  const cached = await readCache(opts.repoRoot);
  const found: ReferenceBlock[] = [];
  let searched = 0, fromCache = 0;
  for (const b of blocks) {
    if (!b.anchor || b.id === 'unassigned') continue;
    const anchor = design.components.find((c) => c.id === b.anchor);
    if (!anchor) continue;
    const have = cached.filter((r) => r.target.anchorId === anchor.id);
    if (have.length && !opts.refresh) {
      found.push(...have);
      fromCache += have.length;
      continue;
    }
    searched++;
    const members = b.members.map((id) => design.components.find((c) => c.id === id)!).filter(Boolean);
    const q: AnchorQuery = { design, anchor, members };
    const hits: ReferenceBlock[] = [];
    for (const s of opts.sources) hits.push(...(await s.search(q)));
    hits.sort((x, y) => y.similarity.score - x.similarity.score || AUTHORITY[y.source.kind] - AUTHORITY[x.source.kind]);
    const keep = hits.slice(0, opts.maxPerAnchor ?? 5);
    // an existing approval survives a refresh
    for (const k of keep) {
      const prev = cached.find((c) => c.id === k.id);
      if (prev?.approvedBy) k.approvedBy = prev.approvedBy;
    }
    await writeCache(opts.repoRoot, keep);
    found.push(...keep);
  }
  const holds = found.filter((r) => needsApproval(r.source.license) && !r.approvedBy);
  return { blocks: found, holds, searched, fromCache };
}

/** Which blocks apply now: the best approved (or permissive) block per anchor. */
export function applicable(blocks: ReferenceBlock[]): ReferenceBlock[] {
  const best = new Map<string, ReferenceBlock>();
  for (const b of blocks) {
    if (needsApproval(b.source.license) && !b.approvedBy) continue;
    const cur = best.get(b.target.anchorId);
    if (!cur || b.similarity.score > cur.similarity.score || (b.similarity.score === cur.similarity.score && AUTHORITY[b.source.kind] > AUTHORITY[cur.source.kind])) best.set(b.target.anchorId, b);
  }
  return [...best.values()];
}

/** Turn an applicable block into what the staged plan consumes: a reuse spec and the block's stated attachment rules. */
export function toStageInputs(block: ReferenceBlock): { reuse: LayoutBlockSpec; attached: { ref: string; to: string; max_distance_nm: number }[] } {
  const reuse: LayoutBlockSpec = {
    id: block.id,
    anchor: block.target.anchorRef,
    members: block.members.map((m) => ({ ref: block.target.memberRefs[m.role] ?? m.ref, rel: m.rel, side: m.side })),
    source: `layout-refs/${block.id}.json`,
  };
  const attached = block.members.map((m) => ({ ref: block.target.memberRefs[m.role] ?? m.ref, to: block.target.anchorRef, max_distance_nm: Math.round(Math.hypot(m.rel.x, m.rel.y) * 1.1) }));
  for (const r of block.rules) attached.push({ ref: r.ref, to: r.to, max_distance_nm: r.max_distance_nm });
  return { reuse, attached };
}
