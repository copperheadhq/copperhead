import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { checkLegibility, formatLegibility, LEGIBILITY_FAMILIES } from '../src/kicad/legibility.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import { runCheck } from '../src/commands/check.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'legibility');
const CLEAN = path.join(FIX, 'clean.kicad_sch');
const UGLY = path.join(FIX, 'ugly.kicad_sch');
const DOCS = path.join(FIX, 'docs');

/** Minimal single-purpose schematic builder for family-isolation tests. */
const LIB_R = `(lib_symbols
  (symbol "Device:R"
    (symbol "R_0_1"
      (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none)))
    )
    (symbol "R_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
    )
  )
  (symbol "power:GND" (power)
    (pin power_in line (at 0 0 0) (length 0) hide
      (name "GND" (effects (font (size 1.27 1.27))))
      (number "1" (effects (font (size 1.27 1.27))))
    )
  )
)`;

const symR = (ref: string, x: number, y: number): string => `(symbol
  (lib_id "Device:R") (at ${x} ${y} 0) (uuid "aaaa0000-0000-4000-8000-${ref.padStart(12, '0')}")
  (property "Reference" "${ref}" (at ${x} ${y - 7.62} 0) (effects (font (size 1.27 1.27))))
  (pin "1" (uuid "bbbb0000-0000-4000-8000-${ref.padStart(12, '0')}"))
)`;

function sch(body: string, paper = '(paper "A4")'): string {
  return `(kicad_sch (version 20231120) (uuid "eeee0000-0000-4000-8000-000000000001") ${paper}
  (title_block (title "t") (date "d") (rev "r"))
  ${LIB_R}
  ${body}
  (sheet_instances (path "/" (page "1")))
)`;
}

async function inTemp(content: string): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-legibility-'));
  const file = path.join(dir, 'x.kicad_sch');
  await writeFile(file, content, 'utf8');
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe('legibility checker: fixtures', () => {
  it('clean fixture reports zero findings at every severity (AC-16.27)', async () => {
    const report = await checkLegibility(CLEAN, { docsDir: DOCS });
    expect(report.findings).toEqual([]);
    expect(report.counts).toEqual({ error: 0, advisory: 0 });
    expect(report.suppressed).toEqual([]);
    expect(report.sheets).toBe(1);
  });

  it('ugly fixture trips every check family', async () => {
    const report = await checkLegibility(UGLY, { docsDir: DOCS });
    const kinds = new Set(report.findings.map((f) => f.kind));
    for (const family of LEGIBILITY_FAMILIES) {
      expect(kinds, `family ${family} should fire`).toContain(family);
    }
  });

  it('off-grid findings lead the report (AC-16.29)', async () => {
    const report = await checkLegibility(UGLY, { docsDir: DOCS });
    expect(report.findings[0]!.kind).toBe('off-grid');
    const firstNonGrid = report.findings.findIndex((f) => f.kind !== 'off-grid');
    expect(report.findings.slice(firstNonGrid).every((f) => f.kind !== 'off-grid')).toBe(true);
  });

  it('pairwise families report each unordered pair once', async () => {
    const report = await checkLegibility(UGLY, { docsDir: DOCS });
    const overlaps = report.findings.filter((f) => f.kind === 'symbol-overlap');
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]!.refs.sort()).toEqual(['R1', 'R2']);
  });

  it('caps per family per sheet and states the suppressed count', async () => {
    const report = await checkLegibility(UGLY, {
      docsDir: DOCS,
      config: { thresholds: { familyCap: 2 } },
    });
    const ungroupedRoot = report.findings.filter((f) => f.kind === 'ungrouped-symbol' && f.sheet === '/');
    expect(ungroupedRoot).toHaveLength(2);
    const s = report.suppressed.find((x) => x.family === 'ungrouped-symbol' && x.sheet === '/');
    expect(s?.count).toBe(3); // 5 ungrouped symbols on the root sheet, 2 reported
    expect(formatLegibility(report)).toContain('3 more ungrouped-symbol finding(s)');
  });

  it('severity can be overridden and families disabled (AC-16.30)', async () => {
    const off = await checkLegibility(UGLY, { docsDir: DOCS, config: { severity: { crowding: 'off' } } });
    expect(off.findings.some((f) => f.kind === 'crowding')).toBe(false);
    expect(off.disabled).toContain('crowding');

    const promoted = await checkLegibility(UGLY, {
      docsDir: DOCS,
      config: { severity: { 'low-utilization': 'error' } },
    });
    const lu = promoted.findings.find((f) => f.kind === 'low-utilization');
    expect(lu?.severity).toBe('error');
  });

  it('attributes sub-sheet findings to the sub-sheet', async () => {
    const report = await checkLegibility(UGLY, { docsDir: DOCS });
    const outOfFrame = report.findings.filter((f) => f.kind === 'out-of-frame');
    expect(outOfFrame.length).toBeGreaterThan(0);
    expect(outOfFrame.every((f) => f.sheet === 'sub')).toBe(true);
    const overlaps = report.findings.filter((f) => f.kind === 'symbol-overlap');
    expect(overlaps.every((f) => f.sheet === '/')).toBe(true);
  });

  it('leaves the schematic bytes unchanged (AC-16.28)', async () => {
    const before = await readFile(UGLY);
    await checkLegibility(UGLY, { docsDir: DOCS });
    const after = await readFile(UGLY);
    expect(after.equals(before)).toBe(true);
  });

  it('never reaches for a subprocess or the network (module-level)', async () => {
    for (const rel of ['../src/kicad/legibility.ts', '../src/kicad/sexp.ts']) {
      const src = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), rel), 'utf8');
      expect(src).not.toMatch(/execa|child_process|node:http|node:net|fetch\(/);
    }
  });
});

describe('legibility checker: edge semantics', () => {
  it('unknown paper size skips page checks loudly instead of passing', async () => {
    const { file, cleanup } = await inTemp(sch(symR('R1', 300, 300), '(paper "Weird")'));
    try {
      const report = await checkLegibility(file, { docsDir: DOCS });
      expect(report.skipped.some((s) => s.family === 'page-checks' && s.reason.includes('Weird'))).toBe(true);
      expect(report.findings.some((f) => f.kind === 'out-of-frame' || f.kind === 'low-utilization')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('power symbols are exempt from group membership', async () => {
    const body = `
      (rectangle (start 20 20) (end 120 120) (stroke (width 0.152) (type solid)) (fill (type none)) (uuid "aaaa0000-0000-4000-8000-00000000r001"))
      (text "Power" (at 30 26 0) (effects (font (size 2 2))) (uuid "aaaa0000-0000-4000-8000-00000000t001"))
      ${symR('R1', 63.5, 63.5)}
      (symbol (lib_id "power:GND") (at 203.2 101.6 0) (uuid "aaaa0000-0000-4000-8000-00000000s0pw")
        (property "Reference" "#PWR1" (at 203.2 101.6 0) (effects (font (size 1.27 1.27)) hide))
        (property "Value" "GND" (at 203.2 101.6 0) (effects (font (size 1.27 1.27)) hide))
        (pin "1" (uuid "aaaa0000-0000-4000-8000-00000000ppwr"))
      )`;
    const { file, cleanup } = await inTemp(sch(body));
    try {
      const report = await checkLegibility(file, { docsDir: DOCS });
      expect(report.findings.some((f) => f.kind === 'ungrouped-symbol' && f.refs.includes('#PWR1'))).toBe(false);
      expect(report.findings.some((f) => f.kind === 'ungrouped-symbol')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('a global label is measured as its flag: centred on the wire, margins and tip included', async () => {
    // "R1" reference text 3 mm below the anchor line of a rightward flag: a
    // local label (standing above its wire) would clear it, the flag's
    // outline (a height each side of the line) does not.
    const body = `
      (wire (pts (xy 60 80) (xy 73.66 80)) (stroke (width 0) (type default)) (uuid "aaaa0000-0000-4000-8000-00000000w001"))
      (global_label "FLAG_NET" (shape input) (at 73.66 80 0) (fields_autoplaced yes) (effects (font (size 1.27 1.27)) (justify left)) (uuid "aaaa0000-0000-4000-8000-00000000gl01"))
      (text "R1 value" (at 76 81 0) (effects (font (size 1.27 1.27))) (uuid "aaaa0000-0000-4000-8000-00000000t001"))`;
    const { file, cleanup } = await inTemp(sch(body));
    try {
      const report = await checkLegibility(file, { docsDir: DOCS });
      expect(report.findings.filter((f) => f.kind === 'text-collision').map((f) => f.refs)).toEqual([[`text "R1 value"`, `label "FLAG_NET"`]]);
    } finally {
      await cleanup();
    }
  });

  it('a global flag continuing a vertical wire is not a label-orientation finding', async () => {
    const body = `
      (wire (pts (xy 60 90) (xy 60 80)) (stroke (width 0) (type default)) (uuid "aaaa0000-0000-4000-8000-00000000w001"))
      (global_label "UP_NET" (shape passive) (at 60 80 90) (fields_autoplaced yes) (effects (font (size 1.27 1.27)) (justify left)) (uuid "aaaa0000-0000-4000-8000-00000000gl01"))
      (label "LONE" (at 100 80 90) (effects (font (size 1.27 1.27))) (uuid "aaaa0000-0000-4000-8000-00000000lbl2"))`;
    const { file, cleanup } = await inTemp(sch(body));
    try {
      const report = await checkLegibility(file, { docsDir: DOCS });
      const turned = report.findings.filter((f) => f.kind === 'label-orientation').map((f) => f.refs[0]);
      expect(turned).toEqual(['LONE']);
    } finally {
      await cleanup();
    }
  });

  it('under-estimates text extents: a marginal near-collision is not reported (design C3)', async () => {
    // A 180-rotated label extends leftward from its anchor toward the body.
    // At the true stroke-font advance (~0.85 x height) the text would reach the
    // body edge at x=64.5; the deliberate 0.6 ratio stops at x=66.0 and must
    // not report. anchor 73.66, 10-char label: conservative reach 7.62mm,
    // true reach ~10.8mm.
    const body = `
      ${symR('R1', 63.5, 63.5)}
      (label "WIDE_LABEL" (at 73.66 63.5 180) (effects (font (size 1.27 1.27))) (uuid "aaaa0000-0000-4000-8000-00000000lbl1"))`;
    const { file, cleanup } = await inTemp(sch(body));
    try {
      const report = await checkLegibility(file, { docsDir: DOCS });
      expect(report.findings.some((f) => f.kind === 'text-collision')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('caption naming nothing in the docs is an unlabeled-group finding', async () => {
    const body = `
      (rectangle (start 20 20) (end 120 120) (stroke (width 0.152) (type solid)) (fill (type none)) (uuid "aaaa0000-0000-4000-8000-00000000r001"))
      (text "Flux Capacitor" (at 30 26 0) (effects (font (size 2 2))) (uuid "aaaa0000-0000-4000-8000-00000000t001"))
      ${symR('R1', 63.5, 63.5)}`;
    const { file, cleanup } = await inTemp(sch(body));
    try {
      const report = await checkLegibility(file, { docsDir: DOCS });
      const f = report.findings.find((x) => x.kind === 'unlabeled-group');
      expect(f?.refs).toContain('Flux Capacitor');
      expect(f?.detail).toContain('SUBSYSTEMS.md');
    } finally {
      await cleanup();
    }
  });

  it('missing docs skip caption validation loudly while geometric checks still run', async () => {
    const body = `
      (rectangle (start 20 20) (end 120 120) (stroke (width 0.152) (type solid)) (fill (type none)) (uuid "aaaa0000-0000-4000-8000-00000000r001"))
      ${symR('R1', 203.2, 152.4)}`;
    const { file, cleanup } = await inTemp(sch(body));
    try {
      const report = await checkLegibility(file, { docsDir: path.dirname(file) });
      expect(report.skipped.some((s) => s.family === 'caption-validation')).toBe(true);
      // geometric group checks still run: captionless rect + symbol outside it
      expect(report.findings.some((f) => f.kind === 'unlabeled-group')).toBe(true);
      expect(report.findings.some((f) => f.kind === 'ungrouped-symbol' && f.refs.includes('R1'))).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe('legibility wiring', () => {
  it('schematic edits open the legibility obligation; clear closes it', () => {
    const ledger = new ObligationsLedger();
    ledger.onKicadEdit('hardware/x.kicad_sch');
    expect(ledger.openOfKind('legibility')).toHaveLength(1);
    expect(ledger.clear('legibility')).toBe(true);
    expect(ledger.isClear).toBe(false); // erc/drift/changelog remain open
    ledger.onKicadEdit('hardware/x.kicad_pcb');
    expect(ledger.openOfKind('legibility')).toHaveLength(0); // board edits do not re-open it
  });

  it('a checker result with errors re-opens the obligation; clean clears it', () => {
    const ledger = new ObligationsLedger();
    ledger.onLegibilityResult(3);
    expect(ledger.openOfKind('legibility')[0]?.detail).toContain('3 error-severity');
    ledger.onLegibilityResult(0);
    expect(ledger.openOfKind('legibility')).toHaveLength(0);
  });

  it('hand-drawn repos are informed, never wedged: ungated ledger opens nothing (C6)', () => {
    const ledger = new ObligationsLedger(false);
    ledger.onKicadEdit('hardware/x.kicad_sch');
    expect(ledger.openOfKind('legibility')).toHaveLength(0);
    expect(ledger.openOfKind('erc')).toHaveLength(1); // electrical gates are unaffected
    ledger.onLegibilityResult(5);
    expect(ledger.openOfKind('legibility')).toHaveLength(0);
  });

  it('check --json carries legibility with every family skipped when no schematic is configured', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-nocfg-'));
    try {
      const res = await runCheck(dir, () => {});
      expect(res.legibility.findings).toEqual([]);
      expect(res.legibility.counts).toEqual({ error: 0, advisory: 0 });
      expect(res.legibility.skipped.map((s) => s.family).sort()).toEqual([...LEGIBILITY_FAMILIES].sort());
      expect(res.ok).toBe(true); // legibility never affects the exit path (AC-16.25)
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('a flag attaches only behind its tip (AC-16.46)', () => {
  const flag = (x: number, y: number, rot: number): string => `(global_label "X" (shape passive) (at ${x} ${y} ${rot}) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify left))
    (uuid "cccc0000-0000-4000-8000-000000000001")
    (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) hide))
  )`;
  const wire = (x1: number, y1: number, x2: number, y2: number): string =>
    `(wire (pts (xy ${x1} ${y1}) (xy ${x2} ${y2})) (stroke (width 0) (type default)) (uuid "dddd0000-0000-4000-8000-0000000${String(Math.round(x2 * 100)).padStart(5, '0')}"))`;

  it('a wire continuing under a flag\'s text is text on a wire', async () => {
    // the wire runs from 100 to 130 through the anchor at 110; the flag's text extends right over it
    const { file, cleanup } = await inTemp(sch(`${wire(101.6, 101.6, 132.08, 101.6)}\n${flag(111.76, 101.6, 0)}`));
    try {
      const rep = await checkLegibility(file, { docsDir: null });
      expect(rep.findings.some((f) => f.kind === 'text-collision' && /X.*sits on a wire/.test(f.detail))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('a wire ending at the flag\'s tip is its attachment, not a collision', async () => {
    const { file, cleanup } = await inTemp(sch(`${wire(101.6, 101.6, 111.76, 101.6)}\n${flag(111.76, 101.6, 0)}`));
    try {
      const rep = await checkLegibility(file, { docsDir: null });
      expect(rep.findings.filter((f) => f.kind === 'text-collision')).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
