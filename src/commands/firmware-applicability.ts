import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { runErc } from '../kicad/cli.js';
import { listSymbols } from '../kicad/sexp.js';
import { parseBomTable, parsePinoutRows } from '../memory/bom-table.js';
import { checkDrift } from '../memory/drift.js';

const SOURCE_EXTENSIONS = new Set(['.c', '.h', '.cpp', '.hpp', '.py', '.rs', '.ino', '.s']);

/** Preserve the firmware path, but an empty file is not a scaffold. */
export async function hasFirmwareSource(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && await hasFirmwareSource(file)) return true;
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
      (await readFile(file, 'utf8')).trim()) return true;
  }
  return false;
}

/**
 * Deliberately small, exact stock KiCad identities, not "anything without MCU
 * in its name" or a whole Device/Power_Management library. Unknown/custom
 * symbols and other fixed-function ICs need a reviewed extension, never a guess.
 */
export const NON_PROGRAMMABLE_SYMBOLS = new Set([
  'Device:R', 'Device:R_Small', 'Device:C', 'Device:C_Small',
  'Device:LED', 'Device:LED_Small', 'Device:D', 'Device:D_Schottky',
  'Device:D_TVS', 'Device:Fuse', 'Device:Polyfuse',
  'Connector:USB_C_Receptacle_USB2.0', 'Connector:USB_C_Receptacle_USB2.0_16P',
  'Connector:Screw_Terminal_01x02',
  'Connector_Generic:Conn_01x02', 'Connector_Generic:Conn_02x02_Odd_Even',
  'Mechanical:MountingHole', 'Mechanical:MountingHole_Pad',
  // Microchip DS20005725B, pp. 1 and 10: resistor-set ILIM, EN and FLG;
  // "programmable current-limit" is an analog resistor setting, not firmware.
  // https://ww1.microchip.com/downloads/en/DeviceDoc/20005725B.pdf
  'Power_Management:MIC2544-2YM',
  // TI SLVSAU6I, pp. 3-4: fixed current limit and hardware EN/FLT pins.
  // https://www.ti.com/lit/ds/symlink/tps2065c.pdf
  'Power_Management:TPS2065CDBV',
]);

/**
 * The entire README is this three-field declaration (blank lines allowed).
 * Exact fields keep examples, comments, tentative statements and conflicting
 * declarations from being mistaken for evidence. Hardware is checked below;
 * this declaration alone never establishes applicability.
 */
function hasNotApplicableEvidence(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 3 || lines[0] !== '# Firmware not applicable' ||
    lines[1] !== 'Programmable components: none') return false;
  const reason = /^Reason: (.+)$/.exec(lines[2]!)?.[1]?.trim();
  return !!reason && reason.length >= 20 &&
    !/<!--|-->|<[^>]*>|`|\b(?:TODO|TBD|FIXME|placeholder|unknown)\b/i.test(reason);
}

/**
 * A documented N/A is a stage-7 result, not a skipped stage. Fail closed on
 * missing, unreadable, unknown or inconsistent design evidence. These checks
 * establish firmware applicability only, never fabrication/functional safety.
 */
export async function firmwareNotApplicable(root: string, docs: string): Promise<boolean> {
  try {
    const evidence = await readFile(path.join(root, 'firmware', 'README.md'), 'utf8');
    if (!hasNotApplicableEvidence(evidence)) return false;
    const config = await loadConfig(root);
    if (!config.schematic) return false;
    const schematic = path.join(root, config.schematic);
    const symbols = await listSymbols(schematic);
    if (!symbols.length || symbols.some((symbol) => !NON_PROGRAMMABLE_SYMBOLS.has(symbol.libId))) return false;
    const bom = await readFile(path.join(root, docs, 'BOM.md'), 'utf8');
    const pinout = await readFile(path.join(root, docs, 'PINOUT.md'), 'utf8');
    const bomRows = parseBomTable(bom);
    const pinRows = parsePinoutRows(pinout);
    if (!bomRows.length || bomRows.some((row) => !row.refdes || !row.value) ||
      !pinRows.length || pinRows.some((row) => !row.ref || !row.pin)) return false;
    if ((await checkDrift(root, docs, config.schematic)).length) return false;
    return (await runErc(schematic)).ok;
  } catch {
    return false;
  }
}
