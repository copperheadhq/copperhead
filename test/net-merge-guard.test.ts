import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { draftSchematicToText } from '../src/kicad/draft/draft.js';
import { findWireContactMerges } from '../src/kicad/draft/engine.js';

/**
 * I22 (#204): the trunk-and-branch router chose the median stub-end x as its
 * trunk — for a net with two pins on one symbol side that IS the stub/label
 * column — and its only veto was wire-through-body. The trunk ran down the
 * column of neighbouring stub ends, and KiCad joins a wire endpoint sitting
 * on another wire's interior, so the lemondrop run shorted the crystal drive
 * (XO_MCU, nee HSE_DRV) onto TOUCH_IRQ, survived every intent-level lever
 * (rename, paper size, group order, declaration order), and ERC demoted the
 * merge to a warning. Two fixes under test here: the router now refuses any
 * candidate touching a foreign connection point, and the merged-net gate now
 * sees wire-level contact, so no future pass can ship the geometry silently.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');

describe('findWireContactMerges (the wire-level half of the merged-net gate)', () => {
  it('detects an endpoint resting on a foreign wire interior (the lemondrop geometry)', () => {
    // Verbatim coordinates from the attempt-05 sheet: the XO_MCU elbow runs
    // down x=363.22 from y=50.8 to 57.15, straight through the endpoint of
    // TOUCH_IRQ's labelled stub at (363.22, 55.88).
    const wires = [
      { x1: 365.76, y1: 50.8, x2: 363.22, y2: 50.8, net: 'XO_MCU' },
      { x1: 363.22, y1: 50.8, x2: 363.22, y2: 57.15, net: 'XO_MCU' },
      { x1: 363.22, y1: 57.15, x2: 312.42, y2: 57.15, net: 'XO_MCU' },
      { x1: 312.42, y1: 57.15, x2: 312.42, y2: 59.69, net: 'XO_MCU' },
      { x1: 365.76, y1: 55.88, x2: 363.22, y2: 55.88, net: 'TOUCH_IRQ' },
    ];
    const merges = findWireContactMerges(wires, []);
    expect(merges).toHaveLength(1);
    expect(merges[0]!.nets).toEqual(['TOUCH_IRQ', 'XO_MCU']);
    expect(merges[0]!.x).toBeCloseTo(363.22);
    expect(merges[0]!.y).toBeCloseTo(55.88);
  });

  it('ignores same-net T-contact and pure interior crossings', () => {
    const wires = [
      // same-net T-join: normal wiring
      { x1: 0, y1: 0, x2: 10, y2: 0, net: 'A' },
      { x1: 5, y1: 0, x2: 5, y2: 5, net: 'A' },
      // different nets crossing mid-segment: not a connection in KiCad
      { x1: 20, y1: -5, x2: 20, y2: 5, net: 'B' },
      { x1: 15, y1: 0, x2: 25, y2: 0, net: 'C' },
    ];
    expect(findWireContactMerges(wires, [])).toEqual([]);
  });

  it('flags a label whose anchor sits on a foreign net wire', () => {
    const wires = [{ x1: 0, y1: 0, x2: 10, y2: 0, net: 'A' }];
    const merges = findWireContactMerges(wires, [{ name: 'B', x: 5, y: 0 }]);
    expect(merges).toHaveLength(1);
    expect(merges[0]!.nets).toEqual(['A', 'B']);
  });
});

describe('trunk-and-branch router (I22/#204 end to end)', () => {
  // Two pins on U1's right side force the median trunk candidate onto the
  // stub column; the victim's labelled stub end sits between them. Before the
  // fix this drafted OK with the two nets electrically merged — the silent
  // outcome that shipped HSE_DRV onto TOUCH_IRQ. After it, the router vetoes
  // the foreign contact; whatever the sheet then does, a silent merge is the
  // one outcome that must be impossible: either the draft succeeds with
  // disjoint nets, or the engine refuses loudly naming the merge.
  const INTENT = {
    version: 1,
    parts: [
      { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', footprint: 'Package_SO:SOIC-8', group: 'MCU' },
      { ref: 'R1', libId: 'Device:R', value: '10k', footprint: 'Resistor_SMD:R_0603', group: 'MCU' },
      { ref: 'J1', libId: 'CopperConn:Conn_01x03', value: 'Conn_01x03', footprint: 'Connector:X', group: 'Power' },
    ],
    nets: [
      { name: 'MERGEME', pins: ['U1.4', 'U1.8', 'R1.1'] },
      { name: 'VICTIM', pins: ['U1.6', 'J1.1'] },
    ],
    noConnect: ['U1.1', 'U1.2', 'U1.3', 'U1.5', 'U1.7', 'R1.2', 'J1.2', 'J1.3'],
  };

  const BOM = `# BOM

| Refdes | Value | Footprint | MPN | Rationale |
| --- | --- | --- | --- | --- |
| U1 | MCU8 | Package_SO:SOIC-8 | UNVERIFIED | controller |
| R1 | 10k | Resistor_SMD:R_0603 | UNVERIFIED | pull |
| J1 | Conn_01x03 | Connector:X | UNVERIFIED | io |
`;

  const SUBSYSTEMS = `# Subsystems

## MCU

Controller and pull.

## Power

Connector.
`;

  type Seg = { x1: number; y1: number; x2: number; y2: number };
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.01;
  const onSeg = (px: number, py: number, s: Seg): boolean => {
    if (near(s.x1, s.x2)) return near(px, s.x1) && py >= Math.min(s.y1, s.y2) - 0.01 && py <= Math.max(s.y1, s.y2) + 0.01;
    if (near(s.y1, s.y2)) return near(py, s.y1) && px >= Math.min(s.x1, s.x2) - 0.01 && px <= Math.max(s.x1, s.x2) + 0.01;
    return false;
  };

  it('never lets a trunk down a stub column merge nets silently', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-netmerge-'));
    try {
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'schematic.intent.json'), JSON.stringify(INTENT, null, 2), 'utf8');
      await writeFile(path.join(repo, 'docs', 'BOM.md'), BOM, 'utf8');
      await writeFile(path.join(repo, 'docs', 'SUBSYSTEMS.md'), SUBSYSTEMS, 'utf8');
      const res = await draftSchematicToText({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        intentPath: 'schematic.intent.json',
        docsDir: 'docs',
        symbolDirs: [SYMLIB],
      });
      if (!res.ok) {
        // A loud refusal naming the merge honors the contract; silence is the bug.
        expect(res.message).toMatch(/merge/i);
        return;
      }
      const text = res.text;
      const wires: Seg[] = [...text.matchAll(/\(wire\s*\(pts\s*\(xy ([\d.-]+) ([\d.-]+)\)\s*\(xy ([\d.-]+) ([\d.-]+)\)/g)].map(
        (m) => ({ x1: +m[1]!, y1: +m[2]!, x2: +m[3]!, y2: +m[4]! }),
      );
      const labels = [...text.matchAll(/\(label "([^"]+)"\s*\(at ([\d.-]+) ([\d.-]+)/g)].map((m) => ({
        name: m[1]!,
        x: +m[2]!,
        y: +m[3]!,
      }));
      // union-find over endpoint-on-segment contact, KiCad's join rule
      const parent = wires.map((_, i) => i);
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
      for (let i = 0; i < wires.length; i++)
        for (let j = i + 1; j < wires.length; j++) {
          const a = wires[i]!;
          const b = wires[j]!;
          if (onSeg(a.x1, a.y1, b) || onSeg(a.x2, a.y2, b) || onSeg(b.x1, b.y1, a) || onSeg(b.x2, b.y2, a)) {
            parent[find(i)] = find(j);
          }
        }
      const compsOf = (name: string): number[] => {
        const out: number[] = [];
        for (const l of labels.filter((l) => l.name === name))
          for (let i = 0; i < wires.length; i++) if (onSeg(l.x, l.y, wires[i]!)) out.push(find(i));
        return out;
      };
      const merge = compsOf('MERGEME');
      const victim = compsOf('VICTIM');
      expect(merge.length).toBeGreaterThan(0);
      expect(victim.length).toBeGreaterThan(0);
      expect(merge.some((c) => victim.includes(c))).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('labelled-stub fallback avoids foreign contact (I22 third face)', () => {
  // BUCK_SS shape from lemondrop attempt-06: a two-pin net from an IC pin to
  // a cap whose other terminal is GND. The chain drop places the cap below
  // the stub axis, the wired route is correctly vetoed, and the fallback
  // stub's 2-unit endpoint would land exactly on the neighbouring power
  // pin's stub interior. The stub must grow past the contact (its interior
  // then crosses the foreign wire mid-segment, which does not connect), and
  // the draft must succeed with disjoint nets.
  it('grows the stub past a foreign power-stub row instead of merging', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-capdrop-'));
    try {
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs', 'SUBSYSTEMS.md'), '## Main\n', 'utf8');
      await writeFile(
        path.join(repo, 'schematic.intent.json'),
        JSON.stringify({
          version: 1,
          parts: [
            { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', footprint: 'X:Y', group: 'Main' },
            { ref: 'C9', libId: 'Device:C', value: '100n', footprint: 'X:Y', group: 'Main' },
          ],
          nets: [
            { name: 'BUCK_SS', pins: ['U1.3', 'C9.1'] },
            { name: 'GND', pins: ['C9.2', 'U1.2'] },
          ],
          noConnect: ['U1.1', 'U1.4', 'U1.5', 'U1.6', 'U1.7', 'U1.8'],
        }),
        'utf8',
      );
      const res = await draftSchematicToText({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        intentPath: 'schematic.intent.json',
        docsDir: 'docs',
        symbolDirs: [SYMLIB],
      });
      expect(res.ok, res.ok ? '' : (res as { message: string }).message).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('symbol-field slot refinement (I23, #210)', () => {
  it('every emitted ref/value box clears wires and foreign bodies when a clear slot exists', async () => {
    // The cap-to-ground drop leaves C9 flush against U1; before the
    // refinement its heuristic field slot could land on the neighbour's body
    // or a wire with no IR lever to move it (attempt-07 aborted ERC-clean on
    // exactly this class).
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-fieldslots-'));
    try {
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs', 'SUBSYSTEMS.md'), '## Main\n', 'utf8');
      await writeFile(
        path.join(repo, 'schematic.intent.json'),
        JSON.stringify({
          version: 1,
          parts: [
            { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', footprint: 'X:Y', group: 'Main' },
            { ref: 'C9', libId: 'Device:C', value: '100n', footprint: 'X:Y', group: 'Main' },
            { ref: 'R3', libId: 'Device:R', value: '10k', footprint: 'X:Y', group: 'Main' },
          ],
          nets: [
            { name: 'BUCK_SS', pins: ['U1.3', 'C9.1'] },
            { name: 'GND', pins: ['C9.2', 'U1.2'] },
            { name: 'PULL', pins: ['U1.4', 'R3.1'] },
            { name: 'VCC', pins: ['R3.2', 'U1.1'] },
          ],
          noConnect: ['U1.5', 'U1.6', 'U1.7', 'U1.8'],
        }),
        'utf8',
      );
      const res = await draftSchematicToText({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        intentPath: 'schematic.intent.json',
        docsDir: 'docs',
        symbolDirs: [SYMLIB],
      });
      expect(res.ok, res.ok ? '' : (res as { message: string }).message).toBe(true);
      if (!res.ok) return;
      const sch = path.join(repo, 'board.kicad_sch');
      const { writeFile: wf } = await import('node:fs/promises');
      await wf(sch, res.text, 'utf8');
      const { checkLegibility } = await import('../src/kicad/legibility.js');
      const leg = await checkLegibility(sch, { docsDir: path.join(repo, 'docs') });
      const fieldErrors = leg.findings.filter(
        (f) => f.severity === 'error' && /(Reference|Value) text (overlaps the body|sits on a wire)/.test(f.detail) && !/#PWR/.test(f.detail),
      );
      expect(fieldErrors, JSON.stringify(fieldErrors, null, 2)).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
