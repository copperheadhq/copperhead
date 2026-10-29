import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { INTENT_FILENAME, type IntentErcExclusion } from './draft/ir.js';
import { runErc } from './cli.js';
import { DRAFT_GENERATOR_MARKER } from './fab.js';
import type { CheckReport, ExcludedViolation, Violation } from './report.js';

/**
 * ERC exclusions declared in the netlist-intent IR (#355).
 *
 * A stock symbol's pin type can make datasheet-correct wiring an ERC error
 * (the LIS3DH's SDO/SA0 is typed Output, and tying it to GND is how its I2C
 * address is set). KiCad's own remedy is a per-marker exclusion in the
 * project, but that is keyed by marker position and item UUIDs, which change
 * with every re-draft, and an agent editing `.kicad_pro` leaves no trace in
 * any report. Here an exclusion names the part pins it excuses and a reason,
 * lives in the IR beside the nets that cause it, and every excluded finding is
 * printed with that reason wherever ERC is reported.
 */

/**
 * ERC as every gate should see it: kicad-cli's report with the intent's
 * exclusions applied. `run_erc`, the stage-4 completion probe and `check` all
 * call this, so an exclusion that passes one passes them all. `runErc` stays
 * the raw KiCad report.
 */
export async function runErcWithExclusions(schPath: string): Promise<CheckReport> {
  return applyErcExclusions(await runErc(schPath), await intentErcExclusionsFor(schPath));
}

/** `"Symbol U9 Pin 7 [SDO, Output, Line]"` → U9.7; anything else → null. */
export function symbolPinOf(description: string): { ref: string; pin: string } | null {
  const m = /^Symbol (\S+) (?:Hidden )?[Pp]in (\S+)/.exec(description);
  return m ? { ref: m[1]!, pin: m[2]! } : null;
}

/**
 * Does `ex` excuse `v`? Same check, at least one part pin, and every part pin
 * the finding names is listed in `ex.pins`. Power-symbol pins (`#FLG01`,
 * `#PWR03`) are placed by the engine, so they never need listing. A finding
 * with an item that is not a pin (a label, a wire, a sheet) is never excused:
 * that is a drawing problem, not a pin-type one.
 */
export function excuses(ex: IntentErcExclusion, v: Violation): boolean {
  if (v.type !== ex.type || !v.items.length) return false;
  const listed = new Set(ex.pins);
  let partPins = 0;
  for (const item of v.items) {
    const sp = symbolPinOf(item.description);
    if (!sp) return false;
    if (sp.ref.startsWith('#')) continue;
    if (!listed.has(`${sp.ref}.${sp.pin}`)) return false;
    partPins++;
  }
  return partPins > 0;
}

/**
 * Move the findings the exclusions excuse out of `violations` into
 * `excluded`, each with the reason that excused it, and recompute `ok`.
 * Exclusions that excused nothing are reported back as `unusedExclusions`:
 * a stale entry is harmless to the gate but should not sit unnoticed.
 */
export function applyErcExclusions(report: CheckReport, exclusions: IntentErcExclusion[]): CheckReport {
  if (!exclusions.length) return report;
  const used = new Set<number>();
  const violations: Violation[] = [];
  const excluded: ExcludedViolation[] = [...(report.excluded ?? [])];
  for (const v of report.violations) {
    const i = exclusions.findIndex((ex) => excuses(ex, v));
    if (i === -1) {
      violations.push(v);
      continue;
    }
    used.add(i);
    excluded.push({ ...v, reason: exclusions[i]!.reason, pins: exclusions[i]!.pins });
  }
  const unusedExclusions = exclusions.filter((_, i) => !used.has(i));
  return {
    ...report,
    ok: violations.length === 0,
    violations,
    excluded,
    ...(unusedExclusions.length ? { unusedExclusions } : {}),
  };
}

/**
 * The well-formed `ercExclusions` of the intent beside an engine-drafted
 * schematic, or `[]`. A hand-drawn sheet never takes exclusions from an intent
 * file, since nothing ties that file to it. Malformed entries are skipped here
 * because validation already refuses them at draft time.
 */
export async function intentErcExclusionsFor(schPath: string): Promise<IntentErcExclusion[]> {
  const intentPath = path.join(path.dirname(schPath), INTENT_FILENAME);
  if (!existsSync(schPath) || !existsSync(intentPath)) return [];
  const head = (await readFile(schPath, 'utf8')).slice(0, 400);
  if (!head.includes(DRAFT_GENERATOR_MARKER)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(intentPath, 'utf8'));
  } catch {
    return [];
  }
  const list = (raw as { ercExclusions?: unknown })?.ercExclusions;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (ex): ex is IntentErcExclusion =>
      ex !== null &&
      typeof ex === 'object' &&
      typeof ex.type === 'string' &&
      typeof ex.reason === 'string' &&
      ex.reason.trim() !== '' &&
      Array.isArray(ex.pins) &&
      ex.pins.length > 0 &&
      ex.pins.every((p: unknown) => typeof p === 'string'),
  );
}
