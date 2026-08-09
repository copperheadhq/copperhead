import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdtemp, cp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { SymbolSource, SymbolResolutionError, extractSymbolBlock, powerSymbolSource, powerNetToken } from '../src/kicad/draft/symsource.js';
import { draftSchematicToText, draftSchematic } from '../src/kicad/draft/draft.js';
import { kicadLoadError, runErc } from '../src/kicad/cli.js';
import { findMergedNets, findLabelOverlaps } from '../src/kicad/draft/engine.js';
import { looksLikeDescription } from '../src/kicad/draft/ir.js';
import { parseSexp } from '../src/kicad/sexp.js';
import { checkLegibility } from '../src/kicad/legibility.js';
import { toolSearch } from '../src/agent/filetools.js';

/**
 * Hardening found by driving `create` end-to-end against a real brief. Each
 * case below cost a stage attempt in a live run; the comments name what it cost
 * so a later reader can tell a real constraint from a defensive guess.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');
const DRAFT_FIXTURE = path.join(HERE, 'fixtures', 'draft');

describe('derived (extends) symbols', () => {
  /**
   * Stage 4 refused outright when a real part resolved to a derived symbol:
   * "TPD4E05U06DQAR is a derived (extends) symbol, which the drafting engine
   * does not support yet". Five parts on one board hit it, and the agent's only
   * recourse was to capture them as generic connector placeholders — symbols
   * with no pin types, which silently weakens ERC.
   */
  it('resolves a derived symbol by inheriting the base geometry', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-derived-'));
    try {
      const src = new SymbolSource(repo, [SYMLIB]);
      const base = await src.resolve('Device:R');
      const derived = await src.resolve('Device:R_Small_Derived');

      expect(derived.libId).toBe('Device:R_Small_Derived');
      // Geometry is the base's: same pins, same body, so placement and wiring
      // treat it exactly like the part it extends.
      expect(derived.pins.map((p) => p.number)).toEqual(base.pins.map((p) => p.number));
      expect(derived.body).toEqual(base.body);
      // sourceText is the base block verbatim; the emitter renames it to the
      // derived lib_id on the way into lib_symbols.
      expect(derived.sourceText).toBe(base.sourceText);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('a drafted sheet with a derived symbol loads in KiCad and matches its vendored copy', async () => {
    // Two failure modes found by the first reference board with real derived
    // symbols: the emitted lib_symbols wrapped the BASE's unit children under
    // the derived name (KiCad refuses to load the file), and the vendored
    // cache held the library's `extends` stub, so ERC reported
    // lib_symbol_mismatch comparing the flattened embedded copy against it.
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-derived-e2e-'));
    try {
      await writeFile(
        path.join(repo, 'schematic.intent.json'),
        JSON.stringify({
          version: 1,
          parts: [
            { ref: 'R1', libId: 'Device:R_Small_Derived', value: '1k', group: 'A' },
            { ref: 'R2', libId: 'Device:R', value: '1k', group: 'A' },
          ],
          nets: [
            { name: 'N1', pins: ['R1.1', 'R2.1'] },
            { name: 'N2', pins: ['R1.2', 'R2.2'] },
          ],
        }),
        'utf8',
      );
      const res = await draftSchematic({ repoRoot: repo, schematic: 'b.kicad_sch', symbolDirs: [SYMLIB] });
      expect(res.ok, res.ok ? '' : res.message).toBe(true);
      if (!res.ok) return;
      // children renamed with the parent in the emitted sheet
      expect(res.text).toContain('(symbol "Device:R_Small_Derived"');
      expect(res.text).toContain('(symbol "R_Small_Derived_0_1"');
      // the vendored copy is the flattened symbol, not the extends stub
      const cache = await readFile(path.join(repo, 'sym-lib-cache', 'Device.kicad_sym'), 'utf8');
      const vendored = extractSymbolBlock(cache, 'R_Small_Derived');
      expect(vendored).not.toBeNull();
      expect(vendored).not.toContain('(extends');
      // and KiCad actually loads the file with no symbol-mismatch complaint
      expect(await kicadLoadError(res.schematicPath)).toBeNull();
      const erc = await runErc(res.schematicPath);
      expect(erc.violations.filter((v) => v.type === 'lib_symbol_mismatch')).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 60000);

  it('refuses a multi-unit symbol before it can merge nets', async () => {
    // Units of a multi-unit symbol share symbol-space pin coordinates, so a
    // single placed instance overlays unrelated pins on one point: a probe
    // LM358 drafted with both amps fused OUT1 into OUT2 and reported ok.
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-multiunit-'));
    try {
      await writeFile(
        path.join(repo, 'schematic.intent.json'),
        JSON.stringify({
          version: 1,
          parts: [
            { ref: 'U1', libId: 'CopperStack:DualBuf', value: 'DualBuf', group: 'A' },
            { ref: 'R1', libId: 'Device:R', value: '1k', group: 'A' },
          ],
          nets: [
            { name: 'N1', pins: ['U1.1', 'R1.1'] },
            { name: 'N2', pins: ['U1.2', 'R1.2'] },
          ],
        }),
        'utf8',
      );
      const res = await draftSchematicToText({ repoRoot: repo, schematic: 'b.kicad_sch', symbolDirs: [SYMLIB] });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.message).toContain('multi-unit symbol');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('refuses a power-port part instead of silently dropping it (#212)', async () => {
    // A power part passed every structural check and was then filtered out of
    // every placement path: never placed, never given an endpoint, absent from
    // its own group's member list, and missing from `notes`. The draft still
    // returned ok, so a model that writes `power:GND` had no signal at all and
    // kept doing it.
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-irpower-'));
    const libs = await mkdtemp(path.join(tmpdir(), 'copperhead-irpower-libs-'));
    try {
      // Real docs, and docsDir passed below, so the group and BOM cross-checks
      // actually run. Without them this test passes even if the refusal stops
      // recording the symbol first, because neither check would fire: the
      // "exactly one finding" assertion is only meaningful when the paths that
      // would produce the extra findings are live. PG1 is deliberately absent
      // from BOM.md, which is what the isPower skip has to swallow.
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs', 'SUBSYSTEMS.md'), '# Subsystems\n\n## A\n\nThe only block.\n', 'utf8');
      await writeFile(
        path.join(repo, 'docs', 'BOM.md'),
        [
          '# BOM',
          '',
          '| Refdes | Value | Footprint | MPN | Rationale |',
          '| --- | --- | --- | --- | --- |',
          '| R1 | 1k | R_0603 | RC0603 | divider top |',
          '| R2 | 1k | R_0603 | RC0603 | divider bottom |',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        path.join(libs, 'power.kicad_sym'),
        `(kicad_symbol_lib (version 20251024) (generator test)
  (symbol "GND" (power) (pin_names (offset 0))
    (symbol "GND_1_1"
      (pin power_in line (at 0 0 270) (length 0) hide (name "GND") (number "1"))
    )
  )
)`,
        'utf8',
      );
      await writeFile(
        path.join(repo, 'schematic.intent.json'),
        JSON.stringify({
          version: 1,
          parts: [
            { ref: 'R1', libId: 'Device:R', value: '1k', footprint: 'R_0603', group: 'A' },
            { ref: 'R2', libId: 'Device:R', value: '1k', footprint: 'R_0603', group: 'A' },
            { ref: 'PG1', libId: 'power:GND', value: 'GND', group: 'A' },
          ],
          nets: [
            { name: 'SIG', pins: ['R1.1', 'R2.1'] },
            { name: 'GND', pins: ['R1.2', 'R2.2', 'PG1.1'] },
          ],
        }),
        'utf8',
      );
      const res = await draftSchematicToText({
        repoRoot: repo,
        schematic: 'b.kicad_sch',
        docsDir: 'docs',
        symbolDirs: [SYMLIB, libs],
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.message).toContain('power-port symbol');
      // One finding, not three: the part is recorded before the refusal so the
      // group and BOM cross-checks take their isPower skips and the model is
      // not handed unrelated-looking noise about the same mistake.
      expect(res.findings).toHaveLength(1);
      expect(res.findings[0]!.detail).toContain('PG1');
      // The finding has to name the alternative, or it is a dead end.
      expect(res.message).toMatch(/nets/);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(libs, { recursive: true, force: true });
    }
  });

  it('still refuses a symbol whose extends target is unnamed', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-derived-bad-'));
    try {
      const lib = path.join(repo, 'libs');
      await mkdir(lib, { recursive: true });
      await writeFile(
        path.join(lib, 'Broken.kicad_sym'),
        '(kicad_symbol_lib\n\t(version 20231120)\n\t(generator "t")\n\t(symbol "Orphan"\n\t\t(extends)\n\t)\n)\n',
        'utf8',
      );
      await expect(new SymbolSource(repo, [lib]).resolve('Broken:Orphan')).rejects.toBeInstanceOf(SymbolResolutionError);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('toolSearch: a match is a pointer, not a payload', () => {
  /**
   * A stage attempt died with `Prompt is too long · the request is ~1003121
   * tokens (limit 1000000) but this conversation is only ~403383 tokens`. The
   * balance was search results: the repo held a `run-logs/` directory of
   * transcripts, and one `transcript.jsonl` line is an entire record with tool
   * output inline. The file-size bound (5 MB) does not bound a line.
   */
  it('clips a pathological single line instead of returning it whole', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-search-'));
    try {
      const huge = `{"ts":1,"type":"tool","data":"${'x'.repeat(200_000)} NEEDLE"}`;
      await writeFile(path.join(repo, 'transcript.jsonl'), `${huge}\n`, 'utf8');
      const matches = await toolSearch(repo, 'NEEDLE');
      expect(matches).toHaveLength(1);
      expect(matches[0]!.text.length).toBeLessThan(500);
      expect(matches[0]!.text).toContain('[+');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('leaves an ordinary line untouched', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-search-ok-'));
    try {
      await writeFile(path.join(repo, 'a.md'), 'the NEEDLE is here\n', 'utf8');
      const matches = await toolSearch(repo, 'NEEDLE');
      expect(matches[0]!.text).toBe('the NEEDLE is here');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('merged nets are refused, not warned about', () => {
  /**
   * Attempt 1 of a live stage 4 drew ISET (charge-current program) and NTC
   * (thermistor input) onto one node of a BQ24040: `Both ISET and NTC are
   * attached to the same items; ISET will be used in the netlist`. ERC calls
   * that a warning. The board it describes charges at the wrong current with no
   * temperature cutoff, and nothing in the pipeline stopped it.
   */
  it('draftSchematicToText refuses when two nets share a label point', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-merged-'));
    try {
      await cp(path.join(DRAFT_FIXTURE, 'docs'), path.join(repo, 'docs'), { recursive: true });
      const intent = JSON.parse(await readFile(path.join(DRAFT_FIXTURE, 'schematic.intent.json'), 'utf8'));
      await writeFile(path.join(repo, 'schematic.intent.json'), JSON.stringify(intent), 'utf8');

      const clean = await draftSchematicToText({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        intentPath: 'schematic.intent.json',
        docsDir: path.join(repo, 'docs'),
        symbolDirs: [SYMLIB],
      });
      // The fixture is a good board: it must not trip the new gate.
      expect(clean.ok).toBe(true);
      expect(clean.report!.mergedNets).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('detects the exact BQ24040 case: two nets, one point', () => {
    const merged = findMergedNets([
      { name: 'ISET', x: 100, y: 50 },
      { name: 'NTC', x: 100, y: 50 },
      { name: 'VBUS', x: 20, y: 10 },
    ]);
    expect(merged).toEqual([{ x: 100, y: 50, nets: ['ISET', 'NTC'] }]);
  });

  it('does not flag the same net labelled twice at one point', () => {
    // Legitimate: a net can carry a label at both ends of a stub.
    expect(findMergedNets([
      { name: 'VBUS', x: 10, y: 10 },
      { name: 'VBUS', x: 10, y: 10 },
    ])).toEqual([]);
  });

  it('reports each colliding point once, with nets sorted', () => {
    const merged = findMergedNets([
      { name: 'LEDG_K', x: 5, y: 5 },
      { name: 'LEDB_K', x: 5, y: 5 },
      { name: 'BAT_NEG', x: 9, y: 9 },
      { name: 'G_CHG', x: 9, y: 9 },
    ]);
    expect(merged).toEqual([
      { x: 9, y: 9, nets: ['BAT_NEG', 'G_CHG'] },
      { x: 5, y: 5, nets: ['LEDB_K', 'LEDG_K'] },
    ]);
  });
});

describe('overlapping label text is a budget, not a gate', () => {
  /**
   * Stage 4 of a live run refused thirteen times in a row on one collision:
   * RX_ADC (a stick axis) and SWDCLK_CTRL assigned the same label point. The
   * de-collision pass tested a candidate position against symbol bodies and
   * wires but never against other LABELS, so it declared a point clear that
   * another net already held; neither label moved, and findMergedNets then
   * refused the draft. The agent could not reach the fault — it does not choose
   * coordinates — so it burned ~120k output tokens on net renames, endpoint
   * moves, three paper sizes and five group orderings before giving up. The
   * avoider's notion of "clear" now matches the detector's.
   */
  it('flags foreign-net label text that overlaps', () => {
    // Two labels on the same row, close enough that "SWDCLK_CTRL" runs into
    // where "RX_ADC" starts.
    const overlaps = findLabelOverlaps([
      { name: 'SWDCLK_CTRL', x: 100, y: 50, rot: 0 },
      { name: 'RX_ADC', x: 103, y: 50, rot: 0 },
      { name: 'VBAT', x: 10, y: 10, rot: 0 },
    ]);
    expect(overlaps.map((o) => o.nets)).toEqual([['RX_ADC', 'SWDCLK_CTRL'], ['RX_ADC', 'SWDCLK_CTRL']]);
    expect(overlaps.map((o) => o.x).sort((a, b) => a - b)).toEqual([100, 103]);
  });

  it('does not flag one net labelled twice, or labels that clear each other', () => {
    expect(findLabelOverlaps([
      { name: 'VBAT', x: 100, y: 50, rot: 0 },
      { name: 'VBAT', x: 101, y: 50, rot: 0 },
    ])).toEqual([]);
    expect(findLabelOverlaps([
      { name: 'SWDCLK_CTRL', x: 100, y: 50, rot: 0 },
      { name: 'RX_ADC', x: 100, y: 80, rot: 0 },
    ])).toEqual([]);
  });

  it('leaves an exact coincidence to findMergedNets, so one fault is not counted twice', () => {
    const labels = [
      { name: 'RX_ADC', x: 100, y: 50, rot: 0 },
      { name: 'SWDCLK_CTRL', x: 100, y: 50, rot: 0 },
    ];
    expect(findMergedNets(labels)).toHaveLength(1);
    expect(findLabelOverlaps(labels)).toEqual([]);
  });

  it('a good board reports no overlaps and stays inside the budget', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-overlap-'));
    try {
      await cp(path.join(DRAFT_FIXTURE, 'docs'), path.join(repo, 'docs'), { recursive: true });
      const intent = JSON.parse(await readFile(path.join(DRAFT_FIXTURE, 'schematic.intent.json'), 'utf8'));
      await writeFile(path.join(repo, 'schematic.intent.json'), JSON.stringify(intent), 'utf8');

      const res = await draftSchematicToText({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        intentPath: 'schematic.intent.json',
        docsDir: path.join(repo, 'docs'),
        symbolDirs: [SYMLIB],
      });
      expect(res.ok).toBe(true);
      expect(res.report!.mergedNets).toEqual([]);
      expect(res.report!.labelOverlaps).toEqual([]);
      expect(res.report!.labelOverlapBudgetExceeded).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

/** Draft a one-off intent in a temp repo; returns the draftSchematicToText result. */
async function draftIntent(
  intent: unknown,
  opts: { docs?: Record<string, string> } = {},
): Promise<{ res: Awaited<ReturnType<typeof draftSchematicToText>>; repo: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-hardening-'));
  await writeFile(path.join(repo, 'schematic.intent.json'), JSON.stringify(intent), 'utf8');
  let docsDir: string | undefined;
  if (opts.docs) {
    docsDir = path.join(repo, 'docs');
    await mkdir(docsDir, { recursive: true });
    for (const [name, text] of Object.entries(opts.docs)) await writeFile(path.join(docsDir, name), text, 'utf8');
  }
  const res = await draftSchematicToText({
    repoRoot: repo,
    schematic: 'board.kicad_sch',
    intentPath: 'schematic.intent.json',
    ...(docsDir ? { docsDir } : {}),
    symbolDirs: [SYMLIB],
  });
  return { res, repo, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

describe('facing long-named labels draft clean by construction', () => {
  /**
   * The reviewed head could emit a sheet that failed its own error-severity
   * legibility gate while reporting ok: two ~33-character net names on facing
   * pins of adjacent groups overran the fixed channel, and the de-collision
   * nudge only moves a label further INTO the facing group. The group and
   * column gaps now widen by the facing label extents, so this exact repro must
   * come out with zero overlaps and zero error-severity findings.
   */
  it('the two-MCU long-net repro drafts with no overlaps and a clean checker gate', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-facing-'));
    try {
      const docs = path.join(repo, 'docs');
      await mkdir(docs, { recursive: true });
      await writeFile(path.join(docs, 'SUBSYSTEMS.md'), '## Alpha\n\n## Beta\n', 'utf8');
      await writeFile(
        path.join(repo, 'schematic.intent.json'),
        JSON.stringify({
          version: 1,
          parts: [
            { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'Alpha' },
            { ref: 'U2', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'Beta' },
          ],
          nets: [
            { name: 'SPI_CONTROLLER_CHIP_SELECT_LINE_3', pins: ['U1.4', 'U2.3'], kind: 'signal' },
            { name: 'SPI_CONTROLLER_CHIP_SELECT_LINE_B', pins: ['U1.5', 'U2.8'], kind: 'signal' },
          ],
        }),
        'utf8',
      );
      const res = await draftSchematic({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        intentPath: 'schematic.intent.json',
        docsDir: docs,
        symbolDirs: [SYMLIB],
      });
      expect(res.ok, res.ok ? '' : res.message).toBe(true);
      if (!res.ok) return;
      expect(res.report.labelOverlaps).toEqual([]);
      expect(res.report.labelOverlapBudgetExceeded).toBe(false);
      const leg = await checkLegibility(res.schematicPath, { docsDir: docs });
      expect(
        leg.findings.filter((f) => f.severity === 'error'),
        JSON.stringify(leg.findings, null, 2),
      ).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 60000);
});

describe('point identity is the emitted coordinate, not the float', () => {
  /**
   * `findMergedNets` used to key label positions on raw float equality while
   * emission rounds through `knum`: two labels at 13.969999999999999 and 13.97
   * emit to the same point — which is what KiCad's connectivity joins on — but
   * evaded the refusal. The exact ISET/NTC class of fault, shipped silently.
   */
  it('detects a merge between labels that differ only by float dust', () => {
    const merged = findMergedNets([
      { name: 'ISET', x: 13.969999999999999, y: 50 },
      { name: 'NTC', x: 13.97, y: 50 },
    ]);
    expect(merged.map((m) => m.nets)).toEqual([['ISET', 'NTC']]);
  });

  it('treats a dust-only coincidence as a merge, not a text overlap', () => {
    expect(
      findLabelOverlaps([
        { name: 'ISET', x: 13.969999999999999, y: 50, rot: 0 },
        { name: 'NTC', x: 13.97, y: 50, rot: 0 },
      ]),
    ).toEqual([]);
  });
});

describe('power net names cannot corrupt the generated symbol source', () => {
  it('powerSymbolSource escapes quotes and backslashes into a single parseable block', () => {
    for (const name of ['V"CC', 'V\\CC']) {
      const src = powerSymbolSource(name, 'rail');
      const roots = parseSexp(src.sourceText);
      expect(roots).toHaveLength(1);
      expect(src.libId).toBe(`copperhead_power:${powerNetToken(name)}`);
    }
  });

  it('validateIntent refuses a net name with a quote before anything is drafted', async () => {
    const { res, cleanup } = await draftIntent({
      version: 1,
      parts: [
        { ref: 'R1', libId: 'Device:R', value: '10k', group: 'A' },
        { ref: 'R2', libId: 'Device:R', value: '10k', group: 'A' },
      ],
      nets: [{ name: 'V"CC', pins: ['R1.1', 'R2.1'], kind: 'power' }],
    });
    try {
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.message).toContain('cannot be drawn');
    } finally {
      await cleanup();
    }
  });

  it('refuses two power nets whose names sanitize to one symbol token', async () => {
    const { res, cleanup } = await draftIntent({
      version: 1,
      parts: [
        { ref: 'J1', libId: 'CopperConn:Conn_01x03', value: 'Conn', group: 'A' },
        { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'A' },
      ],
      nets: [
        { name: 'RAIL_A', pins: ['J1.1', 'U1.1'], kind: 'power' },
        { name: 'RAIL A', pins: ['J1.2', 'U1.2'], kind: 'power' },
      ],
    });
    try {
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.message).toContain('sanitize to the symbol token "RAIL_A"');
      expect(res.message).toContain('RAIL A and RAIL_A');
    } finally {
      await cleanup();
    }
  });
});

describe('power symbols never fight over their value text', () => {
  /**
   * Two DIFFERENT rails on adjacent same-side pins used to stack their value
   * texts into an error-severity collision no IR change could reach (hiding a
   * different net's name would lose information). The later symbol now rides
   * its own stub outward until the text clears; same-net duplicates keep the
   * existing one-visible-name-per-cluster rule.
   */
  it('a different-net collision resolves by extending a stub, both names visible', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-pwrtext-'));
    try {
      await writeFile(
        path.join(repo, 'schematic.intent.json'),
        JSON.stringify({
          version: 1,
          parts: [
            { ref: 'X1', libId: 'CopperStack:TopPins2', value: 'TopPins2', group: 'A' },
            { ref: 'R1', libId: 'Device:R', value: '1k', group: 'A' },
            { ref: 'R2', libId: 'Device:R', value: '1k', group: 'A' },
          ],
          nets: [
            { name: 'RAIL_A', pins: ['X1.1', 'R1.1'], kind: 'power' },
            { name: 'RAIL_B', pins: ['X1.2', 'R2.1'], kind: 'power' },
            { name: 'SIG', pins: ['X1.3', 'R1.2'] },
          ],
        }),
        'utf8',
      );
      const res = await draftSchematic({ repoRoot: repo, schematic: 'b.kicad_sch', symbolDirs: [SYMLIB] });
      expect(res.ok, res.ok ? '' : res.message).toBe(true);
      if (!res.ok) return;
      const text = await readFile(res.schematicPath, 'utf8');
      // both rail names stay visible: a different net's name is never hidden
      for (const rail of ['RAIL_A', 'RAIL_B']) {
        const m = new RegExp(`\\(property "Value" "${rail}"[^\\n]*\\n([^\\n]*)`).exec(text);
        expect(m, `${rail} value present`).not.toBeNull();
      }
      const hidden = [...text.matchAll(/\(property "Value" "(RAIL_[AB])"[\s\S]{0,200}?hide yes/g)].map((m) => m[1]);
      expect(hidden).toEqual([]);
      // and the checker sees no collision
      const leg = await checkLegibility(res.schematicPath, {});
      expect(leg.findings.filter((f) => f.severity === 'error')).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30000);
});

describe('type-confused IR fields come back as numbered findings, not TypeErrors', () => {
  const base = () => ({
    version: 1,
    parts: [
      { ref: 'R1', libId: 'Device:R', value: '10k', group: 'A' },
      { ref: 'R2', libId: 'Device:R', value: '10k', group: 'A' },
    ],
    nets: [{ name: 'SIG', pins: ['R1.1', 'R2.1'] }],
  });

  it('a numeric group is a finding', async () => {
    const intent = base() as ReturnType<typeof base> & { parts: { group: unknown }[] };
    intent.parts[0]!.group = 5;
    const { res, cleanup } = await draftIntent(intent);
    try {
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.message).toContain('"group" must be a string');
    } finally {
      await cleanup();
    }
  });

  it('a string groupOrder hint is a finding', async () => {
    const { res, cleanup } = await draftIntent({ ...base(), hints: { groupOrder: 'A' } });
    try {
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.message).toContain('"hints.groupOrder" must be an array');
    } finally {
      await cleanup();
    }
  });

  it('a numeric date hint is a finding', async () => {
    const { res, cleanup } = await draftIntent({ ...base(), hints: { date: 20200101 } });
    try {
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.message).toContain('"hints.date" must be a string');
    } finally {
      await cleanup();
    }
  });

  it('a string noConnect is a finding', async () => {
    const { res, cleanup } = await draftIntent({ ...base(), noConnect: 'R1.2' });
    try {
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.message).toContain('"noConnect" must be an array');
    } finally {
      await cleanup();
    }
  });

  it('a non-string endpoint and an unknown kind are findings', async () => {
    const intent = base();
    (intent.nets[0]!.pins as unknown[]).push(42);
    (intent.nets[0]! as { kind?: unknown }).kind = 'rail';
    const { res, cleanup } = await draftIntent(intent);
    try {
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.message).toContain('must be a "REF.PIN" string');
      expect(res.message).toContain('"kind" must be');
    } finally {
      await cleanup();
    }
  });
});

describe('long single-token BOM values are drawable, prose is not', () => {
  it('leaves a long unbroken part identifier alone', () => {
    expect(looksLikeDescription('JST_PH_S2B-PH-K_1x02_P2.00mm')).toBe(false); // 28 chars, no space
    expect(looksLikeDescription('STM32F103C8T6')).toBe(false);
  });

  it('still refuses long prose and clause lists', () => {
    expect(looksLikeDescription('1S Li-Po cell, 500 mAh, bare leads')).toBe(true);
    expect(looksLikeDescription('Battery holder for two 18650 cells')).toBe(true); // long, spaces, no commas
    expect(looksLikeDescription('P-MOSFET, divider gate')).toBe(true);
    expect(looksLikeDescription('4.7uF, X5R, 10V, 0603')).toBe(false);
  });
});

describe('draftSchematicToText never touches the working tree', () => {
  /**
   * The docstring promised no disk writes, but symbol resolution vendored
   * uncached symbols into sym-lib-cache/ as a side effect — so the stage-4
   * staleness probe (a read-shaped completeness check) could mutate the repo.
   */
  it('does not create sym-lib-cache during a dry run', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-dryrun-'));
    try {
      await cp(path.join(DRAFT_FIXTURE, 'schematic.intent.json'), path.join(repo, 'schematic.intent.json'));
      await cp(path.join(DRAFT_FIXTURE, 'docs'), path.join(repo, 'docs'), { recursive: true });
      const res = await draftSchematicToText({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        intentPath: 'schematic.intent.json',
        docsDir: path.join(repo, 'docs'),
        symbolDirs: [SYMLIB],
      });
      expect(res.ok).toBe(true);
      expect(existsSync(path.join(repo, 'sym-lib-cache'))).toBe(false);
      expect(existsSync(path.join(repo, 'board.kicad_sch'))).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('draft orchestration error paths', () => {
  it('a missing intent file is a finding, not a crash', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-nointent-'));
    try {
      const res = await draftSchematicToText({ repoRoot: repo, schematic: 'board.kicad_sch', symbolDirs: [SYMLIB] });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.findings[0]!.detail).toContain('does not exist');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('an unknown symbol name reports the closest candidates', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-candidates-'));
    try {
      await expect(new SymbolSource(repo, [SYMLIB]).resolve('Device:R_Sma')).rejects.toThrow(/closest:.*R_Small_Derived/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  // Regression for a review finding on #186: a fuzzy cross-library suggestion
  // was built from the caller's original (wrong) query name, not the symbol
  // that actually matched, so re-resolving the "fix" it offered failed again
  // with the identical error (SHT40 guessed in the wrong library; the real
  // symbol two directories over is spelled SHT4x, not SHT40).
  it('a fuzzy cross-library suggestion names the real symbol, and resolves', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-fuzzy-elsewhere-'));
    const libDir = await mkdtemp(path.join(tmpdir(), 'copperhead-fuzzy-libs-'));
    try {
      await writeFile(
        path.join(libDir, 'Sensor_Wrong.kicad_sym'),
        `(kicad_symbol_lib (version 20251024) (generator test)\n  (symbol "Unrelated" (pin_numbers hide) (pin_names (offset 0))))`,
        'utf8',
      );
      await writeFile(
        path.join(libDir, 'Sensor_Humidity.kicad_sym'),
        `(kicad_symbol_lib (version 20251024) (generator test)
  (symbol "SHT4x" (pin_numbers hide) (pin_names (offset 0))
    (symbol "SHT4x_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2"))
    )
  )
)`,
        'utf8',
      );
      const src = new SymbolSource(repo, [libDir]);
      // Both then() handlers: an unexpected success rejects with its own error
      // instead of being swallowed by a catch meant for the resolution failure.
      const err = await src.resolve('Sensor_Wrong:SHT40').then(
        () => {
          throw new Error('expected resolve to throw');
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SymbolResolutionError);
      const failure = err as SymbolResolutionError;
      expect(failure.reason).toBe('found-elsewhere');
      const suggested = failure.candidates[0]!;
      // The bug this guards: reconstructing from the query would produce
      // "Sensor_Humidity:SHT40", which does not exist anywhere.
      expect(suggested).toBe('Sensor_Humidity:SHT4x');
      const resolved = await src.resolve(suggested);
      expect(resolved.libId).toBe('Sensor_Humidity:SHT4x');
      expect(resolved.pins).toHaveLength(2);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(libDir, { recursive: true, force: true });
    }
  });
});
