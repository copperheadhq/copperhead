import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { listSymbols, pinNets, type SchematicSymbol } from '../kicad/sexp.js';
import { resolveInRepo, SandboxError } from '../util/paths.js';
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
): Promise<string | null> {
  const symbols = await listSymbols(path.join(repoRoot, schematic));
  if (symbols.length) return null;
  const bomPath = path.join(repoRoot, docsDir, 'BOM.md');
  if (!existsSync(bomPath)) return null;
  const refs = parseCanonicalRows(await readFile(bomPath, 'utf8'))
    .map((r) => r.cells[0])
    .filter(Boolean);
  if (!refs.length) return null;
  return `schematic has zero symbols but BOM.md lists ${refs.length} refdes; if this repo is not mid-bootstrap, the schematic may have been emptied accidentally`;
}

export async function checkDrift(repoRoot: string, docsDir: string, schematic: string): Promise<DriftMismatch[]> {
  const mismatches: DriftMismatch[] = [];
  const schPath = path.join(repoRoot, schematic);
  const symbols = await listSymbols(schPath);
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
    const nets = await pinNets(schPath);
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

export interface BriefProvenanceStatus {
  ok: boolean;
  path: string;
  recorded: string;
  origin: string;
  current: string;
  previous?: string;
}

function candidateBriefHashes(buf: Buffer): { rawHex: string; variants: Set<string> } {
  const rawHex = createHash('sha256').update(buf).digest('hex');
  const variants = new Set<string>([rawHex]);
  const text = buf.toString('utf8');
  const lf = text.replace(/\r\n/g, '\n');
  variants.add(createHash('sha256').update(lf, 'utf8').digest('hex'));
  const crlf = lf.replace(/\n/g, '\r\n');
  variants.add(createHash('sha256').update(crlf, 'utf8').digest('hex'));
  return { rawHex, variants };
}

function snapshotRelPath(docsDir: string): string {
  return path.posix.join(docsDir.replace(/\\/g, '/').replace(/\/+$/, ''), 'BRIEF.md');
}

function resolveBriefFile(
  repoRoot: string,
  docsDir: string,
  recordedPath: string,
): { path: string | null; outsideRepo: boolean } {
  if (recordedPath.startsWith('external:')) {
    const snap = resolveInRepo(repoRoot, path.join(docsDir, 'BRIEF.md'));
    return { path: existsSync(snap) ? snap : null, outsideRepo: false };
  }

  let candidate: string;
  try {
    candidate = resolveInRepo(repoRoot, recordedPath);
  } catch (err) {
    if (err instanceof SandboxError) {
      return { path: null, outsideRepo: true };
    }
    throw err;
  }
  return { path: existsSync(candidate) ? candidate : null, outsideRepo: false };
}

export async function checkBriefProvenance(
  repoRoot: string,
  docsDir: string,
): Promise<BriefProvenanceStatus | null> {
  const shaFile = resolveInRepo(repoRoot, path.join(docsDir, 'BRIEF.sha256'));
  if (!existsSync(shaFile)) return null;

  const raw = await readFile(shaFile, 'utf8');
  const briefMatch = raw.match(/^brief:\s*(.+)$/m);
  const shaMatch = raw.match(/^sha256:\s*([0-9a-fA-F]+)$/m);
  const originMatch = raw.match(/^origin_sha256:\s*([0-9a-fA-F]+)$/m);

  const defaultPath = snapshotRelPath(docsDir);
  const recordedPath = briefMatch?.[1]?.trim() || defaultPath;

  if (!shaMatch) {
    return {
      ok: false,
      path: recordedPath,
      recorded: 'invalid',
      origin: 'invalid',
      current: 'invalid',
    };
  }

  const origin = (originMatch?.[1] ?? shaMatch[1]!).trim().toLowerCase();
  const recorded = shaMatch[1]!.trim().toLowerCase();

  const resolved = resolveBriefFile(repoRoot, docsDir, recordedPath);
  if (resolved.outsideRepo) {
    return {
      ok: false,
      path: recordedPath,
      recorded,
      origin,
      current: 'outside-repo',
    };
  }
  if (!resolved.path) {
    return {
      ok: false,
      path: recordedPath,
      recorded,
      origin,
      current: 'missing',
    };
  }

  const { rawHex, variants } = candidateBriefHashes(await readFile(resolved.path));
  const ok = variants.has(recorded);

  return {
    ok,
    path: recordedPath,
    recorded,
    origin,
    current: ok ? recorded : rawHex,
  };
}

export async function reconcileBriefHash(
  repoRoot: string,
  docsDir: string,
): Promise<BriefProvenanceStatus> {
  const shaFile = resolveInRepo(repoRoot, path.join(docsDir, 'BRIEF.sha256'));
  await mkdir(path.dirname(shaFile), { recursive: true });

  const defaultPath = snapshotRelPath(docsDir);
  let existingPath = defaultPath;
  let originSha: string | null = null;
  let previousSha: string | null = null;

  if (existsSync(shaFile)) {
    const raw = await readFile(shaFile, 'utf8');
    const briefMatch = raw.match(/^brief:\s*(.+)$/m);
    const shaMatch = raw.match(/^sha256:\s*([0-9a-fA-F]+)$/m);
    const originMatch = raw.match(/^origin_sha256:\s*([0-9a-fA-F]+)$/m);
    if (briefMatch?.[1]) existingPath = briefMatch[1].trim();
    previousSha = shaMatch?.[1]?.trim().toLowerCase() || null;
    originSha = (originMatch?.[1] ?? shaMatch?.[1] ?? '').trim().toLowerCase() || null;
  }

  const resolved = resolveBriefFile(repoRoot, docsDir, existingPath);
  if (resolved.outsideRepo) {
    throw new SandboxError(`cannot acknowledge brief provenance: path escapes repository (${existingPath})`);
  }
  if (!resolved.path) {
    if (existingPath.startsWith('external:')) {
      throw new Error(
        `cannot acknowledge brief provenance: ${existingPath} has no in-repo copy; copy it to ${defaultPath} and run copperhead sync --brief`,
      );
    }
    throw new Error(`cannot acknowledge brief provenance: brief file not found (${existingPath})`);
  }

  // Adopt the in-repo snapshot path when reconciling a legacy `external:` record.
  if (existingPath.startsWith('external:')) {
    existingPath = defaultPath;
  }

  const lfText = (await readFile(resolved.path, 'utf8')).replace(/\r\n/g, '\n');
  const currentSha = createHash('sha256').update(lfText, 'utf8').digest('hex');

  const finalOrigin = originSha ?? currentSha;
  const lines = [`brief: ${existingPath}`, `sha256: ${currentSha}`];
  if (finalOrigin !== currentSha) {
    lines.push(`origin_sha256: ${finalOrigin}`);
  }
  await writeFile(shaFile, lines.join('\n') + '\n', 'utf8');

  if (previousSha && previousSha !== currentSha) {
    const dateStr = new Date().toISOString().slice(0, 10);
    const decisionsPath = resolveInRepo(repoRoot, path.join(docsDir, 'DECISIONS.md'));
    if (existsSync(decisionsPath)) {
      const decText = await readFile(decisionsPath, 'utf8');
      const decEntry = `\n## ${dateStr} - sync-brief\n- **Decision**: Acknowledged brief provenance change for \`${existingPath}\` (\`${previousSha.slice(0, 8)}\` -> \`${currentSha.slice(0, 8)}\`).\n- **Why**: brief change acknowledged by the user via copperhead sync --brief; the design was not re-verified against it.\n- **Affects**: ${existingPath}, BRIEF.sha256\n`;
      if (!decText.includes(currentSha.slice(0, 8))) {
        await writeFile(decisionsPath, decText.trimEnd() + '\n' + decEntry, 'utf8');
      }
    }
    const changelogPath = resolveInRepo(repoRoot, path.join(docsDir, 'CHANGELOG.md'));
    if (existsSync(changelogPath)) {
      const chgText = await readFile(changelogPath, 'utf8');
      const chgEntry = `\n## ${dateStr} - sync --brief\n- **Request**: Acknowledge brief provenance update (${existingPath})\n- **Files**: ${existingPath}, BRIEF.sha256\n- **Note**: sha256 ${previousSha.slice(0, 8)} -> ${currentSha.slice(0, 8)} (origin ${finalOrigin.slice(0, 8)}; design not re-evaluated)\n`;
      if (!chgText.includes(currentSha.slice(0, 8))) {
        await writeFile(changelogPath, chgText.trimEnd() + '\n' + chgEntry, 'utf8');
      }
    }
  }

  return {
    ok: true,
    path: existingPath,
    recorded: currentSha,
    origin: finalOrigin,
    current: currentSha,
    ...(previousSha ? { previous: previousSha } : {}),
  };
}
