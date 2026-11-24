import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  boardResaveSupported,
  hasBoardResaveFlag,
  hasZoneRefillFlags,
  refillAndSave,
  resetKicadCliCache,
  resolveKicadCli,
  runDrc,
  zoneRefillSupported,
} from '../src/kicad/cli.js';
import type { CheckReport } from '../src/kicad/report.js';
import {
  assignZoneIds,
  boardVersion,
  fillMismatches,
  listZones,
  refreshZoneFills,
  spliceRegressions,
  spliceZoneFills,
  unfilledZones,
  verifySplice,
  ZoneFillError,
  type RefilledCopy,
  ZoneRefillUnavailableError,
  type ZoneFillRefresh,
} from '../src/kicad/zones.js';

/**
 * Copper pour fills (change refill-zone-fills, AC-22.1 to AC-22.7). The
 * fixtures are a KiCad 8-format board with GND pours on F.Cu and B.Cu beside
 * a project whose default clearance (0.8 mm) is wider than the zones' own
 * (0.5 mm), so only a fill computed with the project's rules passes DRC.
 * `unfilled` has outlines only (the F.Cu zone lacks filled_areas_thickness,
 * the B.Cu zone lacks a uuid); `fresh` is `unfilled` after one refresh;
 * `stale` is `fresh` with J2 moved into the pour without a refill.
 */
const ZONES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'zones');
const fixture = (name: string): Promise<string> => readFile(path.join(ZONES, `${name}.kicad_pcb`), 'utf8');
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

const dirs: string[] = [];
/** A scratch project holding the board as zones.kicad_pcb, beside the fixture's rules unless `withRules` is false. */
async function project(boardText: string, withRules = true): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-zones-test-'));
  dirs.push(dir);
  if (withRules) await copyFile(path.join(ZONES, 'zones.kicad_pro'), path.join(dir, 'zones.kicad_pro'));
  const board = path.join(dir, 'zones.kicad_pcb');
  await writeFile(board, boardText, 'utf8');
  return board;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** KiCad's own refill of `boardText`, made in a scratch project beside the fixture's rules. */
async function kicadRefill(boardText: string): Promise<{ scratch: string } & RefilledCopy> {
  const scratch = await project(boardText);
  const report = await refillAndSave(scratch);
  return { scratch, text: await readFile(scratch, 'utf8'), report };
}

/**
 * The board's F.Cu and B.Cu gerbers, each as its file name and content,
 * without the comment and attribute lines that carry the date and KiCad's
 * version. `extra` goes to kicad-cli (`--check-zones`).
 */
async function copperGerbers(board: string, extra: string[] = []): Promise<string[]> {
  const out = path.join(path.dirname(board), `gerbers-${extra.join('')}`);
  await mkdir(out, { recursive: true });
  await execa(resolveKicadCli(), [
    'pcb', 'export', 'gerbers', ...extra, '--no-x2', '--no-netlist', '--layers', 'F.Cu,B.Cu',
    '--output', `${out}${path.sep}`, board,
  ]);
  const names = (await readdir(out)).filter((n) => !n.endsWith('.gbrjob')).sort();
  expect(names).toHaveLength(2);
  return Promise.all(
    names.map(async (n) => {
      const lines = (await readFile(path.join(out, n), 'utf8')).split(/\r?\n/);
      return `${n}\n${lines.filter((l) => !/^(G04|%TF|%TA|%TD)/.test(l)).join('\n')}`;
    }),
  );
}

/** The text with every zone replaced by a placeholder: what a refresh must leave byte-identical. */
function outsideZones(text: string): string {
  let out = text;
  for (const z of [...listZones(text)].reverse()) out = out.slice(0, z.span.start) + '<zone>' + out.slice(z.span.end);
  return out;
}

const ID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID_B = 'bbbbbbbb-0000-4000-8000-000000000002';

/** A KiCad 8-style board (two-space indent) around `body`. */
const v8 = (body: string, version = 20240108): string =>
  `(kicad_pcb\n  (version ${version})\n  (generator "pcbnew")\n  (net 0 "")\n  (net 1 "GND")\n${body}\n)\n`;
/** A KiCad 8-style unfilled zone; `fills` go after the outline. */
const zone8 = (id: string | null, opts: { fills?: string; fill?: string; layer?: string } = {}): string =>
  `  (zone (net 1) (net_name "GND") (layer "${opts.layer ?? 'F.Cu'}")${id ? ` (uuid "${id}")` : ''} (hatch edge 0.5)\n` +
  `    (min_thickness 0.25)\n` +
  (opts.fill ?? `    (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))\n`) +
  `    (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10)))${opts.fills ?? ''}\n` +
  `  )`;
/** A KiCad 10-style board (tabs), as kicad-cli saves a refilled copy. */
const v10 = (body: string, version = 20260206): string => `(kicad_pcb\n\t(version ${version})\n\t(generator "pcbnew")\n${body}\n)\n`;
const FILL10 = (x = 1): string =>
  `\t\t(filled_polygon\n\t\t\t(layer "F.Cu")\n\t\t\t(pts\n\t\t\t\t(xy ${x} 1) (xy 9 1) (xy 9 9)\n\t\t\t)\n\t\t)\n`;
const zone10 = (id: string, fills = FILL10(), extra = ''): string =>
  `\t(zone\n\t\t(net "GND")\n\t\t(layer "F.Cu")\n\t\t(uuid "${id}")\n\t\t(min_thickness 0.25)\n${extra}` +
  `\t\t(fill yes\n\t\t\t(thermal_gap 0.5)\n\t\t)\n\t\t(polygon\n\t\t\t(pts\n\t\t\t\t(xy 0 0) (xy 10 0) (xy 10 10)\n\t\t\t)\n\t\t)\n${fills}\t)`;
/** The KiCad 8 rendering of FILL10, as the splice should write it into a KiCad 8 zone. */
const FILL8 = (x = 1): string =>
  `\n    (filled_polygon\n      (layer "F.Cu")\n      (pts\n        (xy ${x} 1) (xy 9 1) (xy 9 9)\n      )\n    )`;

describe('zone listing', () => {
  it('finds board and footprint zones, keyed by id, and tells pours from rule areas', () => {
    const text = v8(
      zone8(ID_A) +
        '\n  (zone (net 0) (net_name "") (layer "F.Cu") (uuid "cccccccc-0000-4000-8000-000000000003") (name "keep (out)")\n' +
        '    (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))\n' +
        '    (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1)))\n  )\n' +
        '  (footprint "x:Mod" (layer "F.Cu") (uuid "dddddddd-0000-4000-8000-000000000004")\n' +
        '    (property "Reference" "U1" (at 0 0 0) (layer "F.SilkS"))\n' +
        '    (zone (net 0) (net_name "") (layers "F.Cu" "B.Cu") (uuid "eeeeeeee-0000-4000-8000-000000000005")\n' +
        '      (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))\n' +
        '      (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1)))\n    )\n  )',
    );
    const zones = listZones(text);
    expect(zones.map((z) => z.key)).toEqual([
      ID_A,
      'cccccccc-0000-4000-8000-000000000003',
      'dddddddd-0000-4000-8000-000000000004/eeeeeeee-0000-4000-8000-000000000005',
    ]);
    expect(zones.map((z) => z.fillable)).toEqual([true, false, false]);
    expect(zones[0]!.label).toBe('the GND zone on F.Cu (aaaaaaaa)');
    expect(zones[2]!.label).toBe("U1's zone on F.Cu, B.Cu (eeeeeeee)");
  });

  it('reads KiCad 10 net syntax and names a zone with no id', () => {
    expect(listZones(v10(zone10(ID_A)))[0]!.label).toBe('the GND zone on F.Cu (aaaaaaaa)');
    expect(listZones(v8(zone8(null)))[0]).toMatchObject({ key: null, label: 'the GND zone on F.Cu (no uuid)' });
  });

  it('reports pours with no fill, and only those', () => {
    const text = v8(`${zone8(ID_A)}\n${zone8(ID_B, { fills: FILL8() })}`);
    expect(unfilledZones(text).map((z) => z.key)).toEqual([ID_A]);
  });

  it('reads the board format version', () => {
    expect(boardVersion(v8(''))).toBe(20240108);
    expect(boardVersion(v10(''))).toBe(20260206);
    expect(boardVersion('(kicad_pcb)')).toBe(0);
  });
});

describe('zone ids (AC-22.5)', () => {
  it('leaves a board whose zones all have unique ids unchanged', () => {
    const text = v8(`${zone8(ID_A)}\n${zone8(ID_B)}`);
    expect(assignZoneIds(text)).toBe(text);
  });

  it('gives a zone with no id the same uuid every time, after its layer', () => {
    const text = v8(zone8(null));
    const once = assignZoneIds(text);
    expect(assignZoneIds(text)).toBe(once);
    expect(once).toMatch(/\(layer "F\.Cu"\) \(uuid "[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"\) \(hatch/);
    expect(assignZoneIds(once)).toBe(once);
  });

  it('replaces the second of two repeated ids and keeps the first', () => {
    const text = v8(`${zone8(ID_A)}\n${zone8(ID_A, { layer: 'B.Cu' })}`);
    const keys = listZones(assignZoneIds(text)).map((z) => z.key);
    expect(keys[0]).toBe(ID_A);
    expect(keys[1]).not.toBe(ID_A);
    expect(new Set(keys).size).toBe(2);
  });

  it('uses tstamp in a KiCad 6/7 file', () => {
    const text = v8(zone8(null).replace('(hatch', '(hatch').replace(/\(uuid "[^"]*"\) /, ''), 20221018).replace(
      '(generator "pcbnew")',
      '(generator "pcbnew")\n  (gr_line (start 0 0) (end 1 1) (layer "Edge.Cuts") (width 0.1) (tstamp 11111111-0000-4000-8000-000000000000))',
    );
    expect(assignZoneIds(text)).toMatch(/\(layer "F\.Cu"\) \(tstamp [0-9a-f-]{36}\) \(hatch/);
  });
});

describe('fill splice', () => {
  it('fills a KiCad 8 pour from a KiCad 10 refill, changing only fill data and its flags (AC-22.1)', () => {
    const original = v8(`${zone8(ID_A)}\n${zone8(ID_B)}`);
    const refilled = v10(`${zone10(ID_A)}\n${zone10(ID_B, FILL10(2))}`);
    const { text, changed } = spliceZoneFills(original, refilled);
    const filled = (id: string, x: number): string =>
      `  (zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "${id}") (hatch edge 0.5)\n` +
      `    (min_thickness 0.25) (filled_areas_thickness no)\n` +
      `    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))\n` +
      `    (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10)))${FILL8(x)}\n` +
      `  )`;
    expect(text).toBe(v8(`${filled(ID_A, 1)}\n${filled(ID_B, 2)}`));
    expect(changed).toEqual(['the GND zone on F.Cu (aaaaaaaa)', 'the GND zone on F.Cu (bbbbbbbb)']);
  });

  it('replaces every old fill block with the new ones, leaving no blank lines', () => {
    const old = FILL8(5) + FILL8(6);
    const original = v8(zone8(ID_A, { fill: `    (fill yes (thermal_gap 0.5))\n`, fills: old }));
    const { text } = spliceZoneFills(original, v10(zone10(ID_A)));
    expect(text).toContain(`(xy 10 10)))${FILL8(1)}\n  )`);
    expect(text).not.toContain('(xy 5 1)');
    expect(text).not.toContain('(xy 6 1)');
    expect(text).not.toMatch(/\n[ \t]*\n/);
  });

  it('returns the text unchanged when the fill is already current', () => {
    const original = v8(zone8(ID_A, { fill: `    (fill yes (thermal_gap 0.5))\n`, fills: FILL8() })).replace(
      '(min_thickness 0.25)',
      '(min_thickness 0.25) (filled_areas_thickness no)',
    );
    expect(spliceZoneFills(original, v10(zone10(ID_A)))).toEqual({ text: original, changed: [] });
  });

  it('keeps CRLF line endings', () => {
    const original = v8(zone8(ID_A)).replace(/\n/g, '\r\n');
    const { text } = spliceZoneFills(original, v10(zone10(ID_A)));
    expect(text).toContain('(filled_polygon');
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('adds no thickness token when the original is the refill format and neither carries it', () => {
    const original = v10(zone10(ID_A, '').replace('(fill yes', '(fill'));
    const { text } = spliceZoneFills(original, v10(zone10(ID_A)));
    expect(text).not.toContain('filled_areas_thickness');
    expect(text).toContain('\t\t(fill yes\n');
    expect(text).toContain(`\t\t)\n${FILL10()}\t)`);
  });

  it('adds the thickness token when the refilled zone carries it, same format (AC-22.3)', () => {
    const refilled = v10(zone10(ID_A, FILL10(), '\t\t(filled_areas_thickness no)\n'), 20240108);
    const { text } = spliceZoneFills(v8(zone8(ID_A)), refilled);
    expect(text).toContain('(min_thickness 0.25) (filled_areas_thickness no)');
  });

  it('turns a legacy thickness flag off in an older format', () => {
    const original = v8(zone8(ID_A)).replace('(min_thickness 0.25)', '(min_thickness 0.25) (filled_areas_thickness yes)');
    const { text } = spliceZoneFills(original, v10(zone10(ID_A)));
    expect(text).toContain('(min_thickness 0.25) (filled_areas_thickness no)');
    expect(text).not.toContain('thickness yes');
  });

  it('writes a fill flag into a zone that has no fill settings at all', () => {
    const original = v8(zone8(ID_A, { fill: '' }).replace('    (min_thickness 0.25)\n', ''));
    const { text } = spliceZoneFills(original, v10(zone10(ID_A)));
    expect(text).toContain('(hatch edge 0.5)\n    (fill yes)\n    (filled_areas_thickness no)\n    (polygon');
  });

  it('leaves rule areas alone', () => {
    const keepout =
      `  (zone (net 0) (net_name "") (layer "F.Cu") (uuid "${ID_B}")\n` +
      '    (keepout (tracks not_allowed))\n    (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1)))\n  )';
    const original = v8(`${zone8(ID_A)}\n${keepout}`);
    const refilled = v10(`${zone10(ID_A)}\n\t(zone\n\t\t(uuid "${ID_B}")\n\t\t(keepout\n\t\t\t(tracks not_allowed)\n\t\t)\n\t)`);
    const { text, changed } = spliceZoneFills(original, refilled);
    expect(text).toContain(keepout);
    expect(changed).toHaveLength(1);
  });

  it('refuses a zone KiCad dropped, naming it', () => {
    expect(() => spliceZoneFills(v8(`${zone8(ID_A)}\n${zone8(ID_B)}`), v10(zone10(ID_A)))).toThrow(
      /KiCad dropped the GND zone on F\.Cu \(bbbbbbbb\)/,
    );
  });

  it('refuses a zone with no id', () => {
    expect(() => spliceZoneFills(v8(zone8(null)), v10(zone10(ID_A)))).toThrow(ZoneFillError);
  });
});

describe('splice check (AC-22.6)', () => {
  it('names each pour KiCad reads back with a different fill', () => {
    const refilled = v10(`${zone10(ID_A)}\n${zone10(ID_B, FILL10(2))}`);
    expect(fillMismatches(refilled, refilled)).toEqual([]);
    expect(fillMismatches(refilled, refilled.replace(/\t/g, '  '))).toEqual([]);
    expect(fillMismatches(refilled, v10(`${zone10(ID_A, FILL10(3))}\n${zone10(ID_B, FILL10(2))}`))).toEqual([
      'the GND zone on F.Cu (aaaaaaaa)',
    ]);
    expect(fillMismatches(refilled, refilled.replace('(fill yes', '(fill'))).toEqual(['the GND zone on F.Cu (aaaaaaaa)']);
    expect(fillMismatches(refilled, v10(zone10(ID_A)))).toEqual(['the GND zone on F.Cu (bbbbbbbb)']);
  });

  const report = (types: string[], unrouted = 0): CheckReport => ({
    ok: types.length === 0,
    source: 'drc',
    violations: types.map((type) => ({ severity: 'error', type, description: type, items: [] })),
    unrouted,
  });

  it('without a resave, passes a splice whose DRC is no worse than KiCad, and names each type that is worse', () => {
    expect(spliceRegressions(report(['clearance']), report(['clearance']))).toEqual([]);
    expect(spliceRegressions(report([]), report(['clearance']))).toEqual([]);
    expect(spliceRegressions(report(['clearance', 'clearance', 'shorting_items']), report(['clearance']))).toEqual([
      'clearance (2 vs 1)',
      'shorting_items (1 vs 0)',
    ]);
    expect(spliceRegressions(report([], 2), report([], 1))).toEqual(['unconnected items (2 vs 1)']);
  });
});

// each case runs kicad-cli DRC two to five times: well inside a minute alone,
// but the full suite runs files in parallel, as board-populate's DRC tests allow for
describe('zone fill refresh with kicad-cli', { timeout: 180_000 }, () => {
  let unfilled: string;
  let refreshed: ZoneFillRefresh;
  let board: string;

  beforeAll(async () => {
    unfilled = await fixture('unfilled');
    board = await project(unfilled);
    refreshed = await refreshZoneFills(board);
  }, 120_000);

  it('this kicad-cli can refill zones (AC-22.7)', async () => {
    expect(await zoneRefillSupported()).toBe(true);
  });

  it('the fixtures: fresh passes DRC beside the project, stale fails on the old fill', async () => {
    expect((await runDrc(await project(await fixture('fresh')))).ok).toBe(true);
    const stale = await runDrc(await project(await fixture('stale')));
    expect(stale.ok).toBe(false);
    expect(stale.violations.map((v) => v.type)).toContain('clearance');
  });

  it('fills both pours, changes nothing outside them, and never writes the board (AC-22.1)', async () => {
    expect(refreshed.changed).toBe(true);
    expect(refreshed.zones).toHaveLength(2);
    expect(unfilledZones(refreshed.text)).toEqual([]);
    expect(listZones(refreshed.text).every((z) => z.fills.length > 0)).toBe(true);
    expect(outsideZones(refreshed.text)).toBe(outsideZones(unfilled));
    expect(refreshed.text.slice(0, 80)).toBe(unfilled.slice(0, 80));
    expect(sha(await readFile(board, 'utf8'))).toBe(sha(unfilled));
    expect(refreshed.report?.unrouted).toBe(0);
  });

  it('fills with the project rules, which a fill made without them breaks (AC-22.2)', async () => {
    const inPlace = await runDrc(await project(refreshed.text));
    expect(inPlace.ok).toBe(true);
    expect(inPlace.unrouted).toBe(0);
    // the control: the same board filled with no project file beside it uses
    // KiCad's default clearance, and fails the project's 0.8 mm
    const ruleless = await refreshZoneFills(await project(unfilled, false));
    const checked = await runDrc(await project(ruleless.text));
    expect(checked.violations.filter((v) => v.type === 'clearance').length).toBeGreaterThan(0);
  });

  it("gives the hand-written zone KiCad's thickness setting, so its fill is not inflated (AC-22.3)", () => {
    const fcu = listZones(refreshed.text)[0]!;
    expect(refreshed.text.slice(fcu.span.start, fcu.span.end)).toContain('(min_thickness 0.25) (filled_areas_thickness no)');
  });

  it('is stable: a second refresh changes nothing, and the new id is the same every time (AC-22.4, AC-22.5)', async () => {
    const again = await refreshZoneFills(board, refreshed.text);
    expect(again.changed).toBe(false);
    expect(again.text).toBe(refreshed.text);
    expect(refreshed.idsAssigned).toBe(true);
    expect(refreshed.text).toBe(await fixture('fresh'));
  });

  /** `fresh` with the F.Cu zone's thickness token removed: KiCad 8 reads its fill as legacy and inflates it. */
  const legacyRead = async (): Promise<string> => {
    const fresh = await fixture('fresh');
    const legacy = fresh.replace('(min_thickness 0.25) (filled_areas_thickness no)', '(min_thickness 0.25)');
    expect(legacy).not.toBe(fresh);
    return legacy;
  };

  it('refuses a splice KiCad reads back differently, naming the pour: here a fill read as legacy (AC-22.6)', async () => {
    const { scratch, ...kicads } = await kicadRefill(await fixture('fresh'));
    expect(await boardResaveSupported()).toBe(true);
    const err = await verifySplice(scratch, await legacyRead(), kicads).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZoneFillError);
    expect((err as Error).message).toMatch(
      /do not match KiCad's own refill: KiCad reads back a different fill for the GND zone on F\.Cu \(3c3c3c3c\);/,
    );
    expect((err as Error).message).not.toContain('B.Cu');
    // the same check passes the splice the refresh made
    await expect(verifySplice(scratch, await fixture('fresh'), kicads)).resolves.toBeUndefined();
  });

  it('plots the same copper as KiCad’s own refill, which a legacy-read fill does not', async () => {
    const ours = await copperGerbers(await project(refreshed.text));
    const { scratch } = await kicadRefill(unfilled);
    expect(ours).toEqual(await copperGerbers(scratch));
    // KiCad refilling in memory for the plot, beside the same rules
    expect(ours).toEqual(await copperGerbers(await project(unfilled), ['--check-zones']));
    // and the comparison can fail: no pour at all, or an inflated one
    expect(await copperGerbers(await project(unfilled))).not.toEqual(ours);
    expect(await copperGerbers(await project(await legacyRead()))).not.toEqual(ours);
  });

  it('falls back to comparing DRC when kicad-cli cannot resave a board', async () => {
    if (process.platform === 'win32') return;
    const { scratch, ...kicads } = await kicadRefill(await fixture('fresh'));
    const real = resolveKicadCli();
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-zones-wrap-'));
    dirs.push(dir);
    const log = path.join(dir, 'calls.log');
    const bin = path.join(dir, 'kicad-cli');
    await writeFile(
      bin,
      `#!/bin/sh\necho "$@" >> "${log}"\n` +
        `if [ "$1 $2" = "pcb upgrade" ]; then echo "unknown command: upgrade" >&2; exit 1; fi\nexec "${real}" "$@"\n`,
      'utf8',
    );
    await chmod(bin, 0o755);
    const saved = process.env.COPPERHEAD_KICAD_CLI;
    process.env.COPPERHEAD_KICAD_CLI = bin;
    resetKicadCliCache();
    try {
      expect(await boardResaveSupported()).toBe(false);
      await expect(verifySplice(scratch, await legacyRead(), kicads)).rejects.toThrow(
        /do not match KiCad's own refill: the spliced board has more DRC findings \(.*clearance/,
      );
      expect(await readFile(log, 'utf8')).not.toContain('upgrade --force');
    } finally {
      if (saved === undefined) delete process.env.COPPERHEAD_KICAD_CLI;
      else process.env.COPPERHEAD_KICAD_CLI = saved;
      resetKicadCliCache();
    }
  });

  it('refreshes a stale pour so the moved part passes', async () => {
    const stale = await fixture('stale');
    const r = await refreshZoneFills(await project(stale));
    expect(r.changed).toBe(true);
    expect(r.idsAssigned).toBe(false);
    expect(outsideZones(r.text)).toBe(outsideZones(stale));
    expect((await runDrc(await project(r.text))).ok).toBe(true);
  });

  it('keeps a CRLF board CRLF', async () => {
    const crlf = unfilled.replace(/\n/g, '\r\n');
    const r = await refreshZoneFills(await project(crlf));
    expect(r.text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(r.text.replace(/\r\n/g, '\n')).toBe(refreshed.text);
  });
});

describe('zone fill refresh without a usable kicad-cli', () => {
  const saved = process.env.COPPERHEAD_KICAD_CLI;
  afterEach(() => {
    if (saved === undefined) delete process.env.COPPERHEAD_KICAD_CLI;
    else process.env.COPPERHEAD_KICAD_CLI = saved;
    resetKicadCliCache();
  });

  /** A fake kicad-cli that prints `help` and records each call in `log`. */
  async function fakeKicad(help: string): Promise<{ log: string }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-zones-fake-'));
    dirs.push(dir);
    const log = path.join(dir, 'calls.log');
    const bin = path.join(dir, 'kicad-cli');
    await writeFile(bin, `#!/bin/sh\necho "$@" >> "${log}"\necho "${help}"\n`, 'utf8');
    await chmod(bin, 0o755);
    process.env.COPPERHEAD_KICAD_CLI = bin;
    resetKicadCliCache();
    return { log };
  }

  it('reads the refill and resave flags from help text', () => {
    expect(hasZoneRefillFlags('[--exit-code-violations] [--refill-zones] [--save-board] INPUT_FILE')).toBe(true);
    expect(hasZoneRefillFlags('[--exit-code-violations] [--refill-zones] INPUT_FILE')).toBe(false);
    expect(hasZoneRefillFlags('Usage: pcb drc [--help] [--output OUTPUT_FILE] INPUT_FILE')).toBe(false);
    expect(hasBoardResaveFlag('Usage: pcb upgrade [--help] [--force] INPUT_FILE')).toBe(true);
    expect(hasBoardResaveFlag('Error: unknown command: upgrade')).toBe(false);
  });

  it('says refill is unavailable when kicad-cli has no refill flags, and refills nothing (AC-22.7)', async () => {
    if (process.platform === 'win32') return;
    const { log } = await fakeKicad('Usage: pcb drc [--help] [--output OUTPUT_FILE] [--exit-code-violations] INPUT_FILE');
    expect(await zoneRefillSupported()).toBe(false);
    await expect(refreshZoneFills(await project(await fixture('unfilled')))).rejects.toBeInstanceOf(ZoneRefillUnavailableError);
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['pcb drc --help']);
  });

  it('runs no kicad-cli for a board without pours', async () => {
    if (process.platform === 'win32') return;
    const { log } = await fakeKicad('');
    const text = v8('  (gr_line (start 0 0) (end 1 1) (layer "Edge.Cuts") (uuid "11111111-0000-4000-8000-000000000000"))');
    const r = await refreshZoneFills(await project(text));
    expect(r).toEqual({ text, changed: false, zones: [], idsAssigned: false, report: null });
    expect(existsSync(log)).toBe(false);
  });
});
