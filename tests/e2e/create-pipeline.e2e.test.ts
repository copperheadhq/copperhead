import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const BRIEF = join(REPO_ROOT, 'examples/simple/coin-cell-led-beacon.md');
const STAGES = [
  'spec-seed',
  'architecture',
  'part-selection',
  'schematic',
  'layout-draft',
  'outputs',
  'firmware',
  'dev-plan',
] as const;
const STAGE_TIMEOUT_MS = 600_000;

let cli: string[] = [];
let projectDir = '';

function run(args: string[]) {
  const [cmd, ...prefix] = cli;
  return spawnSync(cmd, [...prefix, ...args], {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: STAGE_TIMEOUT_MS,
    env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

function driveStage(index: number) {
  const variants =
    index === 0
      ? [
          ['create', BRIEF, '--yes'],
          ['create', BRIEF],
          ['create', '--brief', BRIEF, '--yes'],
          ['create', '--brief', BRIEF],
        ]
      : [
          ['create', '--continue', '--yes'],
          ['create', '--continue'],
          ['create', '--resume', '--yes'],
          ['create', '--resume'],
          ['create', '--stage', STAGES[index], '--yes'],
          ['create', '--stage', STAGES[index]],
        ];

  let last = run(variants[0]);
  for (const variant of variants.slice(1)) {
    if (last.status === 0) break;
    last = run(variant);
  }
  return last;
}

function commitCount() {
  const result = spawnSync('git', ['log', '--oneline'], { cwd: projectDir, encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) return 0;
  return result.stdout.trim().split('\n').length;
}

function walk(dir: string, base = dir): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '.git' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full, base));
    else files.push(relative(base, full));
  }
  return files;
}

function git(args: string[]) {
  return spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' });
}

beforeAll(() => {
  expect(existsSync(BRIEF), `missing brief fixture: ${BRIEF}`).toBe(true);

  const override = process.env.COPPERHEAD_E2E_BIN?.trim();
  if (override) {
    cli = override.split(/\s+/);
  } else {
    const distEntry = join(REPO_ROOT, 'dist/cli.js');
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    if (existsSync(distEntry)) {
      cli = [process.execPath, distEntry];
    } else if (pkg.scripts?.build) {
      const build = spawnSync('npm', ['run', 'build', '--silent'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: STAGE_TIMEOUT_MS,
      });
      if (build.status === 0 && existsSync(distEntry)) {
        cli = [process.execPath, distEntry];
      }
    }

    if (cli.length === 0) {
      const tsEntry = ['src/cli.ts', 'src/index.ts']
        .map((candidate) => join(REPO_ROOT, candidate))
        .find((candidate) => existsSync(candidate));
      if (!tsEntry) throw new Error('could not locate a copperhead CLI entrypoint');
      cli = ['npx', '--yes', 'tsx', tsEntry];
    }
  }

  projectDir = mkdtempSync(join(tmpdir(), 'copperhead-create-e2e-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'e2e@copperhead.test']);
  git(['config', 'user.name', 'Copperhead E2E']);
  writeFileSync(join(projectDir, 'README.md'), '# copperhead create e2e\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'chore: e2e baseline']);
});

afterAll(() => {
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

describe('copperhead create end-to-end', () => {
  it(
    'advances every stage from a brief to a committed final stage',
    () => {
      const baseline = commitCount();
      expect(baseline).toBe(1);

      for (let index = 0; index < STAGES.length; index += 1) {
        const stage = STAGES[index];
        const result = driveStage(index);
        const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();

        expect(result.error, `stage ${stage} could not start: ${result.error?.message}`).toBeUndefined();
        expect(result.status, `stage ${stage} exited ${result.status}\n${output}`).toBe(0);
        expect(commitCount(), `stage ${stage} did not create its own commit\n${output}`).toBe(
          baseline + index + 1,
        );
      }

      expect(commitCount()).toBe(baseline + STAGES.length);

      const files = walk(projectDir);
      expect(files.some((file) => file.endsWith('.kicad_sch')), 'no schematic artifact').toBe(true);
      expect(files.some((file) => file.endsWith('.kicad_pcb')), 'no layout artifact').toBe(true);
      expect(files.some((file) => file.endsWith('.kicad_pro')), 'no project artifact').toBe(true);
      expect(files.some((file) => file.includes('firmware')), 'no firmware artifact').toBe(true);
      expect(
        files.some((file) => file.includes('dev-plan') || file.includes('dev_plan')),
        'no dev-plan artifact',
      ).toBe(true);
    },
    STAGE_TIMEOUT_MS,
  );
});
