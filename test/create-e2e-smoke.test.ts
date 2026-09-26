/** Synthetic harness regressions. None of these fixtures is a recorded live run. */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { link, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectArtifacts, inspectRawReport, inspectStageEvidence, kicadCheckArgs, main, runBounded, sandboxPath, STAGE_NAMES, type EvidenceWindow } from '../scripts/create-e2e-smoke.js';

const exec = promisify(execFile);
const temporary: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-smoke-unit-'));
  temporary.push(dir);
  return dir;
}
async function put(repo: string, relative: string, content: string): Promise<void> {
  const file = path.join(repo, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function stageFixture() {
  const repo = await temp();
  const git = async (...args: string[]) => (await exec('git', args, { cwd: repo })).stdout.trim();
  await git('-c', 'init.templateDir=', 'init', '-q');
  await git('config', 'user.name', 'Synthetic smoke test');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  await git('commit', '--allow-empty', '-qm', 'synthetic baseline');
  const initialHead = await git('rev-parse', 'HEAD');
  const start = Date.now();
  const transcripts: string[] = [];
  for (const [index, name] of STAGE_NAMES.entries()) {
    await git('commit', '--allow-empty', '-qm', `copperhead: create pipeline stage: ${name}`);
    const commit = await git('rev-parse', 'HEAD');
    const relative = `.copperhead/runs/synthetic-${index}/transcript.jsonl`;
    const events = [
      { ts: new Date(start + index * 10).toISOString(), type: 'run-start', data: { command: 'create', stage: { name, index: index + 1, total: 8 }, brief: { sha256: 'synthetic-brief' } } },
      { ts: new Date(start + index * 10 + 1).toISOString(), type: 'run-committed', data: { commit, files: ['synthetic-file'] } },
      { ts: new Date(start + index * 10 + 2).toISOString(), type: 'run-end', data: { exitPath: 'done' } },
    ];
    await put(repo, relative, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    transcripts.push(relative);
  }
  await put(repo, '.copperhead/runs/report.json', JSON.stringify({ generatedAtMs: start + 90, stageCount: 8, stages: STAGE_NAMES.map((name) => ({ name, resumed: false })) }));
  const window: EvidenceWindow = { initialHead, briefSha256: 'synthetic-brief', startedAtMs: start, endedAtMs: start + 100, process: { exitCode: 0, signal: null, timedOut: false, aborted: false } };
  return { repo, window, transcripts, git };
}

async function artifactFixture(): Promise<string> {
  const repo = await temp();
  await put(repo, '.copperhead/config.json', JSON.stringify({ schematic: 'hardware/design.kicad_sch', board: 'hardware/design.kicad_pcb', docs: 'design-docs' }));
  await put(repo, 'hardware/design.kicad_sch', '(kicad_sch (lib_symbols (symbol "Device:R")) (symbol (lib_id "Device:R") (uuid "synthetic") (at 1 2) (property "Reference" "R1")))');
  await put(repo, 'hardware/design.kicad_pcb', '(kicad_pcb (footprint "Resistor_SMD:R_0603" (at 1 2) (property "Reference" "R1") (pad "1" smd rect)))');
  for (const name of ['SPEC', 'SUBSYSTEMS', 'BOM', 'PINOUT', 'LAYOUT', 'DEVPLAN']) await put(repo, `design-docs/${name}.md`, `# ${name}\nExplicitly synthetic test content.\n`);
  for (const file of ['layer.gbr', 'holes.drl', 'outline.dxf', 'board.step', 'render.svg', 'BOM.csv']) await put(repo, `outputs/${file}`, 'synthetic placeholder; not a real fabrication export');
  await put(repo, 'firmware/main.c', '/* synthetic */ int main(void) { return 0; }');
  await put(repo, 'firmware/pins.h', '#define SYNTHETIC_PIN 1');
  return repo;
}

describe('live smoke opt-in and process lifetime (no model)', () => {
  it('does nothing without explicit opt-in even when a model is named', async () => {
    const root = await temp();
    const output = path.join(root, 'must-not-exist');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['--model', 'codex', '--output-dir', output], {})).toBe(0);
    expect(existsSync(output)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('SKIPPED'));
  });

  it.each(['0', '-1', 'NaN', 'Infinity', '86400001'])('refuses invalid timeout %s before creating a sandbox', async (timeout) => {
    const root = await temp();
    const output = path.join(root, 'must-not-exist');
    await expect(main(['--model', 'codex', '--timeout-ms', timeout, '--output-dir', output], { COPPERHEAD_LIVE_CREATE: '1' })).rejects.toThrow('timeout');
    expect(existsSync(output)).toBe(false);
  });

  it('requires an explicit model before starting a live process', async () => {
    await expect(main([], { COPPERHEAD_LIVE_CREATE: '1' })).rejects.toThrow('--model is required');
  });

  it.skipIf(process.platform === 'win32')('kills a wedged parent and its SIGTERM-ignoring grandchild, preserving raw logs', async () => {
    const repo = await temp();
    const childScript = path.join(repo, 'grandchild.cjs');
    const marker = path.join(repo, 'leaked');
    await writeFile(childScript, `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync('ready', 'yes'); setTimeout(() => fs.writeFileSync('leaked', 'should not happen'), 2500); setInterval(() => {}, 100);`);
    const script = path.join(repo, 'parent.cjs');
    await writeFile(script, `const { spawn } = require('node:child_process'); console.log('synthetic wedged process'); spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: 'inherit' }); setInterval(() => {}, 100);`);
    const prefix = path.join(repo, 'wedge');
    const result = await runBounded(process.execPath, [script], { cwd: repo, logPrefix: prefix, timeoutMs: 1000, killGraceMs: 50 });
    expect(existsSync(path.join(repo, 'ready'))).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(`${prefix}.stdout.log`, 'utf8')).toContain('synthetic wedged process');
    await new Promise((resolve) => setTimeout(resolve, 1900));
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('preserves nonzero exits and does not report them as timeouts', async () => {
    const repo = await temp();
    const result = await runBounded(process.execPath, ['-e', 'console.error("synthetic rejection"); process.exit(3)'], { cwd: repo, logPrefix: path.join(repo, 'reject'), timeoutMs: 2000, killGraceMs: 0 });
    expect(result).toMatchObject({ exitCode: 3, timedOut: false, aborted: false });
    expect(await readFile(path.join(repo, 'reject.stderr.log'), 'utf8')).toContain('synthetic rejection');
  });

  it.skipIf(process.platform === 'win32')('passes the selected KiCad binary and explicit parity arguments to a real child process', async () => {
    const repo = await temp();
    const probe = path.join(repo, 'probe.cjs');
    await writeFile(probe, 'console.log(JSON.stringify({ kicad: process.env.COPPERHEAD_KICAD_CLI, args: process.argv.slice(2), cwd: process.cwd(), gitDir: process.env.GIT_DIR }))');
    const selected = '/synthetic tool path/kicad-cli';
    const args = kicadCheckArgs('drc', '/synthetic/design.kicad_pcb', '/synthetic/drc.json');
    const result = await runBounded(process.execPath, [probe, ...args], {
      cwd: repo, logPrefix: path.join(repo, 'environment'), timeoutMs: 2000, killGraceMs: 0,
      env: { ...process.env, COPPERHEAD_KICAD_CLI: selected, GIT_DIR: '/must-not-inherit' },
    });
    expect(result.exitCode).toBe(0);
    const observed = JSON.parse(await readFile(path.join(repo, 'environment.stdout.log'), 'utf8'));
    expect(observed).toMatchObject({ kicad: selected, cwd: await realpath(repo) });
    expect(observed.gitDir).toBeUndefined();
    expect(observed.args).toEqual(['pcb', 'drc', '--format', 'json', '--exit-code-violations', '--schematic-parity', '--output', '/synthetic/drc.json', '/synthetic/design.kicad_pcb']);
    expect(kicadCheckArgs('erc', '/synthetic/design.kicad_sch', '/synthetic/erc.json')).not.toContain('--schematic-parity');
  });
});

describe('synthetic stage evidence regression fixtures', () => {
  it('matches eight terminal stage events to reachable, ordered Git commits', async () => {
    const { repo, window, git } = await stageFixture();
    await git('commit', '--allow-empty', '-qm', 'copperhead: archive change synthetic');
    expect((await inspectStageEvidence(repo, window)).map((stage) => stage.name)).toEqual(STAGE_NAMES);
  });

  it('rejects a missing devplan transcript even if stageCount and all eight report rows claim success', async () => {
    const { repo, window, transcripts } = await stageFixture();
    await rm(path.dirname(path.join(repo, transcripts[7]!)), { recursive: true });
    await expect(inspectStageEvidence(repo, window)).rejects.toThrow('missing terminal evidence for devplan');
  });

  it.each(['refused', 'provider-error', 'stalled'])('rejects last-stage %s even if the CLI and report claim success', async (exitPath) => {
    const { repo, window, transcripts } = await stageFixture();
    const file = path.join(repo, transcripts[7]!);
    await writeFile(file, (await readFile(file, 'utf8')).replace('"exitPath":"done"', `"exitPath":"${exitPath}"`));
    await expect(inspectStageEvidence(repo, window)).rejects.toThrow('devplan did not finish done');
  });

  it('rejects done without a committed event (including dry-run style false greens)', async () => {
    const { repo, window, transcripts } = await stageFixture();
    const file = path.join(repo, transcripts[7]!);
    await writeFile(file, (await readFile(file, 'utf8')).split('\n').filter((line) => !line.includes('run-committed')).join('\n'));
    await expect(inspectStageEvidence(repo, window)).rejects.toThrow('missing unique committed event');
  });

  it('rejects stale brief evidence and commits removed from HEAD', async () => {
    const { repo, window, git } = await stageFixture();
    await expect(inspectStageEvidence(repo, { ...window, briefSha256: 'other brief' })).rejects.toThrow('stale or unrelated');
    await git('reset', '--hard', window.initialHead);
    await expect(inspectStageEvidence(repo, window)).rejects.toThrow();
  });

  it('rejects a failed or timed-out CLI before inspecting claimed artifacts', async () => {
    const repo = await temp();
    const window: EvidenceWindow = { initialHead: '', briefSha256: '', startedAtMs: 1, endedAtMs: 2, process: { exitCode: 0, signal: null, timedOut: true, aborted: false } };
    await expect(inspectStageEvidence(repo, window)).rejects.toThrow('deadline');
  });
});

describe('synthetic artifact and report checks', () => {
  it('reads configured paths and counts instances, not library definitions', async () => {
    const repo = await artifactFixture();
    expect(await inspectArtifacts(repo)).toMatchObject({ schematic: 'hardware/design.kicad_sch', symbolCount: 1, footprintCount: 1 });
  });

  it('rejects empty designs with an embedded symbol library and text mentioning a footprint', async () => {
    const repo = await artifactFixture();
    await put(repo, 'hardware/design.kicad_sch', '(kicad_sch (lib_symbols (symbol "Device:R")))');
    await put(repo, 'hardware/design.kicad_pcb', '(kicad_pcb (gr_text "(footprint pretend)"))');
    await expect(inspectArtifacts(repo)).rejects.toThrow('empty design');
  });

  it('rejects missing and heading-only DEVPLAN documents', async () => {
    const repo = await artifactFixture();
    await put(repo, 'design-docs/DEVPLAN.md', '# Bring-up\n<!-- TODO: write me -->\n');
    await expect(inspectArtifacts(repo)).rejects.toThrow('DEVPLAN');
    await rm(path.join(repo, 'design-docs/DEVPLAN.md'));
    await expect(inspectArtifacts(repo)).rejects.toThrow();
  });

  it('rejects missing exports and empty firmware source', async () => {
    const repo = await artifactFixture();
    await put(repo, 'outputs/holes.drl', '');
    await expect(inspectArtifacts(repo)).rejects.toThrow('drill');
    await put(repo, 'outputs/holes.drl', 'synthetic drill');
    await put(repo, 'firmware/main.c', '');
    await expect(inspectArtifacts(repo)).rejects.toThrow('firmware source');
  });

  it('refuses external config paths and symlink artifacts without reading their target', async () => {
    const repo = await temp();
    const outside = await temp();
    await put(outside, 'private.txt', 'synthetic outside sentinel');
    await symlink(path.join(outside, 'private.txt'), path.join(repo, 'link'));
    await expect(sandboxPath(repo, '../outside')).rejects.toThrow('escapes');
    await expect(sandboxPath(repo, path.join(outside, 'private.txt'))).rejects.toThrow('repo-relative');
    await expect(sandboxPath(repo, 'link')).rejects.toThrow('symlink');
    await link(path.join(outside, 'private.txt'), path.join(repo, 'hard-link'));
    await expect(sandboxPath(repo, 'hard-link')).rejects.toThrow('hard link');
  });

  const common = { source: 'design.kicad_sch', kicad_version: 'synthetic', included_severities: ['error', 'warning'] };
  it('requires complete, clean raw reports for the configured file', () => {
    expect(() => inspectRawReport({ ...common, sheets: [{ violations: [] }] }, 'erc', 'hardware/design.kicad_sch')).not.toThrow();
    expect(() => inspectRawReport({ ...common, source: 'design.kicad_pcb', violations: [], unconnected_items: [], schematic_parity: [] }, 'drc', 'design.kicad_pcb')).not.toThrow();
    for (const raw of [{}, { ...common, sheets: [] }, { ...common, sheets: [{}] }, { ...common, sheets: [{ violations: [{ severity: 'warning' }] }] }]) {
      expect(() => inspectRawReport(raw, 'erc', 'design.kicad_sch')).toThrow();
    }
    expect(() => inspectRawReport({ ...common, sheets: [{ violations: [] }] }, 'erc', 'other.kicad_sch')).toThrow('source');
    expect(() => inspectRawReport({ ...common, source: 'design.kicad_pcb', violations: [], unconnected_items: [] }, 'drc', 'design.kicad_pcb')).toThrow('incomplete');
    expect(() => inspectRawReport({ ...common, source: 'design.kicad_pcb', violations: [], unconnected_items: [], schematic_parity: [{ severity: 'error', type: 'missing_footprint' }] }, 'drc', 'design.kicad_pcb')).toThrow('violations');
  });
});
