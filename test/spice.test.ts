import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SimulationParseError,
  assembleSpiceDeck,
  compileSpiceAssertion,
  evaluateSpiceBlock,
  parseNgspiceMeasures,
  parseSimulationBlocks,
  parseSpiceAssertion,
  parseSpiceNumber,
  spiceAnalysisCard,
  spiceSourceCard,
  stripSpiceEnd,
  type SpiceMeasurable,
} from '../src/kicad/spice.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'spice');

describe('parseSimulationBlocks', () => {
  it('parses sheet scope, analysis, sources, and assertions with source lines', () => {
    const markdown = `# Power subsystem

## Simulation
scope: sheet /Power/Reference
analysis: op
source: VIN=3.3V
sources: ENABLE=1
assert: V(VREF) between 3.25 and 3.35
assert: I(R5) < 25uA

## Notes
Keep the reference close to the ADC.
`;

    expect(parseSimulationBlocks(markdown)).toEqual([
      {
        line: 3,
        scope: { kind: 'sheet', sheet: '/Power/Reference' },
        analysis: 'op',
        sources: [
          {
            port: 'VIN',
            value: { raw: '3.3V', value: 3.3, unit: 'V' },
            line: 6,
          },
          {
            port: 'ENABLE',
            value: { raw: '1', value: 1, unit: '' },
            line: 7,
          },
        ],
        assertions: [
          {
            raw: 'V(VREF) between 3.25 and 3.35',
            line: 8,
            measurable: { kind: 'voltage', target: 'VREF' },
            comparator: {
              kind: 'between',
              lower: { raw: '3.25', value: 3.25, unit: '' },
              upper: { raw: '3.35', value: 3.35, unit: '' },
            },
          },
          {
            raw: 'I(R5) < 25uA',
            line: 9,
            measurable: { kind: 'current', target: 'R5' },
            comparator: {
              kind: 'less-than',
              bound: { raw: '25uA', value: 25 * 1e-6, unit: 'A' },
            },
          },
        ],
      },
    ]);
  });

  it('parses explicit net scopes and removes duplicate nets', () => {
    const markdown = `## Simulation
scope: nets [VIN, VOUT, GND, VOUT]
analysis: tran
assert: V(VOUT) > 1.2V
`;

    expect(parseSimulationBlocks(markdown)[0]).toMatchObject({
      scope: { kind: 'nets', nets: ['VIN', 'VOUT', 'GND'] },
      analysis: 'tran',
    });
  });

  it('returns an empty list when the document has no Simulation block', () => {
    expect(parseSimulationBlocks('# Subsystems\n\nNo simulations configured.\n')).toEqual([]);
  });

  it('ignores fenced examples and narrative around a live Simulation block', () => {
    const markdown = `# Format example

\`\`\`markdown
## Simulation
scope: nets EXAMPLE, GND
analysis: op
assert: V(EXAMPLE) > 1V
\`\`\`

## Power reference

## Simulation
scope: nets VREF, GND
analysis: op
assert: V(VREF) between 3.25 and 3.35
This subsystem powers the ADC.
\`\`\`text
## Simulation
scope: nets IGNORED, GND
analysis: op
assert: V(IGNORED) > 1V
\`\`\`
### Details
- The reference is local to the ADC sheet.
`;

    const blocks = parseSimulationBlocks(markdown);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      line: 12,
      scope: { kind: 'nets', nets: ['VREF', 'GND'] },
      analysis: 'op',
      assertions: [{ raw: 'V(VREF) between 3.25 and 3.35' }],
    });
  });

  it('ignores single-line and multi-line HTML comments', () => {
    const markdown = `## Simulation
<!-- source: COMMENTED=1 -->
scope: sheet /Power
<!--
analysis: dc
source: ALSO_COMMENTED=2
--> source: TRAILING_TEXT_IS_DROPPED=3
analysis: op
source: VIN=3.3V
assert: V(VREF) > 3V
`;

    const [block] = parseSimulationBlocks(markdown);
    expect(block).toMatchObject({
      scope: { kind: 'sheet', sheet: '/Power' },
      analysis: 'op',
      sources: [{ port: 'VIN', line: 9 }],
      assertions: [{ line: 10 }],
    });
  });

  it('ignores Simulation blocks inside document-level HTML comments', () => {
    const markdown = `<!--
## Simulation
scope: nets COMMENTED, GND
analysis: op
assert: V(COMMENTED) > 1V
-->

## Simulation
scope: nets LIVE, GND
analysis: op
assert: V(LIVE) > 1V
`;

    const blocks = parseSimulationBlocks(markdown);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      line: 8,
      scope: { kind: 'nets', nets: ['LIVE', 'GND'] },
    });
  });

  it('rejects raw ngspice control statements and names the source line', () => {
    const markdown = `# Power

## Simulation
scope: sheet /Power
analysis: op
.control
assert: V(VREF) > 3V
`;

    expect(() => parseSimulationBlocks(markdown)).toThrowError(
      new SimulationParseError(6, 'raw ngspice statement ".control" is not allowed'),
    );
  });

  it('reports the heading line when a required field is missing', () => {
    const markdown = `# Power

## Simulation
scope: nets VIN, GND
analysis: dc
`;

    expect(() => parseSimulationBlocks(markdown)).toThrowError(
      new SimulationParseError(3, 'Simulation block needs at least one assertion'),
    );
  });

  it.each([
    {
      name: 'unsupported analysis',
      markdown: `## Simulation
scope: nets OUT, GND
analysis: noise
assert: V(OUT) > 1V
`,
      line: 3,
      message: 'unsupported analysis "noise"',
    },
    {
      name: 'unknown field',
      markdown: `## Simulation
scope: nets OUT, GND
mode: op
analysis: op
assert: V(OUT) > 1V
`,
      line: 3,
      message: 'unknown Simulation field "mode"',
    },
    {
      name: 'unsupported scope kind',
      markdown: `## Simulation
scope: board /Power
analysis: op
assert: V(OUT) > 1V
`,
      line: 2,
      message: 'scope must be "sheet <path>" or "nets <a>, <b>"',
    },
    {
      name: 'empty sheet scope',
      markdown: `## Simulation
scope: sheet
analysis: op
assert: V(OUT) > 1V
`,
      line: 2,
      message: 'sheet scope is empty',
    },
    {
      name: 'invalid net name',
      markdown: `## Simulation
scope: nets OUT, BAD NET
analysis: op
assert: V(OUT) > 1V
`,
      line: 2,
      message: 'net scope must contain comma-separated net names',
    },
    {
      name: 'malformed source',
      markdown: `## Simulation
scope: nets OUT, GND
analysis: op
source: VIN 3.3V
assert: V(OUT) > 1V
`,
      line: 4,
      message: 'source must be "<port>=<number>"',
    },
    {
      name: 'empty field value',
      markdown: `## Simulation
scope: nets OUT, GND
analysis: op
source:
assert: V(OUT) > 1V
`,
      line: 4,
      message: 'expected "field: value", got "source:"',
    },
  ])('rejects $name and names its line', ({ markdown, line, message }) => {
    expect(() => parseSimulationBlocks(markdown)).toThrowError(
      new SimulationParseError(line, message),
    );
  });
});

describe('parseSpiceNumber', () => {
  it.each([
    ['3.3', 3.3, ''],
    ['25uA', 25e-6, 'A'],
    ['10k', 10_000, ''],
    ['2MEGOhm', 2e6, 'Ohm'],
    ['-4.7mV', -4.7e-3, 'V'],
    ['1e-9A', 1e-9, 'A'],
  ])('parses %s with its SI multiplier', (raw, value, unit) => {
    const parsed = parseSpiceNumber(raw);
    expect(parsed).toMatchObject({ raw, unit });
    expect(parsed.value).toBeCloseTo(value, 12);
  });

  it('rejects unsupported numeric syntax', () => {
    expect(() => parseSpiceNumber('NaN', 14)).toThrowError(
      new SimulationParseError(14, 'invalid SPICE number "NaN"'),
    );
  });

  it('rejects finite-range overflow', () => {
    expect(() => parseSpiceNumber('1e999V', 15)).toThrowError(
      new SimulationParseError(15, 'SPICE number is out of range "1e999V"'),
    );
  });
});

describe('parseSpiceAssertion', () => {
  it('rejects arbitrary expressions outside the closed grammar', () => {
    expect(() => parseSpiceAssertion('max(V(OUT)) < 5', 22)).toThrowError(
      new SimulationParseError(22, 'invalid SPICE assertion "max(V(OUT)) < 5"'),
    );
  });

  it('rejects reversed between bounds', () => {
    expect(() => parseSpiceAssertion('V(OUT) between 5 and 3', 9)).toThrowError(
      new SimulationParseError(9, 'between lower bound must be less than upper bound'),
    );
  });

  it.each([
    {
      raw: "V(OUT') < 5V",
      line: 23,
      message: `invalid measurable target "OUT'"`,
    },
    {
      raw: 'V(OUT) between 3.25 and 3.35V',
      line: 24,
      message: 'between bounds use different units',
    },
    {
      raw: 'V(OUT) <= 5V',
      line: 25,
      message: 'invalid comparator "<= 5V"',
    },
  ])('rejects $raw and names its line', ({ raw, line, message }) => {
    expect(() => parseSpiceAssertion(raw, line)).toThrowError(
      new SimulationParseError(line, message),
    );
  });
});

describe('compileSpiceAssertion', () => {
  it('compiles a V(VREF) between assertion with both bounds evaluated', () => {
    const assertion = parseSpiceAssertion('V(VREF) between 3.25 and 3.35', 12);

    expect(compileSpiceAssertion(assertion, 'op', 'vref')).toEqual({
      valueName: 'vref_value',
      checks: [
        { name: 'vref_lower_margin', pass: 'nonnegative' },
        { name: 'vref_upper_margin', pass: 'nonnegative' },
      ],
      lines: [
        '.meas op vref_value FIND v(VREF)',
        ".meas op vref_lower_margin PARAM='vref_value - 3.25'",
        ".meas op vref_upper_margin PARAM='3.35 - vref_value'",
      ],
      deck: `.meas op vref_value FIND v(VREF)
.meas op vref_lower_margin PARAM='vref_value - 3.25'
.meas op vref_upper_margin PARAM='3.35 - vref_value'`,
    });
  });

  const measurables: Array<[string, SpiceMeasurable, string]> = [
    ['V(net)', { kind: 'voltage', target: 'OUT' }, 'v(OUT)'],
    ['I(refdes)', { kind: 'current', target: 'R5' }, 'i(R5)'],
    ['corner(net)', { kind: 'corner', target: 'OUT' }, 'vdb(OUT)'],
  ];
  const comparators = [
    'between 1kHz and 2kHz',
    '< 2kHz',
    '> 1kHz',
  ] as const;

  it.each(
    measurables.flatMap(([measurableLabel, measurable, expression]) =>
      comparators.map(
        (comparator) =>
          [`${measurableLabel} ${comparator}`, measurable, expression, comparator] as const,
      ),
    ),
  )('compiles %s', (_label, measurable, expression, comparator) => {
    const measurableText =
      measurable.kind === 'voltage'
        ? 'V(OUT)'
        : measurable.kind === 'current'
          ? 'I(R5)'
          : 'corner(OUT)';
    const assertion = parseSpiceAssertion(`${measurableText} ${comparator}`);
    const result = compileSpiceAssertion(assertion, 'ac', 'check');

    expect(result.lines[0]).toContain(expression);
    expect(result.lines).toHaveLength(comparator.startsWith('between') ? 3 : 2);
    expect(result.lines.slice(1).every((line) => line.includes("PARAM='"))).toBe(true);
    const expectedPass = comparator.startsWith('between') ? 'nonnegative' : 'positive';
    expect(result.checks.every((check) => check.pass === expectedPass)).toBe(true);
  });

  it('only permits corner measurements in an AC analysis', () => {
    const assertion = parseSpiceAssertion('corner(OUT) < 10k');
    expect(() => compileSpiceAssertion(assertion, 'tran')).toThrowError(
      new SimulationParseError(1, 'corner() requires an ac analysis'),
    );
  });

  it('rejects unsafe measure names', () => {
    const assertion = parseSpiceAssertion('V(OUT) > 1V', 27);
    expect(() => compileSpiceAssertion(assertion, 'op', 'bad-name')).toThrowError(
      new SimulationParseError(27, 'invalid measure name "bad-name"'),
    );
  });
});

describe('assembleSpiceDeck', () => {
  it('strips a trailing .end, drives ports, and appends analysis plus .meas cards', () => {
    const [block] = parseSimulationBlocks(`## Simulation
scope: nets VIN, VOUT
analysis: op
source: VIN=3.3
assert: V(VOUT) between 1.6 and 1.7
`);
    const { text, compiled } = assembleSpiceDeck('* netlist\nR1 VIN VOUT 10k\n.end\n', block!);
    expect(text).toContain('* copperhead spice verification gate');
    expect(text).toContain('Vsrc_VIN VIN 0 DC 3.3');
    expect(text).toContain('.op');
    expect(text).toMatch(/\.meas op a\d+_0_value FIND v\(VOUT\)/);
    expect(text.trimEnd().endsWith('.end')).toBe(true);
    expect(stripSpiceEnd(text).includes('.end')).toBe(false);
    expect(compiled).toHaveLength(1);
    expect(compiled[0]!.valueName).toMatch(/^a\d+_0_value$/);
  });

  it('emits a DC sweep, AC decade, and transient card for those analyses', () => {
    expect(spiceAnalysisCard('dc', [{ port: 'VIN', value: { raw: '3.3', value: 3.3, unit: '' }, line: 1 }])).toBe(
      '.dc Vsrc_VIN 0 6.6 0.66',
    );
    expect(spiceAnalysisCard('ac', [])).toBe('.ac dec 10 1 1meg');
    expect(spiceAnalysisCard('tran', [])).toBe('.tran 1u 1m');
    expect(spiceSourceCard({ port: 'VCC.A', value: { raw: '5', value: 5, unit: '' }, line: 1 })).toBe(
      'Vsrc_VCC_A VCC.A 0 DC 5',
    );
  });
});

describe('parseNgspiceMeasures + evaluateSpiceBlock', () => {
  it('passes a V(VOUT) between assertion at the measured value', async () => {
    const markdown = await readFile(path.join(FIXTURES, 'SUBSYSTEMS.md'), 'utf8');
    const [block] = parseSimulationBlocks(markdown);
    const measures = parseNgspiceMeasures(await readFile(path.join(FIXTURES, 'ngspice-pass.txt'), 'utf8'));
    const [result] = evaluateSpiceBlock(block!, measures);
    expect(result).toMatchObject({
      assertion: 'V(VOUT) between 1.6 and 1.7',
      status: 'pass',
      measured: 1.65,
      bound: '1.6 .. 1.7',
    });
  });

  it('fails with the measured value when a bound is missed', async () => {
    const markdown = await readFile(path.join(FIXTURES, 'SUBSYSTEMS-fail.md'), 'utf8');
    const [block] = parseSimulationBlocks(markdown);
    const measures = parseNgspiceMeasures(await readFile(path.join(FIXTURES, 'ngspice-fail.txt'), 'utf8'));
    const [result] = evaluateSpiceBlock(block!, measures);
    expect(result).toMatchObject({
      status: 'fail',
      measured: 1.65,
      bound: '3.0 .. 3.1',
    });
    expect(result!.detail).toContain('measured 1.65');
  });

  it('reports a missing value measure as a failure, not a pass', () => {
    const [block] = parseSimulationBlocks(`## Simulation
scope: nets OUT
analysis: op
assert: V(OUT) > 1
`);
    const [result] = evaluateSpiceBlock(block!, {});
    expect(result!.status).toBe('fail');
    expect(result!.detail).toMatch(/no measured a\d+_0_value/);
  });
});
