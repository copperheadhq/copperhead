import { mkdtemp, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

export const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'open-key');
export const REPORTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'reports');

/** Copy the open-key fixture into a fresh temp dir and git-init it. */
export async function tempFixtureRepo(): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-test-'));
  await cp(FIXTURE, repo, { recursive: true });
  // the target-repo convention (AC-4.3): .env and the run audit trail ignored
  await writeFile(path.join(repo, '.gitignore'), '.env\n.copperhead/runs/\n', 'utf8');
  await execa('git', ['init', '-q'], { cwd: repo });
  await execa('git', ['config', 'user.email', 'test@copperhead.local'], { cwd: repo });
  await execa('git', ['config', 'user.name', 'copperhead-test'], { cwd: repo });
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'fixture'], { cwd: repo });
  return { repo, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

/**
 * A KiCad config dir (for `KICAD_CONFIG_HOME`) whose global fp-lib-table names
 * every stock footprint library, as a configured KiCad has, so kicad-cli DRC
 * resolves stock footprints whatever this machine's own config holds.
 */
export async function seededKicadConfig(stockFootprints: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const { resolveKicadCli } = await import('../src/kicad/cli.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-kicadcfg-'));
  const version = /(\d+\.\d+)/.exec((await execa(resolveKicadCli(), ['--version'])).stdout)![1]!;
  const libs = (await readdir(stockFootprints)).filter((e) => e.endsWith('.pretty'));
  await mkdir(path.join(dir, version), { recursive: true });
  await writeFile(
    path.join(dir, version, 'fp-lib-table'),
    `(fp_lib_table\n\t(version 7)\n${libs
      .map(
        (e) =>
          `\t(lib (name "${e.slice(0, -'.pretty'.length)}")(type "KiCad")(uri "${path.join(stockFootprints, e).split(path.sep).join('/')}")(options "")(descr ""))`,
      )
      .join('\n')}\n)\n`,
    'utf8',
  );
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
