import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, cp, rm, writeFile, mkdir, readFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { any_circuit_element } from 'circuit-json';
import { runExportCircuitJson, ExportError } from '../src/commands/export.js';
import { draftSchematic } from '../src/kicad/draft/draft.js';
import { buildCircuitJson } from '../src/kicad/draft/circuit-json.js';
import type { ValidatedIntent, SchematicIntent } from '../src/kicad/draft/ir.js';
import type { PlacementModel } from '../src/kicad/emit.js';
import type { ResolvedSymbol } from '../src/kicad/draft/symsource.js';

/**
 * circuit-json export (capability circuit-json-export): a derived read-only
 * view of a drafted sheet. The pinned `circuit-json` package's own Zod schemas
 * are the format oracle, so a field-name drift in the serializer fails here
 * rather than shipping junk. All offline.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRAFT_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'draft');
const SYMLIB = path.join(ROOT, 'test', 'fixtures', 'symlib');

async function draftedRepo(): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-cjexport-'));
  await cp(path.join(DRAFT_FIXTURE, 'schematic.intent.json'), path.join(repo, 'schematic.intent.json'));
  await cp(path.join(DRAFT_FIXTURE, 'docs'), path.join(repo, 'docs'), { recursive: true });
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  await writeFile(
    path.join(repo, '.copperhead', 'config.json'),
    JSON.stringify({ schematic: 'board.kicad_sch', docs: 'docs/' }),
    'utf8',
  );
  const res = await draftSchematic({
    repoRoot: repo,
    schematic: 'board.kicad_sch',
    intentPath: 'schematic.intent.json',
    docsDir: path.join(repo, 'docs'),
    symbolDirs: [SYMLIB],
  });
  if (!res.ok) throw new Error(res.message);
  return { repo, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

type Element = Record<string, any>;

async function exportedElements(repo: string): Promise<Element[]> {
  const res = await runExportCircuitJson({ repoRoot: repo });
  return JSON.parse(await readFile(path.join(repo, res.outPath), 'utf8')) as Element[];
}

describe('export circuit-json', () => {
  it('emits schema-valid elements covering the intent, deterministically', async () => {
    const { repo, cleanup } = await draftedRepo();
    try {
      const elements = await exportedElements(repo);
      expect(elements.length).toBeGreaterThan(0);
      for (const el of elements) {
        const parsed = any_circuit_element.safeParse(el);
        expect(parsed.success, `element ${el.type} failed schema: ${JSON.stringify(el)}`).toBe(true);
      }

      const intent = JSON.parse(await readFile(path.join(repo, 'schematic.intent.json'), 'utf8')) as SchematicIntent;
      const refdes = elements.filter((e) => e.type === 'source_component').map((e) => e.name as string);
      expect(new Set(refdes)).toEqual(new Set(intent.parts.map((p) => p.ref)));
      const netNames = elements.filter((e) => e.type === 'source_net').map((e) => e.name as string);
      expect(new Set(netNames)).toEqual(new Set(intent.nets.map((n) => n.name)));

      // Determinism: a second run yields byte-identical output.
      const first = await readFile(path.join(repo, 'outputs', 'circuit.json'), 'utf8');
      await runExportCircuitJson({ repoRoot: repo });
      const second = await readFile(path.join(repo, 'outputs', 'circuit.json'), 'utf8');
      expect(second).toBe(first);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('carries connectivity faithfully: net pins map to ports, noConnect pins are traceless', async () => {
    const { repo, cleanup } = await draftedRepo();
    try {
      const elements = await exportedElements(repo);
      const intent = JSON.parse(await readFile(path.join(repo, 'schematic.intent.json'), 'utf8')) as SchematicIntent;

      const componentByRef = new Map(
        elements.filter((e) => e.type === 'source_component').map((e) => [e.name as string, e.source_component_id]),
      );
      const portKey = new Map(
        elements
          .filter((e) => e.type === 'source_port')
          .map((e) => [e.source_port_id as string, `${[...componentByRef.entries()].find(([, id]) => id === e.source_component_id)![0]}.${e.name}`]),
      );
      const netIdByName = new Map(
        elements.filter((e) => e.type === 'source_net').map((e) => [e.name as string, e.source_net_id]),
      );

      for (const net of intent.nets) {
        const trace = elements.find(
          (e) => e.type === 'source_trace' && (e.connected_source_net_ids as string[]).includes(netIdByName.get(net.name) as string),
        )!;
        const connected = (trace.connected_source_port_ids as string[]).map((id) => portKey.get(id)!);
        expect(new Set(connected)).toEqual(new Set(net.pins));
      }

      const allTracedPorts = new Set(
        elements.filter((e) => e.type === 'source_trace').flatMap((e) => e.connected_source_port_ids as string[]),
      );
      for (const nc of intent.noConnect ?? []) {
        const id = [...portKey.entries()].find(([, key]) => key === nc)?.[0];
        expect(id, `noConnect pin ${nc} should exist as a source_port`).toBeDefined();
        expect(allTracedPorts.has(id!), `noConnect pin ${nc} must not appear in any source_trace`).toBe(false);
      }
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('pins the coordinate convention: y negates from KiCad sheet space', () => {
    const symbols = new Map<string, ResolvedSymbol>([
      [
        'R1',
        {
          libId: 'Device:R',
          sourceText: '',
          pins: [{ number: '1', name: '~', etype: 'passive', x: 0, y: 3.81, angle: 270 }],
          body: { minX: -1, minY: -2, maxX: 1, maxY: 2 },
          isPower: false,
          multiUnit: false,
        },
      ],
    ]);
    const validated: ValidatedIntent = {
      intent: {
        version: 1,
        parts: [{ ref: 'R1', libId: 'Device:R', value: '1k', group: 'G' }],
        nets: [{ name: 'N1', pins: ['R1.1'] }],
      },
      symbols,
      docGroups: null,
    };
    const model: PlacementModel = {
      projectName: 't',
      paper: 'A4',
      title: { title: 't', date: '2020-01-01', rev: 'A' },
      libSymbols: [],
      symbols: [
        {
          ref: 'R1',
          libId: 'Device:R',
          value: '1k',
          footprint: '',
          at: { x: 100, y: 50, rot: 0 },
          refAt: { x: 0, y: 0 },
          valueAt: { x: 0, y: 0 },
          pinNumbers: ['1'],
        },
      ],
      wires: [{ x1: 100, y1: 46.19, x2: 110, y2: 46.19, net: 'N1', index: 0 }],
      junctions: [],
      labels: [{ name: 'N1', x: 110, y: 46.19, rot: 0 }],
      noConnects: [],
      rectangles: [],
      captions: [],
    };

    const elements = buildCircuitJson(validated, model);
    const comp = elements.find((e) => e.type === 'schematic_component') as Element;
    // Body center in symbol space is (0, 0), so the component centers on its origin, y negated.
    expect(comp.center).toEqual({ x: 100, y: -50 });
    expect(comp.size).toEqual({ width: 2, height: 4 });
    const port = elements.find((e) => e.type === 'schematic_port') as Element;
    // Pin (0, 3.81) symbol space → sheet (100, 50 - 3.81) → circuit-json y negated.
    expect(port.center).toEqual({ x: 100, y: -46.19 });
    const label = elements.find((e) => e.type === 'schematic_net_label') as Element;
    expect(label.center).toEqual({ x: 110, y: -46.19 });
    expect(label.anchor_side).toBe('left');
    const trace = elements.find((e) => e.type === 'schematic_trace') as Element;
    expect(trace.edges).toEqual([{ from: { x: 100, y: -46.19 }, to: { x: 110, y: -46.19 } }]);
  });

  it('is listed beside bom under export --help (cli-surface)', async () => {
    const res = await execa('npx', ['tsx', 'src/cli.ts', 'export', '--help'], {
      cwd: ROOT,
      reject: false,
      env: { NO_COLOR: '1' },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('bom');
    expect(res.stdout).toContain('circuit-json');
  }, 60_000);

  it('refuses when there is no intent file, naming the drafted-only scope', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-cjexport-'));
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ schematic: 'board.kicad_sch', docs: 'docs/' }),
        'utf8',
      );
      await writeFile(path.join(repo, 'board.kicad_sch'), '(kicad_sch)', 'utf8');
      await expect(runExportCircuitJson({ repoRoot: repo })).rejects.toThrow(/schematic\.intent\.json.*drafted/s);
      expect(existsSync(path.join(repo, 'outputs', 'circuit.json'))).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('refuses a stale or hand-edited schematic and writes nothing', async () => {
    const { repo, cleanup } = await draftedRepo();
    try {
      await appendFile(path.join(repo, 'board.kicad_sch'), '\n', 'utf8');
      await expect(runExportCircuitJson({ repoRoot: repo })).rejects.toThrow(ExportError);
      await expect(runExportCircuitJson({ repoRoot: repo })).rejects.toThrow(/re-draft/);
      expect(existsSync(path.join(repo, 'outputs', 'circuit.json'))).toBe(false);
    } finally {
      await cleanup();
    }
  }, 60_000);
});
