import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { STAGES } from '../src/commands/create.js';
import { scaffoldDemoRepo } from '../src/commands/demo.js';
import { bootstrapKicadProject } from '../src/kicad/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { redactSecrets } from '../src/util/redact.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stages = ['spec-seed', 'architecture', 'part-selection', 'schematic', 'layout-draft', 'outputs', 'firmware', 'devplan'];

function assertFullRun(report: { stages: { name: string; resumed: boolean }[] }, subjects: string): void {
  expect(report.stages.map((s) => s.name)).toEqual(stages);
  expect(report.stages.every((s) => !s.resumed)).toBe(true);
  for (const stage of stages) {
    expect(subjects.split('\n').filter((s) => s === `copperhead: create pipeline stage: ${stage}`)).toHaveLength(1);
  }
}

describe('create end-to-end evidence assertions (#66)', () => {
  const report = { stages: stages.map((name) => ({ name, resumed: false })) };
  const subjects = stages.map((s) => `copperhead: create pipeline stage: ${s}`).join('\n');
  it('accepts eight independently committed stages', () => assertFullRun(report, subjects));
  it('rejects a wedged pipeline or a missing final stage', () => {
    expect(() => assertFullRun({ stages: report.stages.slice(0, 3) }, subjects)).toThrow();
    expect(() => assertFullRun(report, subjects.split('\n').slice(0, -1).join('\n'))).toThrow();
  });
  it('rejects resumed artifacts as evidence of a fresh full run', () => {
    expect(() => assertFullRun({ stages: report.stages.map((s) => ({ ...s, resumed: true })) }, subjects)).toThrow();
  });
  it('does not treat a zero-symbol scaffold as a completed schematic', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-empty-'));
    try {
      await scaffoldDemoRepo(repo);
      await bootstrapKicadProject(repo, '# Empty board');
      expect(await STAGES.find((s) => s.name === 'schematic')!.isComplete(repo, 'docs/')).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

// Explicit opt-in: never discover credentials or silently run a paid provider.
// The CLI inherits whatever provider configuration the operator supplies.
describe.skipIf(process.env.COPPERHEAD_TEST_CREATE !== '1')('create CLI full pipeline (#66)', () => {
  it('finishes and commits all eight stages from the USB-C brief', async () => {
    const model = process.env.COPPERHEAD_TEST_CREATE_MODEL;
    expect(model, 'set COPPERHEAD_TEST_CREATE_MODEL explicitly').toBeTruthy();
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-create-e2e-'));
    // Preserve successes AND failures, including summaries, for manual triage.
    console.log(`create smoke evidence: ${repo}`);
    await scaffoldDemoRepo(repo);
    const result = await execa(process.execPath, [
      path.join(root, 'dist/cli.js'), '--repo', repo, 'create',
      '--brief', path.join(root, 'examples/simple/usb-c-breakout.md'), '--model', model!,
    ], { cwd: root, reject: false, timeout: 3_600_000, env: { NO_COLOR: '1' }, stdin: 'ignore' });
    await writeFile(path.join(repo, '.copperhead/runs/create.log'), redactSecrets(result.all ?? `${result.stdout}\n${result.stderr}`));
    expect(result.timedOut, `pipeline wedged; evidence: ${repo}`).toBe(false);
    expect(result.exitCode, `create failed; evidence: ${repo}`).toBe(0);
    const report = JSON.parse(await readFile(path.join(repo, '.copperhead/runs/report.json'), 'utf8'));
    const { stdout: subjects } = await execa('git', ['log', '--format=%s'], { cwd: repo });
    assertFullRun(report, subjects);
    const config = await loadConfig(repo);
    // Re-run real completion contracts, including symbol count, drift, ERC,
    // board/schematic correspondence, DRC, and the final development plan.
    for (const stage of STAGES) {
      expect(await stage.isComplete(repo, config.docs), `${stage.name} false-green; evidence: ${repo}`).toBe(true);
    }
    const attempts = (await readdir(path.join(repo, '.copperhead/runs'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());
    expect(attempts.length).toBeGreaterThanOrEqual(stages.length);
    for (const entry of attempts) {
      expect(await readFile(path.join(repo, '.copperhead/runs', entry.name, 'summary.md'), 'utf8')).toContain('# Run summary');
    }
    expect((await execa('git', ['status', '--porcelain'], { cwd: repo })).stdout).toBe('');
    expect((await execa('git', ['show', `HEAD:${path.posix.join(config.docs, 'DEVPLAN.md')}`], { cwd: repo })).stdout).toMatch(/^#/m);
  }, 3_660_000);
});
