import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoScript = path.join(repoRoot, 'scripts', 'demo-simple.sh');
const packagedBrief = path.join(repoRoot, 'examples', 'simple', 'usb-c-breakout.md');

async function makeDemoFixture(docsDir: string, existingBrief?: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'copperhead-demo-simple-'));
  const demoDir = path.join(root, 'demo');
  const binDir = path.join(root, 'bin');
  const globalGitConfig = path.join(root, 'empty-git-config');
  const npmArgsPath = path.join(root, 'npm-args.json');
  await mkdir(path.join(demoDir, '.copperhead'), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(globalGitConfig, '', 'utf8');
  await writeFile(path.join(demoDir, '.gitignore'), '.copperhead/runs/\n', 'utf8');
  await writeFile(
    path.join(demoDir, '.copperhead', 'config.json'),
    JSON.stringify({ docs: docsDir, maxTurns: 100, maxRepairCycles: 5 }, null, 2) + '\n',
    'utf8',
  );

  if (existingBrief !== undefined) {
    const briefPath = path.join(demoDir, docsDir, 'BRIEF.md');
    await mkdir(path.dirname(briefPath), { recursive: true });
    await writeFile(briefPath, existingBrief, 'utf8');
  }

  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalGitConfig };
  await execa('git', ['init', '-q'], { cwd: demoDir, env: gitEnv });
  await execa('git', ['config', 'user.name', 'demo-test'], { cwd: demoDir, env: gitEnv });
  await execa('git', ['config', 'user.email', 'demo-test@example.invalid'], { cwd: demoDir, env: gitEnv });
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: demoDir, env: gitEnv });
  await execa('git', ['add', '-A'], { cwd: demoDir, env: gitEnv });
  await execa('git', ['commit', '-q', '-m', 'seed demo repository'], { cwd: demoDir, env: gitEnv });

  const npmStub = path.join(binDir, 'npm');
  await writeFile(
    npmStub,
    [
      '#!/usr/bin/env node',
      "require('node:fs').writeFileSync(process.env.COPPERHEAD_DEMO_NPM_ARGS, JSON.stringify(process.argv.slice(2)));",
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(npmStub, 0o755);

  return {
    root,
    demoDir,
    npmArgsPath,
    env: {
      ...process.env,
      COPPERHEAD_DEMO_DIR: demoDir,
      COPPERHEAD_DEMO_NPM_ARGS: npmArgsPath,
      GIT_CONFIG_GLOBAL: globalGitConfig,
      PATH: binDir + path.delimiter + (process.env.PATH ?? ''),
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe('scripts/demo-simple.sh brief handling', () => {
  it('copies the packaged brief into the configured docs directory, commits it, and passes that path to create', async () => {
    const fixture = await makeDemoFixture('product-docs/reference');
    try {
      const result = await execa('bash', [demoScript], {
        cwd: repoRoot,
        env: fixture.env,
      });
      const destination = path.join(fixture.demoDir, 'product-docs/reference/BRIEF.md');
      const sourceText = await readFile(packagedBrief, 'utf8');
      const committedText = await execa('git', ['show', 'HEAD:product-docs/reference/BRIEF.md'], {
        cwd: fixture.demoDir,
        env: fixture.env,
        stripFinalNewline: false,
      });
      const npmArgs = JSON.parse(await readFile(fixture.npmArgsPath, 'utf8')) as string[];

      expect(result.stdout).toContain('copied external brief to product-docs/reference/BRIEF.md');
      expect(await readFile(destination, 'utf8')).toBe(sourceText);
      expect(committedText.stdout).toBe(sourceText);
      expect(npmArgs).toEqual([
        'run',
        'dev',
        '--',
        '--repo',
        fixture.demoDir,
        'create',
        '--brief',
        destination,
      ]);
      expect((await execa('git', ['status', '--porcelain'], { cwd: fixture.demoDir, env: fixture.env })).stdout).toBe('');
    } finally {
      await fixture.cleanup();
    }
  });

  it('reuses an identical existing brief without creating a duplicate brief commit', async () => {
    const sourceText = await readFile(packagedBrief, 'utf8');
    const fixture = await makeDemoFixture('docs', sourceText);
    try {
      const result = await execa('bash', [demoScript], {
        cwd: repoRoot,
        env: fixture.env,
      });
      const log = await execa('git', ['log', '--format=%s'], { cwd: fixture.demoDir, env: fixture.env });
      const npmArgs = JSON.parse(await readFile(fixture.npmArgsPath, 'utf8')) as string[];

      expect(result.stdout).not.toContain('copied external brief to docs/BRIEF.md');
      expect(log.stdout).not.toContain('demo: add product brief');
      expect(npmArgs).toContain(path.join(fixture.demoDir, 'docs/BRIEF.md'));
    } finally {
      await fixture.cleanup();
    }
  });

  it('refuses to overwrite a different existing brief and does not start create', async () => {
    const fixture = await makeDemoFixture('docs', '# Preserve this demo brief\n');
    try {
      const result = await execa('bash', [demoScript], {
        cwd: repoRoot,
        env: fixture.env,
        reject: false,
      });
      const savedText = await readFile(path.join(fixture.demoDir, 'docs/BRIEF.md'), 'utf8');

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('refusing to overwrite docs/BRIEF.md with different brief content');
      expect(savedText).toBe('# Preserve this demo brief\n');
      await expect(readFile(fixture.npmArgsPath, 'utf8')).rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });
});
