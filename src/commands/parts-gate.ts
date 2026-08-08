/**
 * The stage-4 unresolvable-parts checkpoint (add-unresolvable-parts-checkpoint):
 * once per schematic-stage entry, resolve the BOM against the installed symbol
 * libraries and — when a part genuinely matches nothing — offer the decision to
 * a human (`--interactive` pause) or fail fast (`unresolvableParts: 'stop'`)
 * before the first agent turn is spent negotiating substitutes.
 *
 * The gate consumes the same classifier the dossier renders from
 * (`resolveBomSymbols`), so the I15 no-false-absence guard carries over at gate
 * strength: it fires ONLY on a successful resolution's genuine absence set.
 * A degraded resolution (no readable library, timeout, error, missing BOM)
 * proceeds with a warning in both modes — "could not check" must never fail a
 * run as "checked and absent" — and parts disclosed as unresolved-by-error,
 * not-searched, or past the size cap never trigger it.
 *
 * With no checkpoint prompt and the default `'agent'` policy the gate
 * short-circuits before resolving anything: nothing would consume the result,
 * so stage-4 entry stays byte-identical to the pre-gate pipeline.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolveBomSymbols, type BomResolution } from '../kicad/dossier.js';
import { nearestInstalledSymbols, symbolSearchDirs } from '../kicad/symlib.js';
import { withTimeout } from '../agent/recovery.js';
import { stageLine } from '../agent/theme.js';

/** A human's three-way answer at the checkpoint; `null` (cancel) means stop. */
export type PartsCheckpointDecision = 'recheck' | 'continue' | 'stop';

export interface AbsentPart {
  /** every refdes that uses this part */
  refs: string[];
  /** the query that matched nothing (MPN when present, else Value) */
  query: string;
  /** nearest installed lib_ids — suggestions for a human, not match claims */
  candidates: string[];
}

export interface PartsCheckpointReport {
  /** parts classified absent after both the MPN search and the Value fallback */
  absent: AbsentPart[];
  /** parts the resolution never actually checked, labeled by reason: nothing
   * here says anything about availability */
  neverChecked: {
    errored: string[];
    notSearched: string[];
    overflow: string[];
  };
}

export interface PartsGateOptions {
  repoRoot: string;
  /** docs dir relative to the repo root (config.docs) */
  docsDir: string;
  /** the `unresolvableParts` policy, applied only when no prompt is available */
  mode: 'agent' | 'stop';
  /** The interactive checkpoint prompt. When present it takes precedence over
   * `'stop'`: a present human is always asked instead of the run failing. */
  onCheckpoint?: (report: PartsCheckpointReport) => Promise<PartsCheckpointDecision | null>;
  log: (s: string) => void;
  /** Test seam: symbol search directories (defaults to the real machine's). */
  searchDirs?: () => Promise<string[]>;
  /** Test seam: the gate's own resolution timeout (default 60s, like the
   * advisory dossier's — D2's "one extra bounded library scan"). */
  resolveTimeoutMs?: number;
}

export interface PartsGateResult {
  verdict: 'proceed' | 'stop';
  /** present whenever a successful resolution ran (absent on short-circuit
   * and on degraded resolutions) */
  report?: PartsCheckpointReport;
}

const GATE_TIMEOUT_MS = 60_000;

/** Cap on nearest-candidate suggestions shown per absent part. */
const CANDIDATE_CAP = 5;

type GateResolution =
  | { res: BomResolution; dirs: string[] }
  | { res: { status: 'empty'; reason: string }; dirs: string[] };

async function resolveOnce(opts: PartsGateOptions): Promise<GateResolution> {
  const bomPath = path.join(opts.repoRoot, opts.docsDir, 'BOM.md');
  let dirs: string[] = [];
  try {
    if (!existsSync(bomPath)) return { res: { status: 'empty', reason: 'no BOM.md' }, dirs };
    const bomMd = await readFile(bomPath, 'utf8');
    dirs = await (opts.searchDirs ?? symbolSearchDirs)();
    const res = await withTimeout(
      async () => resolveBomSymbols(bomMd, dirs),
      opts.resolveTimeoutMs ?? GATE_TIMEOUT_MS,
    );
    return { res, dirs };
  } catch (e) {
    return { res: { status: 'empty', reason: (e as Error).message || 'error' }, dirs };
  }
}

/**
 * Run the checkpoint once per schematic-stage entry. Proceed/stop verdict:
 * `'stop'` only ever comes from a human's explicit choice (or cancel) or the
 * `'stop'` policy meeting a genuine absence — never from a degrade path.
 */
export async function schematicPartsGate(opts: PartsGateOptions): Promise<PartsGateResult> {
  // No prompt and no fail-fast policy: nothing would consume a resolution, so
  // don't pay for one — stage-4 entry stays byte-identical to today, and the
  // absence list still reaches the agent through the advisory dossier.
  if (!opts.onCheckpoint && opts.mode === 'agent') return { verdict: 'proceed' };

  // Re-check loop: the human edits docs/BOM.md, the gate re-reads and
  // re-resolves everything (directories included — they may have installed a
  // library while paused), so a newly introduced absence is shown before
  // approval, never approved stale.
  for (;;) {
    const { res, dirs } = await resolveOnce(opts);
    if (res.status !== 'ok') {
      opts.log(
        stageLine(
          'schematic',
          `parts gate: symbol availability could not be verified (${res.reason}); proceeding — could-not-check is not checked-and-absent`,
          'warn',
        ),
      );
      return { verdict: 'proceed' };
    }
    const absent: AbsentPart[] = [];
    for (const p of res.parts) {
      if (p.status !== 'absent') continue;
      let candidates = await nearestInstalledSymbols(p.query, dirs, CANDIDATE_CAP);
      if (!candidates.length && p.fallback) {
        candidates = await nearestInstalledSymbols(p.fallback, dirs, CANDIDATE_CAP);
      }
      absent.push({ refs: p.refs, query: p.query, candidates });
    }
    const report: PartsCheckpointReport = {
      absent,
      neverChecked: { errored: res.errored, notSearched: res.notSearched, overflow: res.overflow },
    };
    if (!absent.length) {
      const skipped = res.errored.length + res.notSearched.length + res.overflow.length;
      opts.log(
        stageLine(
          'schematic',
          `parts gate: every searched BOM part resolves to an installed symbol${skipped ? ` (${skipped} part(s) never actually checked — see the dossier)` : ''}`,
          'ok',
        ),
      );
      return { verdict: 'proceed', report };
    }
    if (opts.onCheckpoint) {
      // Cancel maps to stop: the safe default spends nothing.
      const decision = (await opts.onCheckpoint(report)) ?? 'stop';
      if (decision === 'recheck') continue;
      return decision === 'continue' ? { verdict: 'proceed', report } : { verdict: 'stop', report };
    }
    if (opts.mode === 'stop') return { verdict: 'stop', report };
    return { verdict: 'proceed', report };
  }
}

/**
 * The human-readable checkpoint report block, shared by the interactive prompt
 * and the `'stop'` exit so both show the same facts.
 */
export function formatPartsCheckpointReport(report: PartsCheckpointReport): string {
  const lines: string[] = [];
  lines.push(`${report.absent.length} BOM part(s) match no installed symbol:`);
  for (const p of report.absent) {
    const who = `${p.refs.join(', ')} (${p.query})`;
    lines.push(
      p.candidates.length
        ? `  - ${who}: nearest installed: ${p.candidates.join(', ')}`
        : `  - ${who}: no near match installed`,
    );
  }
  const nc = report.neverChecked;
  if (nc.errored.length || nc.notSearched.length || nc.overflow.length) {
    lines.push('Never actually checked (nothing known about availability):');
    if (nc.errored.length) lines.push(`  - probe error: ${nc.errored.join('; ')}`);
    if (nc.notSearched.length) lines.push(`  - name too short to search: ${nc.notSearched.join('; ')}`);
    if (nc.overflow.length) lines.push(`  - past the size cap: ${nc.overflow.join('; ')}`);
  }
  lines.push('Fix: edit docs/BOM.md to name parts whose symbols are installed (the nearest-installed lists above are suggestions, not verified matches).');
  return lines.join('\n');
}

/**
 * Machine-readable stop report beside the run transcripts: a separate file,
 * not a mutation of report.json's stable diffing schema (D6). Best-effort,
 * like writeRunReport: a write failure is logged, never fatal.
 */
export async function writeUnresolvedPartsReport(
  repoRoot: string,
  report: PartsCheckpointReport,
  resumeCommand: string,
  log: (s: string) => void,
): Promise<void> {
  const runsDir = path.join(repoRoot, '.copperhead', 'runs');
  const file = path.join(runsDir, 'unresolved-parts.json');
  try {
    await mkdir(runsDir, { recursive: true });
    await writeFile(
      file,
      JSON.stringify(
        {
          generatedAtMs: Date.now(),
          absent: report.absent,
          neverChecked: report.neverChecked,
          resume: resumeCommand,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    log(`wrote unresolved-parts report: ${path.relative(repoRoot, file)}`);
  } catch (err) {
    log(`warning: could not write unresolved-parts report (${(err as Error).message})`);
  }
}
