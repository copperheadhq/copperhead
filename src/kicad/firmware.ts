import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { listSymbols, pinNets } from './sexp.js';
import { parsePinoutRows } from '../memory/bom-table.js';
import { ExportError } from '../commands/export.js';

export const FIRMWARE_TARGETS = ['c'] as const;
export type FirmwareTarget = (typeof FIRMWARE_TARGETS)[number];

export const DEFAULT_FIRMWARE_HEADER = 'firmware/inc/pinout.h';

const POWER_NET_PATTERN =
  /^(?:GND|AGND|DGND|PGND|VSS|AVSS|VCC|VDD|AVDD|VBAT|VBUS|3V3|5V|1V8|12V|\+\d+(?:V\d+|\.\d+V)|-\d+(?:V\d+|\.\d+V)|PWR_FLAG|NC|unconnected-.*)$/i;

export interface FirmwarePinEntry {
  macro: string;
  signal: string;
  pin: string;
  ref: string;
  pinNumber: string;
}

export interface FirmwareDriftItem {
  macro: string;
  schematicPin: string | null;
  headerPin: string | null;
}

export interface FirmwareCheckResult {
  ok: boolean;
  headerPath: string;
  pinsChecked: number;
  mismatches: FirmwareDriftItem[];
}

export interface ExportFirmwareOptions {
  repoRoot: string;
  target?: FirmwareTarget;
  outPath?: string;
  ref?: string;
}

export interface ExportFirmwareResult {
  target: FirmwareTarget;
  outPath: string;
  pins: FirmwarePinEntry[];
  content: string;
}

export function parseFirmwareTarget(value: string): FirmwareTarget {
  if ((FIRMWARE_TARGETS as readonly string[]).includes(value)) {
    return value as FirmwareTarget;
  }
  throw new ExportError(`unknown firmware target "${value}"; supported: ${FIRMWARE_TARGETS.join(', ')}`);
}

export function sanitizeMacroSuffix(netName: string): string {
  const stripped = netName.trim().replace(/^\/+/, '');
  return stripped
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function normalizePinToken(rawPin: string): string {
  const trimmed = rawPin.trim();
  const primary = trimmed.split('/')[0]?.trim() || trimmed;
  return primary.replace(/[^A-Za-z0-9_]/g, '');
}

function isPowerOrIgnoredNet(net: string | null): boolean {
  if (!net) return true;
  const clean = net.trim().replace(/^\/+/, '');
  if (!clean) return true;
  if (/^Net-\(/i.test(clean)) return true;
  return POWER_NET_PATTERN.test(clean);
}

/**
 * Deterministically extract firmware pin assignments from the configured
 * schematic (supplemented by PINOUT.md pin names when a library symbol's pin
 * name is blank or `~`).
 */
export async function extractSchematicPinout(
  repoRoot: string,
  opts?: { ref?: string },
): Promise<FirmwarePinEntry[]> {
  const config = await loadConfig(repoRoot);
  if (!config.schematic || !existsSync(path.join(repoRoot, config.schematic))) {
    throw new ExportError('no schematic configured in .copperhead/config.json');
  }
  const schPath = path.join(repoRoot, config.schematic);
  const [symbols, nets] = await Promise.all([listSymbols(schPath), pinNets(schPath)]);

  const mcuRefs = new Set<string>();
  if (opts?.ref) {
    mcuRefs.add(opts.ref);
  } else {
    for (const s of symbols) {
      if (/^(?:U|IC)\d+/i.test(s.ref)) mcuRefs.add(s.ref);
    }
    if (mcuRefs.size === 0) {
      for (const s of symbols) mcuRefs.add(s.ref);
    }
  }

  // Optional PINOUT.md lookup for human pin names (e.g. PA5 on pin number 15)
  // when the schematic symbol definition uses `~` or numeric pin names.
  const pinoutNameByRefPin = new Map<string, string>();
  const pinoutPath = path.join(repoRoot, config.docs, 'PINOUT.md');
  if (existsSync(pinoutPath)) {
    const md = await readFile(pinoutPath, 'utf8');
    for (const row of parsePinoutRows(md)) {
      if (row.ref && row.pin) {
        pinoutNameByRefPin.set(`${row.ref}:${row.pin}`, row.pin);
      }
    }
  }

  const byMacro = new Map<string, FirmwarePinEntry>();
  const sortedNets = [...nets].sort((a, b) => {
    const r = a.ref.localeCompare(b.ref, undefined, { numeric: true });
    if (r !== 0) return r;
    return a.pinNumber.localeCompare(b.pinNumber, undefined, { numeric: true });
  });

  for (const pn of sortedNets) {
    if (!mcuRefs.has(pn.ref)) continue;
    if (isPowerOrIgnoredNet(pn.net)) continue;
    const suffix = sanitizeMacroSuffix(pn.net!);
    if (!suffix) continue;
    const macro = suffix.startsWith('PIN_') ? suffix : `PIN_${suffix}`;
    if (byMacro.has(macro)) continue;

    const fromSchName = pn.pinName && pn.pinName !== '~' ? normalizePinToken(pn.pinName) : '';
    const fromPinout = pinoutNameByRefPin.get(`${pn.ref}:${pn.pinNumber}`);
    const resolvedPin =
      (fromSchName && /[A-Za-z]/.test(fromSchName) ? fromSchName : '') ||
      (fromPinout ? normalizePinToken(fromPinout) : '') ||
      fromSchName ||
      normalizePinToken(pn.pinNumber);

    if (!resolvedPin) continue;
    byMacro.set(macro, {
      macro,
      signal: pn.net!.replace(/^\/+/, ''),
      pin: resolvedPin,
      ref: pn.ref,
      pinNumber: pn.pinNumber,
    });
  }

  return [...byMacro.values()].sort((a, b) => a.macro.localeCompare(b.macro, undefined, { numeric: true }));
}

export function renderFirmwareHeaderC(entries: FirmwarePinEntry[]): string {
  const lines: string[] = ['// Auto-generated from schematic. Do not edit manually.'];
  const maxMacroLen = entries.reduce((acc, e) => Math.max(acc, e.macro.length), 0);
  for (const entry of entries) {
    const pad = ' '.repeat(Math.max(3, maxMacroLen - entry.macro.length + 3));
    lines.push(`#define ${entry.macro}${pad}${entry.pin}`);
  }
  return lines.join('\n') + '\n';
}

export function parseFirmwareHeaderC(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    const m = /^#define\s+(PIN_[A-Za-z0-9_]+)\s+(\S+)/.exec(line);
    if (m) {
      map.set(m[1]!, m[2]!);
    }
  }
  return map;
}

export async function runExportFirmware(opts: ExportFirmwareOptions): Promise<ExportFirmwareResult> {
  const target = opts.target ?? 'c';
  parseFirmwareTarget(target);
  const outPath = opts.outPath ?? DEFAULT_FIRMWARE_HEADER;
  const pins = await extractSchematicPinout(opts.repoRoot, opts.ref ? { ref: opts.ref } : undefined);
  const content = renderFirmwareHeaderC(pins);
  const absOut = path.join(opts.repoRoot, outPath);
  await mkdir(path.dirname(absOut), { recursive: true });
  await writeFile(absOut, content, 'utf8');
  return { target, outPath, pins, content };
}

export async function checkFirmwareDrift(
  repoRoot: string,
  opts?: { headerPath?: string; ref?: string },
): Promise<FirmwareCheckResult> {
  const headerPath = opts?.headerPath ?? DEFAULT_FIRMWARE_HEADER;
  const absHeader = path.join(repoRoot, headerPath);
  const expectedEntries = await extractSchematicPinout(repoRoot, opts?.ref ? { ref: opts.ref } : undefined);

  if (!existsSync(absHeader)) {
    const mismatches: FirmwareDriftItem[] = expectedEntries.map((e) => ({
      macro: e.macro,
      schematicPin: e.pin,
      headerPin: null,
    }));
    if (mismatches.length === 0) {
      mismatches.push({
        macro: headerPath,
        schematicPin: 'present',
        headerPin: null,
      });
    }
    return {
      ok: false,
      headerPath,
      pinsChecked: expectedEntries.length,
      mismatches,
    };
  }

  const actualMap = parseFirmwareHeaderC(await readFile(absHeader, 'utf8'));
  const expectedMap = new Map<string, string>(expectedEntries.map((e) => [e.macro, e.pin]));
  const allMacros = [...new Set([...expectedMap.keys(), ...actualMap.keys()])].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );

  const mismatches: FirmwareDriftItem[] = [];
  for (const macro of allMacros) {
    const schPin = expectedMap.get(macro) ?? null;
    const hdrPin = actualMap.get(macro) ?? null;
    if (schPin !== hdrPin) {
      mismatches.push({
        macro,
        schematicPin: schPin,
        headerPin: hdrPin,
      });
    }
  }

  return {
    ok: mismatches.length === 0,
    headerPath,
    pinsChecked: expectedMap.size,
    mismatches,
  };
}

export function formatFirmwareCheckResult(result: FirmwareCheckResult): string {
  if (result.ok) {
    return `✓ Firmware pinout in sync (${result.pinsChecked} ${result.pinsChecked === 1 ? 'pin' : 'pins'} checked)`;
  }
  const lines: string[] = ['✗ Firmware drift detected'];
  for (const m of result.mismatches) {
    const sch = m.schematicPin ?? 'absent';
    const hdr = m.headerPin ?? 'absent';
    lines.push(`  ${m.macro}: schematic=${sch}, ${result.headerPath}=${hdr}`);
  }
  const count = result.mismatches.length;
  lines.push(`${count} ${count === 1 ? 'mismatch' : 'mismatches'} found. Run \`copperhead export firmware\` to resync.`);
  return lines.join('\n');
}
