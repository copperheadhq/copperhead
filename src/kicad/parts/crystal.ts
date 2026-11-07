/**
 * Crystal load capacitors (ST AN2867, section 3.3). A crystal is trimmed to
 * run at its frequency into a stated load CL, and that load is its two
 * capacitors in series plus the stray capacitance of the pins and the board:
 *
 *   CL = (C1 × C2) / (C1 + C2) + Cs, so C1 = C2 = 2 × (CL − Cs)
 *
 * Setting each capacitor to CL is the usual slip: it looks right, the board
 * oscillates, and the clock runs off frequency. Nets are not in the manifest,
 * so the crystal's `crystal` record names its capacitors; that they are wired
 * to it is the schematic's to show. Pure: no library or file is read.
 */

import { refPrefix, type ManifestFinding, type PartEntry, type PartsManifest } from './manifest.js';

/** AN2867's worked example. A real board differs, so `strayPf` overrides it. */
export const DEFAULT_STRAY_PF = 5;
/**
 * The guide gives no figure. This is half the widest E12 step in the range
 * (27 to 33 pF is 3 pF of series load), so the nearest stock value always passes.
 */
export const LOAD_TOLERANCE_PF = 1.5;

const SCALE_TO_PF: Record<string, number> = { p: 1, n: 1e3, u: 1e6, µ: 1e6 };

/**
 * A capacitor value in pF, or null when it does not state one: `22pF`, `22p`,
 * `2p2`, `4.7 nF`, `22pF 50V`. A bare number is null, not a guess at the unit.
 */
export function capacitancePf(value: string): number | null {
  const m = /^(\d+(?:\.\d+)?|\.\d+)\s*([pnuµ])(\d*)f?(?![a-z0-9])/i.exec(value.trim());
  if (!m) return null;
  const scale = SCALE_TO_PF[m[2]!.toLowerCase()]!;
  return Number(m[3] ? `${m[1]}.${m[3]}` : m[1]) * scale;
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** The load a crystal record's capacitors present, or what stops it being worked out. */
function checkEntry(e: PartEntry, byRef: Map<string, PartEntry>): ManifestFinding[] {
  const { loadPf, strayPf = DEFAULT_STRAY_PF, loadCaps } = e.crystal!;
  const findings: ManifestFinding[] = [];
  const caps: { ref: string; value: string; pf: number }[] = [];
  for (const ref of loadCaps) {
    const cap = byRef.get(ref);
    if (!cap) findings.push({ ref: e.ref, detail: `${e.ref}: "loadCaps" names ${ref}, which has no entry in the manifest` });
    else if (refPrefix(ref) !== 'C') findings.push({ ref: e.ref, detail: `${e.ref}: "loadCaps" names ${ref}, which is not a capacitor (C refdes)` });
    else {
      const pf = capacitancePf(cap.value);
      if (pf === null) findings.push({ ref, detail: `${ref}: value ${JSON.stringify(cap.value)} states no capacitance, so the load on ${e.ref} cannot be checked; give it with its unit ("20pF")` });
      else caps.push({ ref, value: cap.value, pf });
    }
  }
  if (findings.length) return findings;
  const need = 2 * (loadPf - strayPf);
  if (need <= 0) {
    return [{ ref: e.ref, detail: `${e.ref}: a load of ${loadPf} pF cannot be reached over ${strayPf} pF of stray capacitance; choose a crystal with a higher load, or give the board's real "strayPf" in its "crystal" record` }];
  }
  const [a, b] = caps as [(typeof caps)[0], (typeof caps)[0]];
  const load = (a.pf * b.pf) / (a.pf + b.pf) + strayPf;
  if (Math.abs(load - loadPf) <= LOAD_TOLERANCE_PF) return [];
  return [{
    ref: e.ref,
    detail: `${e.ref}: ${a.ref} (${a.value}) and ${b.ref} (${b.value}) load the crystal with ${round(load)} pF over ${strayPf} pF of stray capacitance, but it needs ${loadPf} pF, so it would run off frequency; use about ${round(need)} pF for both (each capacitor = 2 × (load − stray), not the load itself)`,
  }];
}

/** A finding for each crystal record whose capacitors miss the crystal's load. */
export function crystalLoadFindings(manifest: PartsManifest): ManifestFinding[] {
  const byRef = new Map(manifest.parts.map((p) => [p.ref, p]));
  return manifest.parts.filter((e) => e.crystal).flatMap((e) => checkEntry(e, byRef));
}
