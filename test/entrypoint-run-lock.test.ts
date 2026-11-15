import { expect, it } from 'vitest';
import { tempFixtureRepo } from './helpers.js';
import { withRunLock } from '../src/util/run-lock.js';
import { runExportBom } from '../src/commands/export.js';
import { runSkillCli } from '../src/commands/skill.js';
import { scaffoldDemoRepo } from '../src/commands/demo.js';

it('locks export, skill and demo before writes, closing a rejected skill provider', async () => {
  const f = await tempFixtureRepo();
  let release!: () => void; let ready!: () => void; let closed = 0;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const acquired = new Promise<void>((resolve) => { ready = resolve; });
  const owner = withRunLock(f.repo, 'holder', async () => { ready(); await held; });
  try {
    await acquired;
    await expect(runExportBom({ repoRoot: f.repo, supplier: 'jlcpcb', boards: 1, spares: 0, includeUnverified: false })).rejects.toThrow(/in progress/);
    await expect(runSkillCli({ repoRoot: f.repo, name: 'generate-report', json: false, provider: {
      name: 'unused', chat: async () => { throw new Error('must not run'); }, close: async () => { closed++; },
    } })).rejects.toThrow(/in progress/);
    expect(closed).toBe(1);
    await expect(scaffoldDemoRepo(f.repo)).rejects.toThrow(/in progress/);
  } finally { release(); await owner; await f.cleanup(); }
});
