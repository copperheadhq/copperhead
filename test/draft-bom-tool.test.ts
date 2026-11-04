import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dispatchTool, type RunContext } from '../src/agent/tools.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import { catalog } from '../src/capabilities/index.js';
import { renderManifest } from '../src/kicad/parts/render.js';
import { parseManifest } from '../src/kicad/parts/manifest.js';

// structured-part-selection: the draft_bom tool (agent-core delta) mirrors
// draft_schematic — validate, render on clean, leave BOM.md alone on
// findings, write nothing on invalid JSON. Fixture symbols, fixture stock
// footprints through the env overrides the resolvers honour.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');

function mod(name: string, pads: string[]): string {
  return `(footprint "${name}" (version 20240108) (generator "test") (layer "F.Cu")\n${pads.map((p) => `  (pad "${p}" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))`).join('\n')}\n)\n`;
}

let stock: string;
beforeAll(async () => {
  stock = await mkdtemp(path.join(tmpdir(), 'copperhead-draftbom-stock-'));
  await mkdir(path.join(stock, 'Resistor_SMD.pretty'), { recursive: true });
  await writeFile(path.join(stock, 'Resistor_SMD.pretty', 'R_0603_1608Metric.kicad_mod'), mod('R_0603_1608Metric', ['1', '2']));
  await mkdir(path.join(stock, 'Package_SO.pretty'), { recursive: true });
  await writeFile(path.join(stock, 'Package_SO.pretty', 'SOIC-8_3.9x4.9mm_P1.27mm.kicad_mod'), mod('SOIC-8_3.9x4.9mm_P1.27mm', ['1', '2', '3', '4', '5', '6', '7', '8']));
  vi.stubEnv('KICAD_SYMBOL_DIR', SYMLIB);
  vi.stubEnv('KICAD_FOOTPRINT_DIR', stock);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(stock, { recursive: true, force: true });
});

async function repo(): Promise<{ root: string; ctx: RunContext; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), 'copperhead-draftbom-'));
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs', 'SUBSYSTEMS.md'), '# Subsystems\n\n## Power\n\nrail\n\n## MCU\n\ncore\n');
  const { loadConfig } = await import('../src/config.js');
  const ctx: RunContext = {
    repoRoot: root,
    config: await loadConfig(root),
    transcript: { event: async () => {} } as unknown as RunContext['transcript'],
    ledger: new ObligationsLedger(),
    runId: 'test',
    interactive: false,
    confirm: async () => true,
    editsUnlocked: true,
    changeId: 'test-change',
    proposalValidated: true,
    filesTouched: new Set(),
    decisions: [],
    lastErc: null,
    lastDrc: null,
    lastLegibility: null,
    lastScore: null,
    repairCycles: 0,
    finishRequest: null,
  };
  return { root, ctx, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const CLEAN = {
  version: 1,
  parts: [
    { ref: 'U1', value: 'MCU8', libId: 'CopperMCU:MCU8', footprint: 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', mpn: 'MCU8-SOIC', group: 'MCU', rationale: 'controller' },
    { ref: 'R1', value: '10k', package: '0603', group: 'MCU' },
    { ref: 'BT1', value: '500mAh Li-Po', mpn: 'LP503035', offBoard: true, group: 'Power' },
  ],
};

describe('draft_bom tool', () => {
  it('is registered as a gated mutation whose description carries the manifest schema', () => {
    const t = catalog.find((e) => e.name === 'draft_bom');
    expect(t?.kind).toBe('tool');
    expect(t?.viewHint).toBe('mutation');
    const d = (t as { schema?: { description: string } }).schema?.description ?? '';
    for (const word of ['"ref"', '"value"', '"group"', '"libId"', '"footprint"', '"mpn"', '"rationale"', '"verified"', '"package"', '"offBoard": true', '"substitutions"', '"reason"', 'UNVERIFIED']) {
      expect(d, word).toContain(word);
    }
  });

  it('writes the manifest, validates it, and renders BOM.md when clean', async () => {
    const { root, ctx, cleanup } = await repo();
    try {
      const out = await dispatchTool(ctx, 'draft_bom', { manifest_json: JSON.stringify(CLEAN) });
      expect(out).toMatch(/draft_bom: clean — 3 part\(s\) \(2 on the board, 1 off-board\) rendered to docs\/BOM.md/);
      const bom = await readFile(path.join(root, 'docs', 'BOM.md'), 'utf8');
      expect(bom).toBe(renderManifest(parseManifest(JSON.stringify(CLEAN)).manifest!));
      expect(bom).toContain('| R1 | 10k | Resistor_SMD:R_0603_1608Metric |  |  | Device:R |');
      expect([...ctx.filesTouched]).toEqual(['docs/parts.intent.json', 'docs/BOM.md']);
      expect(ctx.ledger.openOfKind('drift')).toHaveLength(1); // a doc write opens the drift obligation
      // a second call on the same file reports the match and writes nothing new
      const again = await dispatchTool(ctx, 'draft_bom', {});
      expect(again).toContain('docs/BOM.md already matches');
    } finally {
      await cleanup();
    }
  });

  it('reports findings with the refdes and leaves BOM.md unwritten', async () => {
    const { root, ctx, cleanup } = await repo();
    try {
      const bad = { ...CLEAN, parts: [{ ...CLEAN.parts[0], footprint: 'Package_SO:SOIC-8_3.9x4.9mm_P1.37mm' }, { ref: 'C1', value: '100n, X7R, 50V ceramic', package: '0603', group: 'Radio' }] };
      const out = await dispatchTool(ctx, 'draft_bom', { manifest_json: JSON.stringify(bad) });
      expect(out).toMatch(/finding\(s\)/);
      expect(out).toMatch(/U1: footprint "Package_SO:SOIC-8_3.9x4.9mm_P1.37mm" is not in library "Package_SO"; installed: Package_SO:SOIC-8_3.9x4.9mm_P1.27mm/);
      expect(out).toMatch(/C1: "value" reads as a description/);
      expect(out).toMatch(/C1: group "Radio" is not a SUBSYSTEMS.md heading; available: Power, MCU/);
      expect(out).toContain('BOM.md not written');
      expect(existsSync(path.join(root, 'docs', 'BOM.md'))).toBe(false);
      expect(existsSync(path.join(root, 'docs', 'parts.intent.json'))).toBe(true); // the manifest is kept for the next edit
    } finally {
      await cleanup();
    }
  });

  it('refuses invalid JSON without writing either file', async () => {
    const { root, ctx, cleanup } = await repo();
    try {
      const out = await dispatchTool(ctx, 'draft_bom', { manifest_json: '{"version": 1, "parts": [' });
      expect(out).toMatch(/not valid JSON/);
      expect(existsSync(path.join(root, 'docs', 'parts.intent.json'))).toBe(false);
      expect(existsSync(path.join(root, 'docs', 'BOM.md'))).toBe(false);
      expect(ctx.filesTouched.size).toBe(0);
      expect(await dispatchTool(ctx, 'draft_bom', {})).toMatch(/no docs\/parts.intent.json yet/);
    } finally {
      await cleanup();
    }
  });

  it('reports an uninstalled library as the user stop and still finishes clean', async () => {
    const { ctx, cleanup } = await repo();
    try {
      const m = { ...CLEAN, parts: [{ ...CLEAN.parts[0], footprint: 'Vendor_QFN:QFN-8_Special' }] };
      const out = await dispatchTool(ctx, 'draft_bom', { manifest_json: JSON.stringify(m) });
      expect(out).toMatch(/draft_bom: clean/);
      expect(out).toMatch(/need a library the user must install/);
      expect(out).toMatch(/U1: Vendor_QFN:QFN-8_Special/);
    } finally {
      await cleanup();
    }
  });
});
