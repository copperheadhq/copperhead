import path from 'node:path';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import { tempFixtureRepo } from '../helpers.js';

export const SCHEMATIC = 'hardware/open-key.kicad_sch';

export async function commitFixture(repo: string, message = 'electrical diff baseline'): Promise<string> {
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', message], { cwd: repo });
  return (await execa('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout;
}

export async function configureFixture(repo: string, schematic = SCHEMATIC): Promise<void> {
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  await writeFile(path.join(repo, '.copperhead/config.json'), JSON.stringify({ schematic, board: null, docs: 'docs/' }));
}

export async function electricalFixture() {
  const fixture = await tempFixtureRepo();
  await configureFixture(fixture.repo);
  await commitFixture(fixture.repo);
  return fixture;
}

/** Real open-key circuit on a grandchild sheet, under two valid sheet wrappers. */
export async function hierarchicalFixture(repo: string): Promise<string> {
  const leaf = 'hardware/blocks/deep/channel.kicad_sch';
  await mkdir(path.dirname(path.join(repo, leaf)), { recursive: true });
  await cp(path.join(repo, SCHEMATIC), path.join(repo, leaf));
  const wrapper = (file: string, id: string) => `(kicad_sch
    (version 20231120) (generator "eeschema")
    (uuid "00000000-0000-4000-8000-${id}1") (paper "A4") (lib_symbols)
    (sheet (at 25.4 25.4) (size 50.8 25.4)
      (stroke (width 0) (type default)) (fill (color 0 0 0 0))
      (uuid "00000000-0000-4000-8000-${id}2")
      (property "Sheetname" "Circuit" (at 25.4 24 0) (effects (font (size 1.27 1.27))))
      (property "Sheetfile" "${file}" (at 25.4 52 0) (effects (font (size 1.27 1.27)))))
    (sheet_instances (path "/" (page "1"))))\n`;
  await writeFile(path.join(repo, SCHEMATIC), wrapper('blocks/child.kicad_sch', '00000000001'));
  await writeFile(path.join(repo, 'hardware/blocks/child.kicad_sch'), wrapper('deep/channel.kicad_sch', '00000000002'));
  return leaf;
}
