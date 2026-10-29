import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { RunContext } from '../src/agent/context.js';
const execute = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execute }));
import { buildFirmware, firmwareBuildGap, type FirmwareToolchain } from '../src/commands/firmware-build.js';
import { availableTools } from '../src/agent/tools.js';

describe('explicit ESP-IDF build evidence (mock compiler, no live provider)', () => {
  let folder: string;
  let repo: string;
  let toolchain: FirmwareToolchain;
  beforeEach(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'copperhead-build-evidence-'));
    repo = path.join(folder, 'repo');
    await mkdir(path.join(repo, 'firmware/main'), { recursive: true });
    await mkdir(path.join(repo, 'docs'));
    await writeFile(path.join(repo, 'firmware/CMakeLists.txt'), 'project(example)\n');
    await writeFile(path.join(repo, 'firmware/main/app.c'), 'void app_main(void) {}\n');
    await writeFile(path.join(repo, 'docs/PINOUT.md'), 'GPIO4 is SDA\n');
    toolchain = { idfRoot: path.join(folder, 'sdk'), toolsRoot: path.join(folder, 'tools') };
    await mkdir(path.join(toolchain.idfRoot, 'tools'), { recursive: true });
    await mkdir(toolchain.toolsRoot);
    await writeFile(path.join(toolchain.idfRoot, 'tools/idf.py'), '# test SDK fixture\n');
    await writeFile(path.join(toolchain.idfRoot, 'export.sh'), '# test activation fixture\n');
    execute.mockReset();
    execute.mockImplementation(async (_cmd: string, _argv: string[], opts: { cwd: string; env: Record<string, string> }) => {
      const build = opts.env.COPPERHEAD_BUILD_DIRECTORY;
      expect(await readFile(path.join(opts.cwd, '../docs/PINOUT.md'), 'utf8')).toContain('SDA');
      await mkdir(path.join(build, 'bootloader'), { recursive: true });
      await mkdir(path.join(build, 'partition_table'), { recursive: true });
      for (const name of ['app.bin', 'app.elf', 'bootloader/bootloader.bin', 'partition_table/partition-table.bin']) {
        await writeFile(path.join(build, name), 'mock binary bytes: ' + name);
      }
      return { exitCode: 0, all: 'mock compiler result (not real compilation)\n', timedOut: false };
    });
  });
  afterEach(async () => { await rm(folder, { recursive: true, force: true }); });

  it('does not expose build execution by default or before OpenSpec unlock', () => {
    const ctx = { editsUnlocked: false } as RunContext;
    expect(availableTools(ctx).map(t => t.name)).not.toContain('build_firmware');
    ctx.firmwareToolchain = toolchain;
    expect(availableTools(ctx).map(t => t.name)).not.toContain('build_firmware');
    ctx.editsUnlocked = true;
    expect(availableTools(ctx).map(t => t.name)).toContain('build_firmware');
    delete ctx.firmwareToolchain;
    expect(availableTools(ctx).map(t => t.name)).not.toContain('build_firmware');
  });

  it('requires real successful execution and checks source, PINOUT, binary and SDK freshness', async () => {
    expect(await firmwareBuildGap(repo, 'docs', toolchain)).toMatch(/No current/);
    const result = await buildFirmware(repo, 'docs', toolchain);
    expect(result.ok, result.text).toBe(true);
    expect(await firmwareBuildGap(repo, 'docs', toolchain)).toBeNull();
    const [command, args, options] = execute.mock.calls[0]!;
    expect(command).toBe('bash');
    expect(args[1]).toContain('exec python "$IDF_PATH/tools/idf.py"');
    expect(args[1]).not.toMatch(/flash|install|curl/);
    expect(options.env.IDF_COMPONENT_MANAGER).toBe('0');
    expect(options.cwd).not.toBe(path.join(repo, 'firmware'));
    const receipt = JSON.parse(await readFile(path.join(repo, '.copperhead/firmware-build/receipt.json'), 'utf8'));
    await writeFile(path.join(repo, 'docs/PINOUT.md'), 'GPIO5 is SDA\n');
    expect(await firmwareBuildGap(repo, 'docs', toolchain)).toMatch(/inputs changed/);
    await writeFile(path.join(repo, 'docs/PINOUT.md'), 'GPIO4 is SDA\n');
    await writeFile(path.join(repo, 'firmware/main/app.c'), 'void app_main(void) { }\n');
    expect(await firmwareBuildGap(repo, 'docs', toolchain)).toMatch(/inputs changed/);
    await writeFile(path.join(repo, 'firmware/main/app.c'), 'void app_main(void) {}\n');
    await rm(path.join(repo, receipt.outputs[0].path));
    expect(await firmwareBuildGap(repo, 'docs', toolchain)).toMatch(/No current/);
    await writeFile(path.join(toolchain.idfRoot, 'tools/idf.py'), '# changed SDK fixture\n');
    expect(await firmwareBuildGap(repo, 'docs', toolchain)).toMatch(/different toolchain/);
  });

  it('rejects failed or zero-output builds and never claims reproducibility from one build', async () => {
    execute.mockResolvedValueOnce({ exitCode: 2, all: 'actual test diagnostic', timedOut: false });
    const failed = await buildFirmware(repo, 'docs', toolchain);
    expect(failed.ok).toBe(false);
    expect(failed.text).toContain('actual test diagnostic');
    expect(await firmwareBuildGap(repo, 'docs', toolchain)).toMatch(/failed/);
    execute.mockResolvedValueOnce({ exitCode: 0, all: '', timedOut: false });
    expect((await buildFirmware(repo, 'docs', toolchain)).ok).toBe(false);
    expect((await buildFirmware(repo, 'docs', toolchain)).text).not.toContain('identical');
    expect(await firmwareBuildGap(repo, 'docs', { ...toolchain, reproducible: true })).not.toBeNull();
  });

  it('compares two separate compile directories and rejects unequal ELF/bin bytes', async () => {
    const selected = { ...toolchain, reproducible: true };
    const good = await buildFirmware(repo, 'docs', selected);
    expect(good.ok, good.text).toBe(true);
    expect(good.text).toContain('identical ELF/bin');
    expect(execute.mock.calls[0]![2].cwd).not.toBe(execute.mock.calls[1]![2].cwd);
    const original = execute.getMockImplementation()!;
    let n = 0;
    execute.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (++n === 2) await writeFile(path.join(args[2].env.COPPERHEAD_BUILD_DIRECTORY, 'app.bin'), 'different bytes');
      return result;
    });
    expect((await buildFirmware(repo, 'docs', selected)).ok).toBe(false);
    expect(await firmwareBuildGap(repo, 'docs', selected)).toMatch(/failed/);
  });

  it('rejects source/output symlinks and forged empty evidence', async () => {
    await symlink(path.join(toolchain.idfRoot, 'tools/idf.py'), path.join(repo, 'firmware/stolen.c'));
    await expect(buildFirmware(repo, 'docs', toolchain)).rejects.toThrow(/symlink/);
    expect(execute).not.toHaveBeenCalled();
    await rm(path.join(repo, 'firmware/stolen.c'));
    await buildFirmware(repo, 'docs', toolchain);
    const filename = path.join(repo, '.copperhead/firmware-build/receipt.json');
    const receipt = JSON.parse(await readFile(filename, 'utf8'));
    const output = path.join(repo, receipt.outputs[0].path);
    await rm(output);
    await symlink(path.join(toolchain.idfRoot, 'tools/idf.py'), output);
    expect(await firmwareBuildGap(repo, 'docs', toolchain)).toMatch(/symlink/);
    receipt.outputs = [];
    await writeFile(filename, JSON.stringify(receipt));
    expect(await firmwareBuildGap(repo, 'docs', toolchain)).toMatch(/no binary/);
  });
});
