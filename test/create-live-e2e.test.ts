import { describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGES } from '../src/commands/create.js';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.env.COPPERHEAD_E2E_MODE;
const enabled = mode === 'live' || mode === 'replay';
const timeoutMs = 8 * 60 * 60 * 1000;

// No mocks: executes the built CLI, real provider/cache, Git, OpenSpec and KiCad.
// The operator supplies an isolated target, never the Copperhead source checkout.
describe.skipIf(!enabled)('create real CLI acceptance', () => {
  it('reaches all eight committed stages and exits zero', async () => {
    const target = process.env.COPPERHEAD_E2E_REPO;
    const model = process.env.COPPERHEAD_E2E_MODEL;
    if (!target || !path.isAbsolute(target) || !model) {
      throw new Error('Set absolute COPPERHEAD_E2E_REPO and explicit COPPERHEAD_E2E_MODEL');
    }
    const repo = path.resolve(target);
    if (repo.toLowerCase() === sourceRoot.toLowerCase()) throw new Error('Use an isolated hardware repository, not the source checkout');
    const brief = path.join(repo, 'brief.md');
    expect(await readFile(brief, 'utf8')).toBe(await readFile(path.join(sourceRoot, 'examples/medium/esp32-soil-sensor.md'), 'utf8'));
    const result = await execa(process.execPath, [path.join(sourceRoot, 'dist/cli.js'), '--repo', repo, '--plain', 'create', '--brief', brief, '--model', model], {
      cwd: sourceRoot,
      env: { COPPERHEAD_CACHE_ONLY: mode === 'replay' ? '1' : '0', OPENSPEC_TELEMETRY: '0' },
      reject: false,
      timeout: timeoutMs - 60_000,
      stdout: ['pipe', 'inherit'],
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('create pipeline complete; all checks green');
    const runs = path.join(repo, '.copperhead/runs');
    const report = JSON.parse(await readFile(path.join(runs, 'report.json'), 'utf8'));
    expect(report.stages.map((s: { name: string }) => s.name)).toEqual(STAGES.map((s) => s.name));
    if (mode === 'replay') {
      // Resuming a finished board is not a replay of its creation.
      expect(report.resumed).toBe(0);
      expect(report.ran).toBe(8);
      for (const stage of report.stages) {
        expect(stage.turns).toBeGreaterThan(0);
        expect(stage.cacheHits).toBe(stage.turns);
        expect(stage.tokensIn).toBe(0);
        expect(stage.tokensOut).toBe(0);
      }
    }
    const proven = new Set<string>();
    for (const dir of await readdir(runs, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      let text: string;
      try { text = await readFile(path.join(runs, dir.name, 'transcript.jsonl'), 'utf8'); } catch { continue; }
      const events = text.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      const stage = events.find((event) => event.type === 'run-start')?.data?.stage?.name;
      const commit = events.find((event) => event.type === 'run-committed')?.data?.commit;
      const done = events.find((event) => event.type === 'run-end')?.data?.exitPath === 'done';
      if (!stage || !commit || !done) continue;
      expect((await execa('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: repo, reject: false })).exitCode).toBe(0);
      const subject = (await execa('git', ['show', '-s', '--format=%s', commit], { cwd: repo })).stdout;
      expect(subject).toContain(`create pipeline stage: ${stage}`);
      proven.add(stage);
    }
    expect([...proven].sort()).toEqual(STAGES.map((s) => s.name).sort());
    expect((await execa('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repo })).stdout).toBe('');
  }, timeoutMs);
});
