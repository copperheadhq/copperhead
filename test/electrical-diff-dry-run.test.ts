import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import { runAgentLoop } from '../src/agent/loop.js';
import type { Provider, ToolCall } from '../src/agent/types.js';
import { electricalFixture, SCHEMATIC } from './support/electrical-diff.js';

describe('electrical preview in the gated dry-run loop', () => {
  it('previews after verification, then restores the pre-run dirty design', async () => {
    const { repo, cleanup } = await electricalFixture();
    try {
      const file = path.join(repo, SCHEMATIC);
      const userText = (await readFile(file, 'utf8')).replaceAll('KEY_DAH', 'USER_NET');
      await writeFile(file, userText);
      const beforeHead = (await execa('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout;
      const lines: string[] = [];
      const script: { name: string; args: ToolCall['args'] }[] = [
        { name: 'propose_change', args: { id: 'rename-for-review', why: 'exercise dry-run review', what_changes: '- rename USER_NET', tasks: '- [ ] rename' } },
        { name: 'validate_change', args: {} },
        { name: 'edit_file', args: { path: SCHEMATIC, old_string: 'USER_NET', new_string: 'KEY_DASH', replace_all: true } },
        { name: 'finish', args: { outcome: 'done', summary: 'too soon' } },
        { name: 'run_erc', args: {} },
        { name: 'check_drift', args: {} },
        { name: 'finish', args: { outcome: 'done', summary: 'verified rename' } },
      ];
      let turn = 0;
      const catalogs: string[][] = [];
      const provider: Provider = {
        name: 'scripted',
        chat: async (_messages, tools) => {
          catalogs.push(tools.map((tool) => tool.name));
          expect(lines.some((line) => line.startsWith('Electrical changes since'))).toBe(false);
          const call = script[turn++];
          if (!call) throw new Error('script exhausted before verified finish');
          return { text: null, toolCalls: [{ ...call, id: String(turn) }], usage: { inputTokens: 0, outputTokens: 0 } };
        },
      };
      const result = await runAgentLoop({ repoRoot: repo, model: 'scripted', provider, request: 'rename USER_NET', dryRun: true, allowDirty: true, log: (line) => lines.push(line) });
      expect(result.outcome, result.summary + '\n' + lines.join('\n')).toBe('success');
      expect(catalogs[0]).not.toContain('edit_file');
      expect(catalogs[2]).toContain('edit_file');
      expect(lines.join('\n')).toContain('cannot finish yet');
      expect(result.electricalDiff?.nets.renamed).toEqual([{ before: 'USER_NET', after: 'KEY_DASH' }]);
      expect(lines.join('\n')).toContain('Electrical changes since pre-run snapshot');
      expect(await readFile(file, 'utf8')).toBe(userText);
      expect((await execa('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout).toBe(beforeHead);
      expect(await readFile(path.join(result.transcriptDir, 'summary.md'), 'utf8')).toContain('Renamed: USER_NET → KEY_DASH');
    } finally { await cleanup(); }
  }, 120_000);
});
