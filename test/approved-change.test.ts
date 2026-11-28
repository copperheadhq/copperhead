import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import { runAgentLoop } from '../src/agent/loop.js';
import type { Provider, Turn } from '../src/agent/types.js';
import { openspecArchive, openspecValidate } from '../src/openspec/cli.js';
import { tempFixtureRepo } from './helpers.js';

vi.mock('../src/openspec/cli.js', () => ({
  openspecValidate: vi.fn(),
  openspecArchive: vi.fn(),
}));

function scriptedProvider(turns: Turn[]): Provider {
  let index = 0;
  return {
    name: 'scripted',
    async chat() {
      const turn = turns[index++];
      if (!turn) throw new Error('approval script exhausted');
      return turn;
    },
  };
}

const call = (name: string, args: Record<string, unknown>): Turn => ({
  text: null,
  toolCalls: [{ id: name, name, args }],
  usage: { inputTokens: 10, outputTokens: 5 },
});
const proposal = (id: string): Turn => call('propose_change', {
  id, why: 'Document the approved work', what_changes: '- Update notes', tasks: '- [ ] Update notes',
});
const validate = (): Turn => call('validate_change', {});
const finish = (): Turn => call('finish', { outcome: 'done', summary: 'Documentation complete' });

beforeEach(() => {
  vi.mocked(openspecValidate).mockReset().mockResolvedValue({ ok: true, output: 'valid' });
  vi.mocked(openspecArchive).mockReset().mockImplementation(async (repo, id) => {
    // Give the real loop an archive mutation to commit, as the CLI would.
    await writeFile(path.join(repo, 'archive.txt'), id, 'utf8');
    return { ok: true, output: 'archived' };
  });
});

const scenarios = [
  { name: 'keeps approved A when replacement B is declined', firstApproved: true, replacement: 'proposal-b', secondApproved: false, expected: 'proposal-a' },
  { name: 'records n/a when the only proposal is declined', firstApproved: false, expected: null },
  { name: 'records n/a when validation fails', firstApproved: false, invalid: true, expected: null },
  { name: 'clears approval when a same-id replacement is declined', firstApproved: true, replacement: 'proposal-a', secondApproved: false, expected: null },
  { name: 'uses B after A and then B are approved', firstApproved: true, replacement: 'proposal-b', secondApproved: true, expected: 'proposal-b' },
] as const;

describe.each([false, true])('done bookkeeping (dryRun=%s)', (dryRun) => {
  it.each(scenarios)('$name', async (scenario) => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, 'openspec'), { recursive: true });
      await writeFile(path.join(repo, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs', 'NOTES.md'), 'Before approval\n');
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-qm', 'prepare approval scenario'], { cwd: repo });

      if ('invalid' in scenario) {
        vi.mocked(openspecValidate).mockResolvedValueOnce({ ok: false, output: 'invalid proposal' });
      }
      const confirm = vi.fn().mockResolvedValueOnce(scenario.firstApproved);
      const turns = [proposal('proposal-a'), validate()];
      const validatedIds = ['proposal-a'];
      if (scenario.firstApproved) {
        turns.push(call('edit_file', { path: 'docs/NOTES.md', old_string: 'Before approval', new_string: 'Approved work' }));
        turns.push(call('check_drift', {}));
      }
      if ('replacement' in scenario) {
        turns.push(proposal(scenario.replacement), validate());
        validatedIds.push(scenario.replacement);
        confirm.mockResolvedValueOnce(scenario.secondApproved);
      }
      turns.push(finish());
      const result = await runAgentLoop({
        repoRoot: repo, request: 'Update the notes', model: 'gpt-5', provider: scriptedProvider(turns),
        interactive: true, confirm, dryRun, maxTurns: turns.length, log: () => {},
      });
      expect(result.outcome).toBe('success');
      expect(result.exitPath).toBe('done');
      expect(vi.mocked(openspecValidate).mock.calls).toEqual(validatedIds.map((id) => [repo, id]));
      expect(confirm).toHaveBeenCalledTimes('invalid' in scenario ? 0 : validatedIds.length);
      if (scenario.firstApproved) expect(result.filesTouched).toContain('docs/NOTES.md');
      const summary = await readFile(path.join(result.transcriptDir, 'summary.md'), 'utf8');
      expect.soft(summary).toContain(`- **OpenSpec change:** ${scenario.expected ?? 'n/a'}\n`);
      if (!dryRun) {
        const changelog = await readFile(path.join(repo, 'docs', 'CHANGELOG.md'), 'utf8');
        expect.soft(changelog).toContain(`- Change: ${scenario.expected ?? 'n/a'}\n`);
        if (scenario.firstApproved) {
          expect(await readFile(path.join(repo, 'docs', 'NOTES.md'), 'utf8')).toBe('Approved work\n');
        }
      }
      if (dryRun || !scenario.expected) {
        expect.soft(openspecArchive).not.toHaveBeenCalled();
      } else {
        expect.soft(openspecArchive).toHaveBeenCalledExactlyOnceWith(repo, scenario.expected);
        const { stdout: subject } = await execa('git', ['log', '-1', '--format=%s'], { cwd: repo });
        expect.soft(subject).toBe(`copperhead: archive change ${scenario.expected}`);
      }
    } finally {
      await cleanup();
    }
  });
});
