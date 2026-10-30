import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { runInit } from '../src/memory/scaffold.js';
import { runCheck } from '../src/commands/check.js';
import { pinNets } from '../src/kicad/sexp.js';
import { isEngineAuthoredSchematic } from '../src/kicad/fab.js';
import { tempFixtureRepo, RGB_FIXTURE } from './helpers.js';

/**
 * The rgb-key fixture the AC-3.3 live test runs on (fixtures/rgb-key-source/README.md).
 * That test needs a model, so it is skipped in CI; this one keeps the fixture
 * itself honest offline: it loads, checks clean, and has the pins the test relies on.
 */
describe('rgb-key fixture', () => {
  it('initializes and checks clean, as a hand-drawn sheet', async () => {
    const { repo, cleanup } = await tempFixtureRepo(RGB_FIXTURE);
    try {
      const sch = path.join(repo, 'hardware', 'rgb-key.kicad_sch');
      // a hand-drawn sheet, so `do` edits it directly, as with open-key
      expect(isEngineAuthoredSchematic(await readFile(sch, 'utf8'))).toBe(false);
      await runInit({ repoRoot: repo, installHooks: false });
      const res = await runCheck(repo, () => {});
      expect(res.erc).toEqual({ ok: true, violations: 0 });
      expect(res.drift.ok).toBe(true);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('carries no KiCad-10-only tokens under its 20231120 header', async () => {
    // KiCad 9 refuses to load a sheet with these (fixtures/rgb-key-source/README.md, step 4)
    const text = await readFile(path.join(RGB_FIXTURE, 'hardware', 'rgb-key.kicad_sch'), 'utf8');
    expect(text).not.toMatch(/\((in_pos_files|duplicate_pin_numbers_are_jumpers)\b/);
  });

  it('has one RGB LED on GPIO4/5/6 and room for a second', async () => {
    const pins = await pinNets(path.join(RGB_FIXTURE, 'hardware', 'rgb-key.kicad_sch'));
    const u1 = new Map(pins.filter((p) => p.ref === 'U1').map((p) => [p.pinName, p.net]));
    expect([u1.get('GPIO4'), u1.get('GPIO5'), u1.get('GPIO6')]).toEqual(['LED_R', 'LED_G', 'LED_B']);
    expect(u1.get('GPIO14')).toBe('KEY_DAH');
    // free and not strapping: three channels of a second LED fit without GPIO0/GPIO3
    for (const gpio of ['GPIO7', 'GPIO8', 'GPIO9', 'GPIO18', 'GPIO21']) expect(u1.get(gpio), gpio).toBeNull();
    const d1 = new Map(pins.filter((p) => p.ref === 'D1').map((p) => [p.pinName, p.net]));
    expect(Object.fromEntries(d1)).toEqual({ RK: 'LED_RK', GK: 'LED_GK', BK: 'LED_BK', A: '3V3' });
  });
});
