import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportFab, resetKicadCliCache, type FabExportResult } from '../src/kicad/cli.js';
import type { RunContext } from '../src/agent/context.js';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', async (importOriginal) => ({
  ...(await importOriginal<typeof import('execa')>()),
  execa: execaMock,
}));

const artifacts = ['gerbers', 'drill', 'outline.dxf', 'board.step', 'board.svg', 'schematic.svg'];
const contents = {
  gerber: 'G04 generated copper*\nM02*\n',
  job: '{"FilesAttributes": []}\n',
  drill: 'M48\nMETRIC\nM30\n',
  dxf: '0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n',
  step: 'ISO-10303-21;\nEND-ISO-10303-21;\n',
  svg: '<svg xmlns="http://www.w3.org/2000/svg"><title>电路</title></svg>\n',
};

type CommandResult = { failed: boolean; exitCode: number; stdout: string; stderr: string };
const success: CommandResult = { failed: false, exitCode: 0, stdout: '', stderr: '' };

function outputPath(args: string[]): string {
  const index = args.indexOf('--output');
  if (index < 0 || !args[index + 1]) throw new Error('mock expected an export output path');
  return args[index + 1]!;
}

async function put(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** Mimic KiCad's mix of file outputs and directories named like files. */
async function emitDefault(args: string[]): Promise<void> {
  const out = outputPath(args);
  switch (`${args[0]}/${args[2]}`) {
    case 'pcb/gerbers':
      await put(path.join(out, 'demo-F_Cu.gbr'), contents.gerber);
      await put(path.join(out, 'demo-job.gbrjob'), contents.job);
      break;
    case 'pcb/drill':
      await put(path.join(out, 'demo-PTH.drl'), contents.drill);
      break;
    case 'pcb/dxf':
      await put(path.join(out, 'demo-Edge_Cuts.dxf'), contents.dxf);
      break;
    case 'pcb/step':
      await put(out, contents.step);
      break;
    case 'pcb/svg':
      await put(out, contents.svg);
      break;
    case 'sch/svg':
      await put(path.join(out, 'demo.svg'), contents.svg);
      break;
    default:
      throw new Error(`unexpected export command: ${args.join(' ')}`);
  }
}

function mockExports(emit: (args: string[]) => Promise<CommandResult | void> = emitDefault): void {
  execaMock.mockImplementation(async (_binary: string, args: string[]) => (await emit(args)) ?? success);
}

describe('fabrication export file inventory', () => {
  let dir: string;
  let outDir: string;
  let pcbPath: string;
  let schPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'copperhead-export-inventory-'));
    outDir = path.join(dir, 'outputs');
    pcbPath = path.join(dir, 'demo.kicad_pcb');
    schPath = path.join(dir, 'demo.kicad_sch');
    vi.stubEnv('COPPERHEAD_KICAD_CLI', '');
    resetKicadCliCache();
    execaMock.mockReset();
    mockExports();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetKicadCliCache();
    await rm(dir, { recursive: true, force: true });
  });

  async function expectActualFiles(result: FabExportResult): Promise<void> {
    expect(result.files.length).toBeGreaterThan(0);
    expect(new Set(result.files.map((file) => file.path)).size).toBe(result.files.length);
    for (const file of result.files) {
      expect(path.isAbsolute(file.path), file.path).toBe(false);
      expect(file.path.split(/[\\/]/), file.path).not.toContain('..');
      const stat = await lstat(path.join(outDir, file.path));
      expect(stat.isFile(), file.path).toBe(true);
      expect(stat.size, file.path).toBeGreaterThan(0);
      expect(file.bytes, file.path).toBe(stat.size);
      expect(result.produced).toContain(file.artifact);
    }
  }

  it('retains legacy artifact tags and reports actual paths and byte sizes, including directory DXF', async () => {
    const result = await exportFab(pcbPath, schPath, outDir);

    expect(result.produced).toEqual(artifacts);
    expect(result.failed).toEqual([]);
    const expected = [
      { artifact: 'gerbers', path: path.posix.join('gerbers', 'demo-F_Cu.gbr'), bytes: Buffer.byteLength(contents.gerber) },
      { artifact: 'gerbers', path: path.posix.join('gerbers', 'demo-job.gbrjob'), bytes: Buffer.byteLength(contents.job) },
      { artifact: 'drill', path: path.posix.join('gerbers', 'demo-PTH.drl'), bytes: Buffer.byteLength(contents.drill) },
      { artifact: 'outline.dxf', path: path.posix.join('outline.dxf', 'demo-Edge_Cuts.dxf'), bytes: Buffer.byteLength(contents.dxf) },
      { artifact: 'board.step', path: 'board.step', bytes: Buffer.byteLength(contents.step) },
      { artifact: 'board.svg', path: 'board.svg', bytes: Buffer.byteLength(contents.svg) },
      { artifact: 'schematic.svg', path: path.posix.join('renders', 'demo.svg'), bytes: Buffer.byteLength(contents.svg) },
    ];
    expect(result.files).toHaveLength(expected.length);
    expect(result.files).toEqual(expect.arrayContaining(expected));
    await expectActualFiles(result);
  });

  it('inventories all schematic pages and board SVG files while preserving nested directories', async () => {
    mockExports(async (args) => {
      if (args[2] !== 'svg') return emitDefault(args);
      const out = outputPath(args);
      if (args[0] === 'pcb') {
        await put(path.join(out, 'demo-F_Cu.svg'), contents.svg);
        await put(path.join(out, 'demo-B_Cu.svg'), contents.svg);
      } else {
        await put(path.join(out, 'demo.svg'), contents.svg);
        await put(path.join(out, 'sheets', 'power.svg'), contents.svg);
        await put(path.join(out, 'sheets', 'io.svg'), contents.svg);
      }
    });

    const result = await exportFab(pcbPath, schPath, outDir);
    expect(result.failed).toEqual([]);
    expect(result.files.filter((file) => file.artifact === 'schematic.svg').map((file) => file.path).sort()).toEqual([
      path.posix.join('renders', 'demo.svg'),
      path.posix.join('renders', 'sheets', 'io.svg'),
      path.posix.join('renders', 'sheets', 'power.svg'),
    ].sort());
    expect(result.files.filter((file) => file.artifact === 'board.svg').map((file) => file.path).sort()).toEqual([
      path.posix.join('board.svg', 'demo-B_Cu.svg'),
      path.posix.join('board.svg', 'demo-F_Cu.svg'),
    ].sort());
    await expectActualFiles(result);
  });

  it('does not claim success when commands exit zero without producing any files', async () => {
    mockExports(async () => {});
    const result = await exportFab(pcbPath, schPath, outDir);

    expect(result.produced).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.failed.map((failure) => failure.artifact)).toEqual(artifacts);
    for (const failure of result.failed) expect(failure.reason.trim().length).toBeGreaterThan(0);
    expect(execaMock).toHaveBeenCalledTimes(6);
  });

  it('rejects zero-byte files and empty output directories while continuing other jobs', async () => {
    mockExports(async (args) => {
      if (args[2] === 'step') return put(outputPath(args), '');
      if (args[2] === 'dxf') {
        await mkdir(outputPath(args), { recursive: true });
        return;
      }
      await emitDefault(args);
    });

    const result = await exportFab(pcbPath, schPath, outDir);
    expect(result.produced).toEqual(['gerbers', 'drill', 'board.svg', 'schematic.svg']);
    expect(result.failed.map((failure) => failure.artifact)).toEqual(['outline.dxf', 'board.step']);
    expect(result.files.some((file) => ['outline.dxf', 'board.step'].includes(file.artifact))).toBe(false);
    await expectActualFiles(result);
  });

  it('requires the artifact format rather than accepting an unrelated nonempty file', async () => {
    mockExports(async (args) => {
      if (args[2] === 'dxf') return put(path.join(outputPath(args), 'export.log'), 'No DXF was generated.\n');
      await emitDefault(args);
    });

    const result = await exportFab(pcbPath, schPath, outDir);
    expect(result.produced).not.toContain('outline.dxf');
    expect(result.failed.map((failure) => failure.artifact)).toEqual(['outline.dxf']);
    expect(result.files.some((file) => file.artifact === 'outline.dxf')).toBe(false);
    await expectActualFiles(result);
  });

  it('does not let files from a previous successful export mask a later zero-output run', async () => {
    const first = await exportFab(pcbPath, schPath, outDir);
    expect(first.produced).toEqual(artifacts);
    const previousStep = await readFile(path.join(outDir, 'board.step'), 'utf8');
    mockExports(async () => {});

    const second = await exportFab(pcbPath, schPath, outDir);
    expect(second.produced).toEqual([]);
    expect(second.files).toEqual([]);
    expect(second.failed.map((failure) => failure.artifact)).toEqual(artifacts);
    expect(await readFile(path.join(outDir, 'board.step'), 'utf8')).toBe(previousStep);
  });

  it('does not attribute gerbers from another job to a drill command that produced nothing', async () => {
    mockExports(async (args) => {
      if (args[2] !== 'drill') await emitDefault(args);
    });

    const result = await exportFab(pcbPath, schPath, outDir);
    expect(result.produced).toContain('gerbers');
    expect(result.produced).not.toContain('drill');
    expect(result.failed.map((failure) => failure.artifact)).toEqual(['drill']);
    expect(result.files.some((file) => file.artifact === 'drill')).toBe(false);
    await expectActualFiles(result);
  });

  it('reports a failing job and excludes its partial output without aborting later exports', async () => {
    mockExports(async (args) => {
      await emitDefault(args);
      if (args[2] === 'step') return { failed: true, exitCode: 1, stdout: '', stderr: 'STEP exporter unavailable' };
    });

    const result = await exportFab(pcbPath, schPath, outDir);
    expect(result.produced).toEqual(artifacts.filter((artifact) => artifact !== 'board.step'));
    expect(result.failed).toEqual([{ artifact: 'board.step', reason: 'STEP exporter unavailable' }]);
    expect(result.files.some((file) => file.artifact === 'board.step')).toBe(false);
    await expect(lstat(path.join(outDir, 'board.step'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expectActualFiles(result);
  });

  it.each(['file', 'directory'] as const)('refuses an output %s symlink instead of reporting its target', async (kind) => {
    const target = path.join(dir, 'external');
    if (kind === 'file') await put(target, contents.step);
    else await put(path.join(target, 'demo-Edge_Cuts.dxf'), contents.dxf);
    const command = kind === 'file' ? 'step' : 'dxf';
    const artifact = kind === 'file' ? 'board.step' : 'outline.dxf';
    mockExports(async (args) => {
      if (args[2] !== command) return emitDefault(args);
      await mkdir(path.dirname(outputPath(args)), { recursive: true });
      await symlink(target, outputPath(args), kind === 'file' ? 'file' : 'dir');
    });

    const result = await exportFab(pcbPath, schPath, outDir);
    expect(result.produced).not.toContain(artifact);
    expect(result.failed.map((failure) => failure.artifact)).toEqual([artifact]);
    expect(result.files.some((file) => file.artifact === artifact)).toBe(false);
    await expectActualFiles(result);
    expect(await readFile(kind === 'file' ? target : path.join(target, 'demo-Edge_Cuts.dxf'), 'utf8')).toBe(
      kind === 'file' ? contents.step : contents.dxf,
    );
  });

  it('checks every destination before replacing files in a multi-file job', async () => {
    const prior = path.join(outDir, 'gerbers', 'demo-F_Cu.gbr');
    await put(prior, 'previous copper export');
    await mkdir(path.join(outDir, 'gerbers', 'demo-job.gbrjob'), { recursive: true });

    const result = await exportFab(pcbPath, schPath, outDir);
    expect(result.produced).not.toContain('gerbers');
    expect(result.failed.map((failure) => failure.artifact)).toEqual(['gerbers']);
    expect(await readFile(prior, 'utf8')).toBe('previous copper export');
    expect(result.files.some((file) => file.artifact === 'gerbers')).toBe(false);
    await expectActualFiles(result);
  });

  it('keeps board-only exports compatible when no schematic is supplied', async () => {
    const result = await exportFab(pcbPath, null, outDir);
    expect(result.produced).toEqual(artifacts.slice(0, -1));
    expect(result.failed).toEqual([]);
    expect(result.files.some((file) => file.artifact === 'schematic.svg')).toBe(false);
    expect(execaMock).toHaveBeenCalledTimes(5);
    await expectActualFiles(result);
  });

  it('export_outputs shows real output paths alongside legacy tags and unverified manufacturer acceptance', async () => {
    // Profile/package correctness is covered by jlc-profile.test.ts. Here only
    // exercise the reporting surface against the generic inventory contract.
    vi.spyOn(await import('../src/commands/outputs.js'), 'exportOutputsPackage').mockImplementation(
      async () => exportFab(pcbPath, schPath, outDir),
    );
    const { HANDLERS } = await import('../src/capabilities/handlers.js');
    const handler = HANDLERS.find((entry) => entry.schema.name === 'export_outputs')!;
    const ctx = {
      repoRoot: dir,
      config: { board: 'demo.kicad_pcb', schematic: 'demo.kicad_sch' },
      filesTouched: new Set<string>(),
    } as unknown as RunContext;

    const result = await handler.handler(ctx, {});
    expect(result).toMatchObject({ ok: true });
    const text = typeof result === 'string' ? result : result.text;
    expect(text).toContain(`produced: ${artifacts.join(', ')}`);
    expect(text).toContain('outputs/outline.dxf/demo-Edge_Cuts.dxf');
    expect(text).toContain('outputs/renders/demo.svg');
    expect(text).toContain('outputs/gerbers/demo-PTH.drl');
    expect(text).toMatch(/manufacturer acceptance: not verified/i);
    expect(ctx.filesTouched).toContain('outputs/');
  });
});
