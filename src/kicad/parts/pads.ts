/**
 * Symbol pins against footprint pads, shared by the parts-manifest validator
 * (stage 3) and the IR validator (stage 4) — design D4. Lifted verbatim from
 * `validateIntent` so both stages refuse the same pairs with the same words.
 *
 * A symbol pin its footprint has no pad for drops that pin's net off the board
 * ("No pad found for pin" in KiCad, #314). The reverse (#325): an electrical
 * pad no symbol pin names gets no net and floats (a 16-contact USB-C receptacle
 * under a 6-pin power-only symbol leaves half its VBUS and GND contacts
 * unconnected). Mechanical, shield and thermal pads are exempt, unconnected by
 * design: by KiCad's pad naming, by the library's heatsink property, or as the
 * exposed pad of a footprint named for one (DFN-8-1EP's pad 9).
 */

import { readFootprintPads, exposedPads, isMechanicalPad, formatPadMismatch, type FootprintResolver } from '../footprints.js';

export interface PadCheckInput {
  ref: string;
  /** An id `footprints.resolve` accepts; an unresolvable id is the BOM gate's business, not this check's. */
  footprint: string;
  symbolPins: ReadonlySet<string>;
  /** Where the fix lives, appended to the finding (`change the footprint in BOM.md and the intent together`). */
  where: string;
}

export interface PadCheckResult {
  /** Refuse: a pin with no pad, or an unpinned pad when the library ships a variant that fits. */
  finding?: string;
  /** Note: unpinned pads with no fitting variant — the library's own pairing, confirmed against the datasheet. */
  warning?: string;
}

const byNum = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

export async function checkPinsAgainstPads(input: PadCheckInput, footprints: FootprintResolver): Promise<PadCheckResult> {
  const hit = await footprints.resolve(input.footprint);
  if (!hit.ok) return {};
  const { numbers: pads, heatsink } = await readFootprintPads(hit.file);
  const symPins = input.symbolPins;
  const pins = [...symPins].filter((n) => !pads.has(n)).sort(byNum);
  const exposed = exposedPads(input.footprint, pads, symPins);
  const unpinned = [...pads].filter((n) => !isMechanicalPad(n) && !heatsink.has(n) && !exposed.has(n) && !symPins.has(n)).sort(byNum);
  // A pad no pin names is a slip when its library ships the variant the
  // symbol fits (the 6-contact receptacle beside the 16-contact one). When
  // it ships none, the pairing is the library's own (a no-connect lead the
  // symbol omits, as KiCad draws the FT232RL and the PIC families): noted,
  // not refused, since there is no footprint to change to.
  const variant = unpinned.length && !pins.length ? await footprints.variantCovering(input.footprint, symPins) : null;
  const mismatch = formatPadMismatch({ ref: input.ref, footprint: input.footprint, pins, pads: [...pads].sort(byNum), ...(unpinned.length ? { unpinned } : {}) });
  if (pins.length || variant) {
    const advice = [
      pins.length ? `use a symbol whose pin numbers match the footprint's pads` : '',
      unpinned.length
        ? `use a footprint whose electrical pads are all pins of the symbol (${variant ? `${variant} in the same library matches` : 'KiCad often ships a variant with the matching contact count'})`
        : '',
    ].filter(Boolean);
    return { finding: `${mismatch}; ${advice.join(', or ')} (${input.where})` };
  }
  if (unpinned.length) {
    return {
      warning:
        `${mismatch}; no footprint in its library matches the symbol's pins exactly, so these are taken as pads the library leaves ` +
        `unconnected by design (an exposed pad, or a lead the symbol omits as no-connect); confirm against the datasheet before fabrication`,
    };
  }
  return {};
}
