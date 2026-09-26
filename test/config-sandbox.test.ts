import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { configPath, loadConfig } from '../src/config.js';
import { SandboxError } from '../src/util/paths.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ repo: string; outside: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'copperhead-config-sandbox-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  const outside = path.join(root, 'outside');
  await mkdir(repo);
  await mkdir(outside);
  return { repo, outside };
}

async function writeConfig(repo: string, values: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  await writeFile(path.join(repo, '.copperhead/config.json'), JSON.stringify(values));
}

describe('configuration paths stay inside the repository', () => {
  it.each(['schematic', 'board', 'docs'])('rejects traversal in %s', async (field) => {
    const { repo } = await fixture();
    await writeConfig(repo, { [field]: '../outside/target' });
    await expect(loadConfig(repo)).rejects.toThrow(SandboxError);
    await expect(loadConfig(repo)).rejects.toThrow(field);
  });

  it.each(['schematic', 'board', 'docs'])('rejects absolute paths in %s', async (field) => {
    const { repo, outside } = await fixture();
    await writeConfig(repo, { [field]: path.join(outside, 'target') });
    await expect(loadConfig(repo)).rejects.toThrow(SandboxError);
    // Consumers join paths with repoRoot, so even an absolute in-repo path
    // is ambiguous and must be expressed relatively.
    await writeConfig(repo, { [field]: path.join(repo, 'target') });
    await expect(loadConfig(repo)).rejects.toThrow(/repo-relative/);
  });

  it.each(['schematic', 'board', 'docs'])('rejects symbolic-link paths in %s', async (field) => {
    const { repo, outside } = await fixture();
    await symlink(outside, path.join(repo, 'alias'), 'dir');
    await writeConfig(repo, { [field]: 'alias/new/target' });
    await expect(loadConfig(repo)).rejects.toThrow(SandboxError);
  });

  it('checks the .copperhead directory before reading its config', async () => {
    const { repo, outside } = await fixture();
    await writeFile(path.join(outside, 'config.json'), 'not JSON: must never be read');
    await symlink(outside, path.join(repo, '.copperhead'), 'dir');
    expect(() => configPath(repo)).toThrow(SandboxError);
    await expect(loadConfig(repo)).rejects.toThrow(SandboxError);
  });

  it('checks the config file itself before reading it', async () => {
    const { repo, outside } = await fixture();
    await mkdir(path.join(repo, '.copperhead'));
    await writeFile(path.join(outside, 'config.json'), 'not JSON: must never be read');
    await symlink(path.join(outside, 'config.json'), path.join(repo, '.copperhead/config.json'));
    await expect(loadConfig(repo)).rejects.toThrow(SandboxError);
  });

  it('validates the default docs path when there is no config file', async () => {
    const { repo, outside } = await fixture();
    await symlink(outside, path.join(repo, 'docs'), 'dir');
    await expect(loadConfig(repo)).rejects.toThrow(SandboxError);
  });

  it('leaves valid relative strings unchanged and permits missing artifacts', async () => {
    const { repo, outside } = await fixture();
    const paths = { schematic: './hardware/main.kicad_sch', board: 'hardware/../main.kicad_pcb', docs: 'docs/' };
    await writeConfig(repo, paths);
    await symlink(repo, path.join(outside, 'repo-alias'), 'dir');
    expect(await loadConfig(path.join(outside, 'repo-alias'))).toMatchObject(paths);
  });

  it.each([null, [], false])('rejects non-object config content: %s', async (value) => {
    const { repo } = await fixture();
    await mkdir(path.join(repo, '.copperhead'));
    await writeFile(path.join(repo, '.copperhead/config.json'), JSON.stringify(value));
    await expect(loadConfig(repo)).rejects.toThrow(/JSON object/);
  });
});
