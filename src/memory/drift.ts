import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { listSymbols, pinNets, symbolsFromLoaded, pinNetsFromLoaded, type SchematicSymbol, type LoadedSchematic } from '../kicad/sexp.js';
import {
  parseCanonicalRows,
  parseBomTable,
  parsePinoutRows,
  pinoutColumnReport,
  normalizeValue,
  normalizeFootprint,
} from './bom-table.js';

/**
 * Doc-vs-schematic drift check (AC-2.3). BOM.md and PINOUT.md use fixed table
 * columns (the parseable contract, design D9); free-prose docs are not checked.
 */
export interface DriftMismatch {
  doc: string;
  claim: string;
  actual: string;
}

/**
 * The zero-symbol carve-out in checkDrift is right for the create pipeline,
 * but it would let `check` silently pass an established repo whose schematic
 * was emptied by accident while BOM.md still lists parts. `check` calls this
 * alongside checkDrift and reports the result as a warning, not a failure:
 * an empty sheet with a populated BOM is either bootstrap (fine) or an
 * accident (worth a human look), and only a human can tell which.
 */
export async function emptySchematicWarning(
  repoRoot: string,
  docsDir: string,
  schematic: string,
  symbols?: SchematicSymbol[],
): Promise<string | null> {
  const syms = symbols ?? (await listSymbols(path.join(repoRoot, schematic)));
  if (syms.length) return null;
  const bomPath = path.join(repoRoot, docsDir, 'BOM.md');
  if (!existsSync(bomPath)) return null;
  const refs = parseCanonicalRows(await readFile(bomPath, 'utf8'))
    .map((r) => r.cells[0])
    .filter(Boolean);
  if (!refs.length) return null;
  return `schematic has zero symbols but BOM.md lists ${refs.length} refdes; if this repo is not mid-bootstrap, the schematic may have been emptied accidentally`;
}

export async function checkDrift(
  repoRoot: string,
  docsDir: string,
  schematic: string,
  loaded?: LoadedSchematic,
): Promise<DriftMismatch[]> {
  const mismatches: DriftMismatch[] = [];
  const schPath = path.join(repoRoot, schematic);
  const symbols = loaded ? symbolsFromLoaded(loaded) : await listSymbols(schPath);
  // A schematic with zero symbols is the bootstrap state: during the create
  // pipeline the docs legitimately lead the schematic (part-selection writes
  // BOM.md before any symbol exists), so comparing against an empty sheet
  // deadlocks every docs-touching stage — or worse, teaches the agent to strip
  // refdes from BOM.md to appease the gate (#21). Same reasoning as the
  // "no schematic configured" carve-out in the check_drift tool.
  if (!symbols.length) return mismatches;
  const byRef = new Map<string, SchematicSymbol>(symbols.map((s) => [s.ref, s]));

  const bomPath = path.join(repoRoot, docsDir, 'BOM.md');
  if (existsSync(bomPath)) {
    // Resolve BOM columns by header name via the shared parseBomTable (F5), so
    // the drift reader and `export bom` never disagree on a reordered table.
    const rows = parseBomTable(await readFile(bomPath, 'utf8'));
    const seen = new Set<string>();
    for (const { refdes: ref, value, footprint } of rows) {
      if (!ref) continue;
      seen.add(ref);
      const sym = byRef.get(ref);
      if (!sym) {
        mismatches.push({ doc: 'BOM.md', claim: `${ref} exists`, actual: `${ref} not in schematic` });
        continue;
      }
      // Compare on the semantic value, not the byte-exact string: `Ihold≥3A` and
      // `Ihold>=3A` are the same value written two ways (#I11). Raw `!==` flagged
      // them as drift and whack-a-moled the agent across finish attempts.
      if (value !== undefined && normalizeValue(value) !== normalizeValue(sym.value)) {
        mismatches.push({ doc: 'BOM.md', claim: `${ref} value ${value}`, actual: `${ref} value ${sym.value}` });
      }
      // Footprint compare folds encoding/spacing but keeps case (F6): a footprint
      // library id is case-sensitive, so lowercasing would hide a real mismatch.
      if (
        footprint !== undefined &&
        normalizeFootprint(footprint) !== normalizeFootprint(sym.footprint)
      ) {
        mismatches.push({
          doc: 'BOM.md',
          claim: `${ref} footprint ${footprint}`,
          actual: `${ref} footprint ${sym.footprint}`,
        });
      }
    }
    for (const sym of symbols) {
      if (!seen.has(sym.ref)) {
        mismatches.push({ doc: 'BOM.md', claim: `${sym.ref} absent`, actual: `${sym.ref} (${sym.value}) in schematic` });
      }
    }
  }

  const pinoutPath = path.join(repoRoot, docsDir, 'PINOUT.md');
  if (existsSync(pinoutPath)) {
    const pinoutMd = await readFile(pinoutPath, 'utf8');
    const nets = loaded ? pinNetsFromLoaded(loaded) : await pinNets(schPath);
    const netOf = new Map(nets.map((p) => [`${p.ref}:${p.pinNumber}`, p.net]));
    // If the doc has a Refdes/Pin table but no Net column, say so once and
    // explicitly, rather than silently checking nothing (a correct doc then
    // reads as unverified) — the counterpart to the old positional bug that
    // reported every pin as a false NC (#I12). This tells the model what to fix
    // (add the column) instead of leaving it guessing why nets aren't verified.
    const cols = pinoutColumnReport(pinoutMd);
    if (cols.hasTable && !cols.net) {
      mismatches.push({
        doc: 'PINOUT.md',
        claim: 'the pin table has a Net column (expected header: Refdes | Pin | Net)',
        actual: 'no Net column in the pin table, so pin-to-net assignments cannot be checked; add a Net column',
      });
    }
    // Resolve columns by header name, not position: the PINOUT table may be
    // `Refdes | Pin | Net` or the scaffold's `Refdes | Pin | Name | Net | Notes`.
    // A fixed net index read every pin as "NC" on the 3-column form (#I12).
    const rows = parsePinoutRows(pinoutMd);
    for (const { ref, pin: pinNumber, net } of rows) {
      if (!ref || !pinNumber) continue;
      const k = `${ref}:${pinNumber}`;
      if (!netOf.has(k)) {
        mismatches.push({ doc: 'PINOUT.md', claim: `${k} exists`, actual: `${k} not in schematic` });
        continue;
      }
      const actual = netOf.get(k) ?? 'NC';
      const claimed = net === undefined || net === '' ? 'NC' : net;
      if (claimed !== actual) {
        mismatches.push({ doc: 'PINOUT.md', claim: `${k} net ${claimed}`, actual: `${k} net ${actual}` });
      }
    }
  }

  return mismatches;
}
