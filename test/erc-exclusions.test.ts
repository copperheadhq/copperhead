import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { validateIntent, parseIntent, type IntentErcExclusion } from '../src/kicad/draft/ir.js';
import { SymbolSource } from '../src/kicad/draft/symsource.js';
import { normalizeReport, formatViolations, excludedSummary } from '../src/kicad/report.js';
import { applyErcExclusions, excuses, intentErcExclusionsFor, symbolPinOf } from '../src/kicad/erc-exclusions.js';

/**
 * ERC exclusions in the schematic intent (#355).
 *
 * The case that motivated them: stock KiCad symbols type the LIS3DH's SDO/SA0
 * as Output and the TPS22917's QOD as open collector beside a power-output
 * VOUT, so the wiring both datasheets require (SA0 to GND for address 0x18,
 * QOD to VOUT for quick discharge) fails ERC, and nothing in the IR could say
 * the connection was meant. The report below is shaped like kicad-cli 10's.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');
const DRAFT_FIXTURE = path.join(HERE, 'fixtures', 'draft');

const pin = (ref: string, n: string, name: string, type: string, hidden = false) => ({
  description: `Symbol ${ref} ${hidden ? 'Hidden pin' : 'Pin'} ${n} [${name}, ${type}, Line]`,
  pos: { x: 1, y: 2 },
});

const kicadErc = () => ({
  sheets: [
    {
      path: '/',
      violations: [
        {
          type: 'pin_to_pin',
          severity: 'error',
          description: 'Pins of type Output and Power output are connected',
          items: [pin('U9', '7', 'SDO', 'Output'), pin('#FLG01', '1', 'pwr', 'Power output', true)],
        },
        {
          type: 'pin_to_pin',
          severity: 'error',
          description: 'Pins of type Open collector and Power output are connected',
          items: [pin('U3', '5', 'QOD', 'Open collector'), pin('U3', '6', 'VOUT', 'Power output')],
        },
        {
          type: 'pin_not_connected',
          severity: 'error',
          description: 'Pin not connected',
          items: [pin('U5', '12', 'PA2', 'Bidirectional')],
        },
      ],
    },
  ],
});

const SA0: IntentErcExclusion = {
  type: 'pin_to_pin',
  pins: ['U9.7'],
  reason: 'SA0 tied to GND selects I2C address 0x18 (SPEC item 20)',
};
const QOD: IntentErcExclusion = {
  type: 'pin_to_pin',
  pins: ['U3.5', 'U3.6'],
  reason: 'QOD to VOUT enables quick output discharge per the TPS22917 datasheet (SPEC item 17)',
};

describe('symbolPinOf', () => {
  it('reads a pin and a hidden power-flag pin, nothing else', () => {
    expect(symbolPinOf('Symbol U9 Pin 7 [SDO, Output, Line]')).toEqual({ ref: 'U9', pin: '7' });
    expect(symbolPinOf('Symbol #FLG01 Hidden pin 1 [pwr, Power output, Line]')).toEqual({ ref: '#FLG01', pin: '1' });
    expect(symbolPinOf('Symbol J1 Pin A12 [GND, Passive, Line]')).toEqual({ ref: 'J1', pin: 'A12' });
    expect(symbolPinOf('Label "I2C1_SDA"')).toBeNull();
  });
});

describe('excuses', () => {
  const [sa0, qod] = normalizeReport(kicadErc(), 'erc').violations;

  it('matches when every part pin is listed; power-flag pins need no listing', () => {
    expect(excuses(SA0, sa0!)).toBe(true);
    expect(excuses(QOD, qod!)).toBe(true);
  });

  it('refuses a different check, or a part pin the entry does not list', () => {
    expect(excuses({ ...SA0, type: 'pin_not_driven' }, sa0!)).toBe(false);
    expect(excuses({ ...QOD, pins: ['U3.5'] }, qod!)).toBe(false);
    expect(excuses(SA0, qod!)).toBe(false);
  });

  it('never excuses a finding with a non-pin item, or one naming only power symbols', () => {
    const withLabel = { ...sa0!, items: [...sa0!.items, { description: 'Label "GND"' }] };
    expect(excuses(SA0, withLabel)).toBe(false);
    const flagsOnly = { ...sa0!, items: [sa0!.items[1]!] };
    expect(excuses({ ...SA0, pins: ['U1.1'] }, flagsOnly)).toBe(false);
  });
});

describe('applyErcExclusions', () => {
  it('moves excused findings aside with their reasons and recomputes ok', () => {
    const r = applyErcExclusions(normalizeReport(kicadErc(), 'erc'), [SA0, QOD]);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.type)).toEqual(['pin_not_connected']);
    expect(r.excluded?.map((v) => v.reason)).toEqual([SA0.reason, QOD.reason]);
    expect(r.unusedExclusions).toBeUndefined();
  });

  it('passes ERC when every finding is excused', () => {
    const raw = kicadErc();
    raw.sheets[0]!.violations.pop();
    const r = applyErcExclusions(normalizeReport(raw, 'erc'), [SA0, QOD]);
    expect(r.ok).toBe(true);
    expect(r.excluded).toHaveLength(2);
  });

  it('reports an entry that excused nothing', () => {
    const stale: IntentErcExclusion = { type: 'pin_to_pin', pins: ['U4.5', 'U4.6'], reason: 'second switch' };
    const r = applyErcExclusions(normalizeReport(kicadErc(), 'erc'), [SA0, stale]);
    expect(r.unusedExclusions).toEqual([stale]);
  });

  it('leaves a report untouched when there are no exclusions', () => {
    const report = normalizeReport(kicadErc(), 'erc');
    expect(applyErcExclusions(report, [])).toBe(report);
  });
});

describe('reporting excluded findings', () => {
  it('prints every excluded finding with its reason, and stale entries, even when clean', () => {
    const raw = kicadErc();
    raw.sheets[0]!.violations.pop();
    const stale: IntentErcExclusion = { type: 'pin_to_pin', pins: ['U4.5'], reason: 'r' };
    const text = formatViolations(applyErcExclusions(normalizeReport(raw, 'erc'), [SA0, QOD, stale]));
    expect(text).toMatch(/^ERC: clean; 2 finding\(s\) excluded by the intent/);
    expect(text).toContain('Symbol U9 Pin 7 [SDO, Output, Line]');
    expect(text).toContain(`reason (U9.7): ${SA0.reason}`);
    expect(text).toContain(`reason (U3.5, U3.6): ${QOD.reason}`);
    expect(text).toContain('ercExclusions entry pin_to_pin [U4.5] excused no finding');
  });

  it('summarises them in one line for the run summary', () => {
    const r = applyErcExclusions(normalizeReport(kicadErc(), 'erc'), [SA0]);
    expect(excludedSummary(r)).toBe(`; 1 excluded by the intent (pin_to_pin U9.7: ${SA0.reason})`);
    expect(excludedSummary(normalizeReport(kicadErc(), 'erc'))).toBe('');
  });
});

describe('intentErcExclusionsFor', () => {
  const sheet = (generator: string) => `(kicad_sch (version 20231120) (generator "${generator}")\n)\n`;

  it('reads the intent beside an engine-drafted sheet, and nothing for a hand-drawn one', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-ercx-'));
    try {
      const sch = path.join(dir, 'board.kicad_sch');
      await writeFile(
        path.join(dir, 'schematic.intent.json'),
        JSON.stringify({ version: 1, parts: [], nets: [], ercExclusions: [SA0, { type: 'pin_to_pin', pins: 'U1.1', reason: 'bad' }] }),
      );
      await writeFile(sch, sheet('copperhead-draft'));
      expect(await intentErcExclusionsFor(sch)).toEqual([SA0]);
      await writeFile(sch, sheet('eeschema'));
      expect(await intentErcExclusionsFor(sch)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('validateIntent: ercExclusions', () => {
  async function validateWith(ercExclusions: unknown) {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-ercx-ir-'));
    try {
      await cp(path.join(DRAFT_FIXTURE, 'docs'), path.join(repo, 'docs'), { recursive: true });
      const { intent } = parseIntent(await readFile(path.join(DRAFT_FIXTURE, 'schematic.intent.json'), 'utf8'));
      if (!intent) throw new Error('fixture intent did not parse');
      const withEx = { ...intent, ercExclusions } as typeof intent;
      return await validateIntent(withEx, new SymbolSource(repo, [SYMLIB]), path.join(repo, 'docs'));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }

  it('accepts a well-formed entry on connected pins', async () => {
    const res = await validateWith([{ type: 'pin_to_pin', pins: ['U1.3', 'R1.2'], reason: 'divider tap (SPEC item 4)' }]);
    expect(res.findings).toEqual([]);
    expect(res.ok).toBe(true);
  }, 30000);

  it('refuses each malformed or mistargeted entry as its own finding', async () => {
    const res = await validateWith([
      { type: 'Pin To Pin', pins: ['U1.3'], reason: 'x' },
      { type: 'pin_to_pin', pins: ['U1.3'], reason: '  ' },
      { type: 'pin_to_pin', pins: 'U1.3', reason: 'x' },
      { type: 'pin_to_pin', pins: ['X9.1', 'U1.99', 'U1.4', 'U1'], reason: 'x' },
      'pin_to_pin U1.3',
    ]);
    expect(res.ok).toBe(false);
    const details = res.findings.map((f) => f.detail);
    expect(details).toEqual(
      expect.arrayContaining([
        expect.stringContaining('ercExclusions[0]: "type" must be a KiCad ERC check name'),
        expect.stringContaining('ercExclusions[1]: "reason" must say why'),
        expect.stringContaining('ercExclusions[2]: "pins" must be a non-empty array'),
        expect.stringContaining('ercExclusions[3]: pin "X9.1" references unknown part X9'),
        expect.stringContaining('ercExclusions[3]: U1 has no pin 99'),
        expect.stringContaining('ercExclusions[3]: pin U1.4 is in no net'),
        expect.stringContaining('ercExclusions[3]: pin "U1" is not of the form REF.PIN'),
        expect.stringContaining('ercExclusions[4] must be an object'),
      ]),
    );
  }, 30000);

  it('refuses a non-array', async () => {
    const res = await validateWith({ type: 'pin_to_pin' });
    expect(res.findings.map((f) => f.detail)).toEqual([expect.stringContaining('"ercExclusions" must be an array')]);
  }, 30000);
});
