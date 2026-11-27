/**
 * Intent compiler and physics compiler (RFC 11 §7.4, §7.6; Phase 4 tasks 6.3,
 * 6.4): the deterministic steps with and without a model, model answers
 * validated and never trusted, authority merge, holds, and the report.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileIntent } from '../src/pcb/agent/intent/compiler.js';
import { widthForCurrent, widthConstraint, impedance } from '../src/pcb/intent/physics.js';
import { importBoard } from '../src/pcb/ir/kicad/import.js';
import type { Provider, Msg, Turn } from '../src/agent/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const GOLDEN = path.join(ROOT, 'test', 'fixtures', 'microboards');
const SUBSYSTEMS = '# Subsystems\n\n## MCU\n\n## Power\n';
const INTENT = { version: 1, parts: [{ ref: 'U1', libId: 'x', value: 'x', group: 'MCU' }, { ref: 'C1', libId: 'x', value: 'x', group: 'MCU' }, { ref: 'Y1', libId: 'x', value: 'x', group: 'MCU' }, { ref: 'R2', libId: 'x', value: 'x', group: 'Power' }], nets: [] };

function fakeProvider(answers: string[]): Provider & { prompts: Msg[][] } {
  const prompts: Msg[][] = [];
  return {
    prompts,
    async chat(messages: Msg[]): Promise<Turn> {
      prompts.push(messages);
      return { text: answers.shift() ?? '{}', toolCalls: [], usage: { tokensIn: 0, tokensOut: 0 } } as unknown as Turn;
    },
    async close() {},
  } as unknown as Provider & { prompts: Msg[][] };
}

async function design() {
  const p = path.join(GOLDEN, 'completion', 'board.kicad_pcb');
  return importBoard({ boardText: await readFile(p, 'utf8'), boardPath: p, projectText: await readFile(p.replace(/\.kicad_pcb$/, '.kicad_pro'), 'utf8'), now: 't' }).design;
}

describe('physics compiler', () => {
  it('IPC-2221 widths grow with current and shrink with copper weight and rise; internal layers need more', () => {
    const w1 = widthForCurrent(1, 1, 10, 'external').widthNm;
    expect(widthForCurrent(2, 1, 10, 'external').widthNm).toBeGreaterThan(w1);
    expect(widthForCurrent(1, 2, 10, 'external').widthNm).toBeLessThan(w1);
    expect(widthForCurrent(1, 1, 30, 'external').widthNm).toBeLessThan(w1);
    expect(widthForCurrent(1, 1, 10, 'internal').widthNm).toBeGreaterThan(w1);
    // 1 A, 1 oz, 10 C external is about 0.3 mm on the generic chart
    expect(w1).toBeGreaterThan(200_000);
    expect(w1).toBeLessThan(500_000);
  });
  it('a fully specified requirement is hard; a partial one is advisory with its assumptions stated', () => {
    const hard = widthConstraint({ net: 'VIN', amps: 3, copperOzFt2: 1, riseC: 10, layer: 'external' });
    expect(hard.key).toBe('layout.routing.width.VIN');
    expect(hard.constraint).toMatchObject({ class: 'routing', severity: 'hard', scope: { nets: ['VIN'] } });
    expect(hard.constraint.parameters!.derived_by).toBe('physics/ipc2221');
    const soft = widthConstraint({ net: 'VIN', amps: 3 });
    expect(soft.constraint.severity).toBe('advisory');
    expect(String(soft.constraint.parameters!.assumed)).toMatch(/copper 1 oz/);
    expect(impedance({ net: 'D+', ohms: 90 }).status).toBe('HOLD');
  });
});

describe('intent compiler', () => {
  it('without a model: blocks, explicit intent, ECAD, and a report; a hard requirement stays hard', async () => {
    const d = await design();
    const res = await compileIntent({ repoRoot: ROOT, design: d, subsystemsMd: SUBSYSTEMS, schematicIntent: INTENT, intentText: 'placement:\n  fixed:\n    - component: J1\n      edge: east\n  attachments:\n    - component: C1\n      target: { component: U1, pins: ["8"] }\n      max_distance_mm: 2\n      priority: critical\n' });
    expect(res.blocks.map((b) => b.id)).toEqual(['mcu', 'power', 'unassigned']);
    expect(res.registry['layout.mechanical.edge.J1']).toMatchObject({ severity: 'hard', source: 'intent' });
    expect(res.registry['layout.relative.attached.C1']!.severity).toBe('hard');
    expect(res.registry['layout.functional.group.mcu']).toMatchObject({ source: 'blocks' });
    expect(res.registry['layout.routing.class.Default.width']).toMatchObject({ source: 'ecad_rules' });
    expect(res.holds).toEqual([]);
    expect(res.report).toContain('## Constraints');
    expect(res.report).toContain('`layout.mechanical.edge.J1`');
    expect(res.report).toMatch(/no model/);
  });
  it('with a model: roles and derived rules are validated, cited, never hard, and lose to the user', async () => {
    const d = await design();
    const provider = fakeProvider([
      '{"roles": {"U1": ["mcu"], "C1": ["decoupling"], "Z9": ["mcu"], "R1": ["bogus-role"]}}',
      JSON.stringify({ rules: [
        { yaml: 'placement:\n  attachments:\n    - component: C1\n      target: { component: U1, pins: ["8"] }\n      max_distance_mm: 1\n      priority: critical\n', cite: 'datasheet U1 p.12', confidence: 0.9 },
        { yaml: 'placement:\n  attachments:\n    - component: R2\n      target: { component: U1 }\n      max_distance_mm: 5\n', cite: 'BOM.md R2', confidence: 0.3 },
        { yaml: 'placement:\n  attachments:\n    - component: C9\n      target: { component: U1 }\n      max_distance_mm: 2\n', cite: 'datasheet', confidence: 0.9 },
        { yaml: 'placement:\n  cooling: []\n', cite: 'x', confidence: 1 },
        { yaml: 'placement:\n  attachments:\n    - component: Y1\n      target: { component: U1 }\n      max_distance_mm: 3\n', confidence: 1 },
      ] }),
    ]);
    const res = await compileIntent({ repoRoot: ROOT, design: d, subsystemsMd: SUBSYSTEMS, schematicIntent: INTENT, bomMd: '| Refdes | Value |\n| U1 | ATTINY |', provider, intentText: 'placement:\n  attachments:\n    - component: C1\n      target: { component: U1, pins: ["8"] }\n      max_distance_mm: 2\n      priority: critical\n' });
    expect(provider.prompts).toHaveLength(2);
    expect(res.roles).toEqual({ U1: ['mcu'], C1: ['decoupling'], R1: [] }); // Z9 not on the board, bogus role dropped
    // the user's C1 rule (2 mm, hard) beats the model's (1 mm), and the user's stays hard
    expect(res.registry['layout.relative.attached.C1']).toMatchObject({ severity: 'hard', source: 'intent', parameters: { max_distance_nm: 2_000_000 } });
    // the model's R2 rule lands soft-then-advisory at confidence 0.3, with its citation as source
    expect(res.registry['layout.relative.attached.R2']).toMatchObject({ severity: 'advisory', source: 'intent-compiler:BOM.md R2', confidence: 0.3 });
    expect(res.holds.some((h) => /R2.*confidence 0\.3/.test(h))).toBe(true);
    expect(res.rejected.map((r) => r.reason)).toEqual(expect.arrayContaining([expect.stringMatching(/not on the board: C9/), expect.stringMatching(/unknown key placement\.cooling/), 'no citation']));
    expect(res.report).toContain('## Rejected proposals');
  });
  it('a model answer that is not JSON degrades to the deterministic result', async () => {
    const d = await design();
    const res = await compileIntent({ repoRoot: ROOT, design: d, subsystemsMd: SUBSYSTEMS, schematicIntent: INTENT, bomMd: 'x', provider: fakeProvider(['sorry, no', 'nope']) });
    expect(res.roles).toEqual({});
    expect(res.rejected).toEqual([]);
    expect(res.report).toMatch(/not the JSON asked for/);
    expect(res.registry['layout.functional.group.mcu']).toBeDefined();
  });
});

describe('copperhead pcb infer-intent', () => {
  it('compiles deterministically into the registry and writes the report', async () => {
    const { mkdtemp, rm, writeFile, mkdir, cp } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { execa } = await import('execa');
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-infer-'));
    try {
      await mkdir(path.join(dir, 'hardware'), { recursive: true });
      await mkdir(path.join(dir, 'docs'), { recursive: true });
      await mkdir(path.join(dir, '.copperhead'), { recursive: true });
      await cp(path.join(GOLDEN, 'completion', 'board.kicad_pcb'), path.join(dir, 'hardware', 'board.kicad_pcb'));
      await cp(path.join(GOLDEN, 'completion', 'board.kicad_pro'), path.join(dir, 'hardware', 'board.kicad_pro'));
      await writeFile(path.join(dir, 'hardware', 'schematic.intent.json'), JSON.stringify(INTENT), 'utf8');
      await writeFile(path.join(dir, 'docs', 'SUBSYSTEMS.md'), SUBSYSTEMS, 'utf8');
      await writeFile(path.join(dir, 'docs', 'LAYOUT.intent.yaml'), 'placement:\n  fixed:\n    - component: J1\n      edge: east\n', 'utf8');
      await writeFile(path.join(dir, '.copperhead', 'config.json'), JSON.stringify({ board: 'hardware/board.kicad_pcb', schematic: 'hardware/board.kicad_sch', docs: 'docs/' }), 'utf8');
      const out = await execa('npx', ['tsx', path.join(ROOT, 'src', 'cli.ts'), '--json', '--repo', dir, 'pcb', 'infer-intent', '--run-dir', '.copperhead/runs/i/intent'], { cwd: ROOT, reject: false });
      expect(out.exitCode, out.stderr).toBe(0);
      const j = JSON.parse(out.stdout);
      expect(j.status).toBe('PASS');
      expect(j.blocks.map((b: { id: string }) => b.id)).toEqual(['mcu', 'power', 'unassigned']);
      const reg = JSON.parse(await readFile(path.join(dir, '.copperhead', 'constraints.json'), 'utf8'));
      expect(reg['layout.mechanical.edge.J1']).toMatchObject({ class: 'mechanical', severity: 'hard' });
      expect(reg['layout.functional.group.mcu']).toBeDefined();
      expect(existsSync(path.join(dir, '.copperhead', 'runs', 'i', 'intent', 'intent-report.md'))).toBe(true);
      // check now sees the intent through the registry-free path (the intent file) and the board passes it: J1 is on the east edge
      const verify = await execa('npx', ['tsx', path.join(ROOT, 'src', 'cli.ts'), '--json', '--repo', dir, 'pcb', 'verify', '--no-kicad'], { cwd: ROOT, reject: false });
      const v = JSON.parse(verify.stdout);
      expect(v.diagnostics.filter((d: { code: string }) => d.code === 'intent.mechanical.edge')).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
