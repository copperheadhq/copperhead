import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, cp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parsePartsManifest, expandAndNormalizeParts } from '../src/kicad/parts/manifest.js';
import { validatePartsManifest } from '../src/kicad/parts/validator.js';
import { renderBomMarkdown } from '../src/kicad/parts/bom-renderer.js';
import { FootprintResolver } from '../src/kicad/footprints.js';
import { dispatchToolResult, type RunContext } from '../src/agent/tools.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SYMLIB = path.join(ROOT, 'test', 'fixtures', 'symlib');
const DRAFT_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'draft');

function generateManifest(count: number) {
  const parts: any[] = [];
  const groups = ['Power', 'MCU', 'Sensors', 'Interface'];

  // Add at least one of each group
  for (let i = 1; i <= count; i++) {
    const group = groups[(i - 1) % groups.length];
    if (i === 1) {
      parts.push({
        ref: 'U1',
        value: 'ATmega328P',
        libId: 'CopperMCU:ATmega328P',
        footprint: 'Resistor_SMD:R_0603_1608Metric',
        mpn: 'ATMEGA328P-AU',
        group: 'MCU',
        rationale: 'Main microcontroller',
      });
    } else if (i % 2 === 0) {
      parts.push({
        ref: `R${i}`,
        value: `${(i * 10) % 100 + 1}k`,
        package: '0603',
        group,
        rationale: `Pull-up resistor ${i}`,
      });
    } else {
      parts.push({
        ref: `C${i}`,
        value: '100nF',
        package: '0402',
        group,
        rationale: `Decoupling capacitor ${i}`,
      });
    }
  }

  return {
    version: 1,
    parts,
    substitutions: [
      { ref: 'R2', wanted: '10k 0.1%', chosen: '10k 1%', reason: 'Supply shortage' },
    ],
  };
}

function stats(durations: number[]): { median: number; min: number; max: number } {
  const sorted = [...durations].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return {
    median: Math.round(median * 100) / 100,
    min: Math.round(sorted[0] * 100) / 100,
    max: Math.round(sorted[sorted.length - 1] * 100) / 100,
  };
}

async function runBenchmark() {
  process.env.KICAD_SYMBOL_DIR = SYMLIB;

  // Setup hermetic repo for draft_bom end-to-end
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-bench-'));
  await cp(path.join(DRAFT_FIXTURE, 'docs'), path.join(repo, 'docs'), { recursive: true });
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  await writeFile(
    path.join(repo, '.copperhead', 'config.json'),
    JSON.stringify({ schematic: 'board.kicad_sch', docs: 'docs/', origin: 'create' }),
    'utf8',
  );

  // Setup fixture footprints
  const rPretty = path.join(repo, 'Resistor_SMD.pretty');
  const cPretty = path.join(repo, 'Capacitor_SMD.pretty');
  await mkdir(rPretty, { recursive: true });
  await mkdir(cPretty, { recursive: true });
  await writeFile(
    path.join(rPretty, 'R_0603_1608Metric.kicad_mod'),
    '(footprint "R_0603_1608Metric" (version 20240108) (generator kicad) (pad "1" smd roundrect (at -0.8 0)) (pad "2" smd roundrect (at 0.8 0)))',
    'utf8',
  );
  await writeFile(
    path.join(cPretty, 'C_0402_1005Metric.kicad_mod'),
    '(footprint "C_0402_1005Metric" (version 20240108) (generator kicad) (pad "1" smd roundrect (at -0.5 0)) (pad "2" smd roundrect (at 0.5 0)))',
    'utf8',
  );
  const fpTable = [
    '(fp_lib_table',
    '  (version 7)',
    '  (lib (name "Resistor_SMD")(type "KiCad")(uri "${KIPRJMOD}/Resistor_SMD.pretty")(options "")(descr ""))',
    '  (lib (name "Capacitor_SMD")(type "KiCad")(uri "${KIPRJMOD}/Capacitor_SMD.pretty")(options "")(descr ""))',
    ')',
  ].join('\n');
  await writeFile(path.join(repo, 'fp-lib-table'), fpTable, 'utf8');

  // Subsystems headers covering all groups
  await writeFile(
    path.join(repo, 'docs', 'SUBSYSTEMS.md'),
    '# Subsystems\n\n## Power\n\n## MCU\n\n## Sensors\n\n## Interface\n',
    'utf8',
  );

  const footprints = await FootprintResolver.create({ projectDir: repo });
  const subHeadings = ['Power', 'MCU', 'Sensors', 'Interface'];
  const symbolDirs = [SYMLIB];

  const sizes = [10, 50, 280];
  const iterations = 10;

  console.log('='.repeat(80));
  console.log('COPPERHEAD PARTS MANIFEST & DRAFT_BOM PERFORMANCE BENCHMARK (FINDING 6)');
  console.log(`Node ${process.version} | Windows | ${iterations} iterations per size`);
  console.log('='.repeat(80));

  const results: Record<string, any> = {};

  for (const count of sizes) {
    const manifestObj = generateManifest(count);
    const jsonStr = JSON.stringify(manifestObj, null, 2);

    const parseTimes: number[] = [];
    const semanticTimes: number[] = [];
    const coldValTimes: number[] = [];
    const warmValTimes: number[] = [];
    const renderTimes: number[] = [];
    const e2eTimes: number[] = [];

    // Warm-up JIT
    parsePartsManifest(jsonStr);
    expandAndNormalizeParts(manifestObj.parts);

    let peakHeapMB = 0;

    for (let it = 0; it < iterations; it++) {
      // 1. Pure JSON parsing
      const t0 = performance.now();
      const parseRes = parsePartsManifest(jsonStr);
      const t1 = performance.now();
      parseTimes.push(t1 - t0);

      // 2. Semantic rules without I/O
      const t2 = performance.now();
      const expRes = expandAndNormalizeParts(parseRes.manifest!.parts);
      const t3 = performance.now();
      semanticTimes.push(t3 - t2);

      // 3. First-pass KiCad library resolution (cold cache)
      const t4 = performance.now();
      await validatePartsManifest(jsonStr, {
        footprints,
        subsystemsHeadings: subHeadings,
        symbolDirs,
      });
      const t5 = performance.now();
      coldValTimes.push(t5 - t4);

      // 4. Warm-cache validation (repeated on same instance)
      const t6 = performance.now();
      await validatePartsManifest(jsonStr, {
        footprints,
        subsystemsHeadings: subHeadings,
        symbolDirs,
      });
      const t7 = performance.now();
      warmValTimes.push(t7 - t6);

      // 5. BOM rendering
      const t8 = performance.now();
      renderBomMarkdown(expRes.expanded, manifestObj.substitutions as any);
      const t9 = performance.now();
      renderTimes.push(t9 - t8);

      // 6. End-to-end draft_bom call
      const ctx: RunContext = {
        repoRoot: repo,
        config: { schematic: 'board.kicad_sch', docs: 'docs/', origin: 'create' } as any,
        transcript: { event: async () => {} } as any,
        filesTouched: new Set(),
        priorChecks: [],
        editsUnlocked: true,
        ledger: { onDocEdit: () => {}, openObligations: [] } as any,
      };

      const t10 = performance.now();
      await dispatchToolResult(ctx, 'draft_bom', { manifest_json: jsonStr });
      const t11 = performance.now();
      e2eTimes.push(t11 - t10);

      const mem = process.memoryUsage().heapUsed / (1024 * 1024);
      if (mem > peakHeapMB) peakHeapMB = mem;
    }

    results[count] = {
      count,
      peakHeapMB: Math.round(peakHeapMB * 100) / 100,
      parse: stats(parseTimes),
      semantic: stats(semanticTimes),
      coldVal: stats(coldValTimes),
      warmVal: stats(warmValTimes),
      render: stats(renderTimes),
      e2e: stats(e2eTimes),
    };

    console.log(`\nScale: ${count} parts (Peak Heap: ${results[count].peakHeapMB} MB)`);
    console.log(`  1. Pure JSON parsing:           median ${results[count].parse.median} ms (range: ${results[count].parse.min} - ${results[count].parse.max} ms)`);
    console.log(`  2. Semantic rules without I/O:   median ${results[count].semantic.median} ms (range: ${results[count].semantic.min} - ${results[count].semantic.max} ms)`);
    console.log(`  3. Cold KiCad library check:    median ${results[count].coldVal.median} ms (range: ${results[count].coldVal.min} - ${results[count].coldVal.max} ms)`);
    console.log(`  4. Warm-cache validation:       median ${results[count].warmVal.median} ms (range: ${results[count].warmVal.min} - ${results[count].warmVal.max} ms)`);
    console.log(`  5. BOM Markdown rendering:      median ${results[count].render.median} ms (range: ${results[count].render.min} - ${results[count].render.max} ms)`);
    console.log(`  6. End-to-end draft_bom call:   median ${results[count].e2e.median} ms (range: ${results[count].e2e.min} - ${results[count].e2e.max} ms)`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('MARKDOWN TABLE FOR REPORT:');
  console.log('| Metric / Stage | 10 parts (median / range) | 50 parts (median / range) | 280 parts (median / range) |');
  console.log('|---|---|---|---|');
  console.log(`| 1. Pure JSON parse | ${results[10].parse.median} ms (${results[10].parse.min}-${results[10].parse.max}) | ${results[50].parse.median} ms (${results[50].parse.min}-${results[50].parse.max}) | ${results[280].parse.median} ms (${results[280].parse.min}-${results[280].parse.max}) |`);
  console.log(`| 2. Semantic rules (no I/O) | ${results[10].semantic.median} ms (${results[10].semantic.min}-${results[10].semantic.max}) | ${results[50].semantic.median} ms (${results[50].semantic.min}-${results[50].semantic.max}) | ${results[280].semantic.median} ms (${results[280].semantic.min}-${results[280].semantic.max}) |`);
  console.log(`| 3. Cold KiCad library check | ${results[10].coldVal.median} ms (${results[10].coldVal.min}-${results[10].coldVal.max}) | ${results[50].coldVal.median} ms (${results[50].coldVal.min}-${results[50].coldVal.max}) | ${results[280].coldVal.median} ms (${results[280].coldVal.min}-${results[280].coldVal.max}) |`);
  console.log(`| 4. Warm-cache validation | ${results[10].warmVal.median} ms (${results[10].warmVal.min}-${results[10].warmVal.max}) | ${results[50].warmVal.median} ms (${results[50].warmVal.min}-${results[50].warmVal.max}) | ${results[280].warmVal.median} ms (${results[280].warmVal.min}-${results[280].warmVal.max}) |`);
  console.log(`| 5. BOM Markdown rendering | ${results[10].render.median} ms (${results[10].render.min}-${results[10].render.max}) | ${results[50].render.median} ms (${results[50].render.min}-${results[50].render.max}) | ${results[280].render.median} ms (${results[280].render.min}-${results[280].render.max}) |`);
  console.log(`| 6. End-to-end draft_bom | ${results[10].e2e.median} ms (${results[10].e2e.min}-${results[10].e2e.max}) | ${results[50].e2e.median} ms (${results[50].e2e.min}-${results[50].e2e.max}) | ${results[280].e2e.median} ms (${results[280].e2e.min}-${results[280].e2e.max}) |`);
  console.log(`| Peak Heap Memory | ${results[10].peakHeapMB} MB | ${results[50].peakHeapMB} MB | ${results[280].peakHeapMB} MB |`);
  console.log('='.repeat(80));

  await rm(repo, { recursive: true, force: true });
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
