/**
 * Component-level harness for the schematic drafting engine.
 *
 * The engine proper is `draftSchematicPlacement` (engine.ts): a pure function
 * from a ValidatedIntent to a placement model. Everything impure sits around
 * it — the intent file, the vendored symbol cache, the project scaffold, ERC.
 * The existing draft suites exercise the engine through that whole stack, so
 * each one opens with the same mkdtemp/cp/rm block and a failure can come from
 * anywhere in it.
 *
 * This harness cuts in at the pure seam instead:
 *
 *   - one process-wide `SymbolSource` built with `vendor: false`, so symbol
 *     resolution reads the fixture libraries and writes nothing, anywhere;
 *   - a repo root that deliberately does not exist, proving nothing reaches
 *     for one (the vendored-cache probe is an `existsSync` that simply misses);
 *   - `docsDir: null`, so SUBSYSTEMS.md and BOM.md cross-checks stay out of it.
 *
 * `place()` and `emitText()` therefore touch no directory the tests own. The
 * one exception is `drawnNets()`, which materializes a sheet to a temp file so
 * the production parser can read it back; it is the only helper here that
 * writes, and it cleans up after itself.
 *
 * What belongs in a component test written against this file: contracts about
 * the geometry the engine produces from an IR. What does not: ERC, the CLI,
 * the agent tool, vendoring, byte-level goldens. Those have their own suites.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { SymbolSource, type ResolvedSymbol } from '../../src/kicad/draft/symsource.js';
import {
  validateIntent,
  type IntentNet,
  type IntentPart,
  type IrFinding,
  type SchematicIntent,
  type ValidatedIntent,
} from '../../src/kicad/draft/ir.js';
import { draftSchematicPlacement, type SchematicDraftReport } from '../../src/kicad/draft/engine.js';
import { emitSchematic, knum, type EmitSymbol, type PlacementModel } from '../../src/kicad/emit.js';
import { pinAbsolute, pinNets } from '../../src/kicad/sexp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The four hand-authored fixture libraries: Device, CopperConn, CopperMCU, CopperStack. */
export const SYMLIB = path.join(HERE, '..', 'fixtures', 'symlib');

/** KiCad's grid unit (mm). Pin coordinates are multiples of this by construction. */
export const U = 1.27;

/**
 * A root that does not exist. `SymbolSource` only uses it to probe for a
 * vendored cache, and a miss falls straight through to `searchDirs`, so a
 * bogus path is the cheapest possible proof that nothing here needs a repo.
 */
const NO_REPO = path.join(tmpdir(), 'copperhead-component-harness-no-repo');

/**
 * Shared across the whole suite: resolution is a pure read under `vendor: false`,
 * and the instance caches per lib_id, so the fixture libraries are parsed once
 * for the entire file rather than once per test.
 */
const symsource = new SymbolSource(NO_REPO, [SYMLIB], false);

/** Fixed date so the title block never depends on the clock. */
export const TODAY = '2020-01-01';

/** Project name the engine stamps into uuids and the title block. */
export const PROJECT = 'board';

export interface Placed {
  model: PlacementModel;
  report: SchematicDraftReport;
  symbols: Map<string, ResolvedSymbol>;
  intent: SchematicIntent;
}

/** Fill in the version field so tests can write the interesting part only. */
export function intentOf(spec: {
  parts: IntentPart[];
  nets: IntentNet[];
  noConnect?: string[];
  hints?: SchematicIntent['hints'];
}): SchematicIntent {
  return { version: 1, ...spec };
}

/** Shorthand for a part in the default group, which most component cases do not vary. */
export function part(ref: string, libId: string, value: string, group = 'Main'): IntentPart {
  return { ref, libId, value, group };
}

/** Validate without asserting, for the cases whose subject is the finding list. */
export async function tryValidate(
  intent: SchematicIntent,
): Promise<{ ok: boolean; findings: IrFinding[]; validated: ValidatedIntent | null }> {
  return validateIntent(intent, symsource, null);
}

/**
 * Validate and place. Throws with the findings joined when the IR is rejected —
 * a component test that meant to exercise geometry should fail naming the IR
 * problem, not on `undefined` three assertions later.
 */
export async function place(intent: SchematicIntent): Promise<Placed> {
  const v = await tryValidate(intent);
  if (!v.ok || !v.validated) {
    throw new Error(`intent rejected: ${v.findings.map((f) => f.detail).join('; ')}`);
  }
  const { model, report } = draftSchematicPlacement(v.validated, PROJECT, TODAY);
  return { model, report, symbols: v.validated.symbols, intent };
}

/** Place and serialize, still without touching the working tree. */
export async function emitText(intent: SchematicIntent): Promise<string> {
  const { model } = await place(intent);
  return emitSchematic(model);
}

/** The placed symbol for a refdes. Throws rather than returning undefined. */
export function symbolOf(placed: Placed, ref: string): EmitSymbol {
  const sym = placed.model.symbols.find((s) => s.ref === ref);
  if (!sym) throw new Error(`no symbol placed for ${ref} (placed: ${placed.model.symbols.map((s) => s.ref).join(', ')})`);
  return sym;
}

/**
 * Absolute sheet coordinate of a pin. The engine never mirrors a symbol, so
 * the transform is placement rotation only.
 */
export function pinPoint(placed: Placed, ref: string, pinNumber: string): { x: number; y: number } {
  const sym = symbolOf(placed, ref);
  // ValidatedIntent.symbols is keyed by refdes, not lib_id: two parts sharing a
  // library get one entry each (ir.ts:204).
  const resolved = placed.symbols.get(ref);
  if (!resolved) throw new Error(`no resolved symbol for ${ref} (${sym.libId})`);
  const pin = resolved.pins.find((p) => p.number === pinNumber);
  if (!pin) throw new Error(`${ref} (${sym.libId}) has no pin ${pinNumber}`);
  return pinAbsolute(sym.at, null, pin);
}

/**
 * Identity of a point on the sheet, as the sheet will state it.
 *
 * The placement model carries raw floats — a pin can come out at
 * 48.260000000000005 where its neighbour is at 48.26 — but the emitter writes
 * both through `knum`, so KiCad sees one coordinate and joins them. Comparing
 * model floats directly would call that a miss. This is the same identity the
 * merged-net guard uses, and for the same reason.
 */
export const pointKey = (x: number, y: number): string => `${knum(x)},${knum(y)}`;

/** `REF.PIN -> net` exactly as the IR declared it. */
export function declaredNets(intent: SchematicIntent): Map<string, string> {
  const out = new Map<string, string>();
  for (const net of intent.nets) for (const p of net.pins) out.set(p, net.name);
  return out;
}

/**
 * `REF.PIN -> net` as the drawn sheet actually connects, read back through the
 * production parser rather than by re-deriving connectivity here — a check
 * that re-implemented the netlister would only agree with itself.
 *
 * The one helper that writes: `pinNets` takes a path. It is a single file in a
 * temp dir, removed before returning.
 */
export async function drawnNets(intent: SchematicIntent): Promise<Map<string, string>> {
  const text = await emitText(intent);
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-component-'));
  try {
    const file = path.join(dir, `${PROJECT}.kicad_sch`);
    await writeFile(file, text, 'utf8');
    return new Map((await pinNets(file)).map((p) => [`${p.ref}.${p.pinNumber}`, p.net]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
