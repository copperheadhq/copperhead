import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { listSymbols, pinNets, type PinNet, type SchematicSymbol } from './sexp.js';
import { parseCanonicalTables } from '../memory/bom-table.js';
import { ExportError } from '../commands/export.js';
import { resolveInRepo, SandboxError } from '../util/paths.js';

export const FIRMWARE_TARGETS = ['c'] as const;
export type FirmwareTarget = (typeof FIRMWARE_TARGETS)[number];

export const DEFAULT_FIRMWARE_HEADER = 'firmware/inc/pinout.h';
export const LEGACY_FIRMWARE_HEADER = 'firmware/src/pins.h';

const POWER_NET_PATTERN =
  /^(?:(?:A|D|P)?GND[A-Za-z0-9_]*|VSS[A-Za-z0-9_]*|AVSS[A-Za-z0-9_]*|VCC[A-Za-z0-9_]*|VDD[A-Za-z0-9_]*|AVDD[A-Za-z0-9_]*|VREF[A-Za-z0-9_]*|VSYS[A-Za-z0-9_]*|VBAT[A-Za-z0-9_]*|VBUS[A-Za-z0-9_]*|3V3(?:_[A-Za-z0-9_]+)?|5V(?:_[A-Za-z0-9_]+)?|1V8(?:_[A-Za-z0-9_]+)?|12V(?:_[A-Za-z0-9_]+)?|[+-]\d+(?:V\d*|\.\d+V?)(?:_[A-Za-z0-9_]+)?|PWR_FLAG|NC|unconnected-.*)$/i;

const GPIO_SEGMENT_PATTERN =
  /^(?:GPIO\d+|GP\d+|P[A-K]\d+|P\d+[._]\d+|DIO\d+|IO\d+)$/i;

const MCU_HINT_PATTERN =
  /(?:MCU|ESP32|STM32|RP2040|RP2350|NRF\d|ATMEGA|ATTINY|SAMD|ATSAM|PIC\d|CH32|GD32|LPC\d|MSP430|CORTEX)/i;

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

function sandboxPath(repoRoot: string, relPath: string): string {
  try {
    return resolveInRepo(repoRoot, relPath);
  } catch (err) {
    if (err instanceof SandboxError) {
      throw new ExportError(`firmware path escapes repository: ${relPath}`);
    }
    throw err;
  }
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

export function normalizePinToken(rawPin: string): string {
  const trimmed = rawPin.trim();
  if (!trimmed) return '';
  const segments = trimmed
    .split('/')
    .map((s) => s.trim().replace(/^~\{(.*)\}$/, '$1').replace(/^~/, ''))
    .filter(Boolean);
  for (const seg of segments) {
    const cleaned = seg.replace(/[^A-Za-z0-9_]/g, '');
    if (GPIO_SEGMENT_PATTERN.test(cleaned)) {
      return cleaned;
    }
  }
  const first = segments[0] ?? trimmed;
  return first.replace(/[^A-Za-z0-9_]/g, '');
}

function isPowerOrIgnoredNet(net: string | null): boolean {
  if (!net) return true;
  const clean = net.trim().replace(/^\/+/, '');
  if (!clean) return true;
  if (/^Net-\(/i.test(clean)) return true;
  return POWER_NET_PATTERN.test(clean);
}

function parsePinoutNameMap(md: string): Map<string, string> {
  const map = new Map<string, string>();
  const strip = (s: string | undefined): string => (s ?? '').replace(/`/g, '').trim();
  for (const { header, rows } of parseCanonicalTables(md)) {
    const col = (re: RegExp): number => header.cells.findIndex((c) => re.test(c));
    const refI = col(/^refdes$/i);
    const pinI = col(/^pin$/i);
    const nameI = col(/^name$/i);
    if (pinI < 0 || nameI < 0) continue;
    for (const row of rows) {
      const ref = refI >= 0 ? strip(row.cells[refI]) : '';
      const pin = strip(row.cells[pinI]);
      const name = strip(row.cells[nameI]);
      if (ref && pin && name) {
        map.set(`${ref}:${pin}`, name);
      }
    }
  }
  return map;
}

function selectMcuRefs(symbols: SchematicSymbol[], nets: PinNet[], explicitRef?: string): Set<string> {
  if (explicitRef) {
    return new Set([explicitRef]);
  }
  const icSymbols = symbols.filter((s) => /^(?:U|IC)\d+/i.test(s.ref));
  if (icSymbols.length <= 1) {
    return new Set(icSymbols.map((s) => s.ref));
  }
  const pinsByRef = new Map<string, PinNet[]>();
  for (const pn of nets) {
    let arr = pinsByRef.get(pn.ref);
    if (!arr) {
      arr = [];
      pinsByRef.set(pn.ref, arr);
    }
    arr.push(pn);
  }
  const mcuCandidates = icSymbols.filter((s) => {
    if (MCU_HINT_PATTERN.test(s.libId) || MCU_HINT_PATTERN.test(s.value)) return true;
    const refPins = pinsByRef.get(s.ref) ?? [];
    return refPins.some((p) => {
      const tok = normalizePinToken(p.pinName);
      return GPIO_SEGMENT_PATTERN.test(tok);
    });
  });
  if (mcuCandidates.length > 0) {
    return new Set(mcuCandidates.map((s) => s.ref));
  }
  return new Set(icSymbols.map((s) => s.ref));
}

/**
 * Deterministically extract firmware pin assignments from the configured
 * schematic (supplemented by PINOUT.md's Name column when a library symbol's
 * pin name is blank or `~`).
 */
export async function extractSchematicPinout(
  repoRoot: string,
  opts?: { ref?: string },
): Promise<FirmwarePinEntry[]> {
  const config = await loadConfig(repoRoot);
  if (!config.schematic) {
    throw new ExportError('no schematic configured in .copperhead/config.json');
  }
  const schPath = sandboxPath(repoRoot, config.schematic);
  if (!existsSync(schPath)) {
    throw new ExportError('no schematic configured in .copperhead/config.json');
  }
  const [symbols, nets] = await Promise.all([listSymbols(schPath), pinNets(schPath)]);

  const mcuRefs = selectMcuRefs(symbols, nets, opts?.ref);

  let pinoutNameByRefPin = new Map<string, string>();
  const pinoutPath = sandboxPath(repoRoot, path.join(config.docs, 'PINOUT.md'));
  if (existsSync(pinoutPath)) {
    const md = await readFile(pinoutPath, 'utf8');
    pinoutNameByRefPin = parsePinoutNameMap(md);
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
    const cleanSignal = pn.net!.trim().replace(/^\/+/, '');
    const suffix = sanitizeMacroSuffix(cleanSignal);
    if (!suffix) continue;
    const macro = suffix.startsWith('PIN_') ? suffix : `PIN_${suffix}`;

    const fromSchName = pn.pinName && pn.pinName !== '~' ? normalizePinToken(pn.pinName) : '';
    const fromPinout = pinoutNameByRefPin.get(`${pn.ref}:${pn.pinNumber}`);
    const resolvedPin =
      (fromSchName && /[A-Za-z]/.test(fromSchName) ? fromSchName : '') ||
      (fromPinout ? normalizePinToken(fromPinout) : '') ||
      fromSchName ||
      normalizePinToken(pn.pinNumber);

    if (!resolvedPin) continue;

    const existing = byMacro.get(macro);
    if (existing) {
      if (existing.signal !== cleanSignal) {
        throw new ExportError(
          `net name macro collision on ${macro}: "${existing.signal}" and "${cleanSignal}" both normalize to ${macro}`,
        );
      }
      // If two pins are on the same signal net, prefer a named GPIO/port pin over a bare number
      if (!/[A-Za-z]/.test(existing.pin) && /[A-Za-z]/.test(resolvedPin)) {
        byMacro.set(macro, {
          macro,
          signal: cleanSignal,
          pin: resolvedPin,
          ref: pn.ref,
          pinNumber: pn.pinNumber,
        });
      }
      continue;
    }

    byMacro.set(macro, {
      macro,
      signal: cleanSignal,
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
  const withoutBlockComments = content.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rawLine of withoutBlockComments.split(/\r?\n/)) {
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
  const absOut = sandboxPath(opts.repoRoot, outPath);
  const pins = await extractSchematicPinout(opts.repoRoot, opts.ref ? { ref: opts.ref } : undefined);
  const content = renderFirmwareHeaderC(pins);
  await mkdir(path.dirname(absOut), { recursive: true });
  await writeFile(absOut, content, 'utf8');
  return { target, outPath, pins, content };
}

export async function checkFirmwareDrift(
  repoRoot: string,
  opts?: { headerPath?: string; ref?: string },
): Promise<FirmwareCheckResult> {
  let headerPath = opts?.headerPath ?? DEFAULT_FIRMWARE_HEADER;
  if (!opts?.headerPath) {
    const defaultAbs = sandboxPath(repoRoot, DEFAULT_FIRMWARE_HEADER);
    const legacyAbs = sandboxPath(repoRoot, LEGACY_FIRMWARE_HEADER);
    if (!existsSync(defaultAbs) && existsSync(legacyAbs)) {
      headerPath = LEGACY_FIRMWARE_HEADER;
    }
  }
  const absHeader = sandboxPath(repoRoot, headerPath);
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
