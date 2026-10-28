import { describe, it, expect } from 'vitest';
import { runAgentLoop } from '../src/agent/loop.js';
import { InteractiveRenderer } from '../src/agent/render.js';
import type { Provider, ToolCall } from '../src/agent/types.js';
import { tempFixtureRepo } from './helpers.js';

const proposal: ToolCall = {
  id: 'propose', name: 'propose_change',
  args: { id: 'prompt-test', why: 'Test approval input', what_changes: '- Test note', tasks: '- [ ] Write the note' },
};
const validate: ToolCall = { id: 'validate', name: 'validate_change', args: {} };
const finish: ToolCall = { id: 'finish', name: 'finish', args: { outcome: 'refuse', summary: 'End of scripted input check' } };

describe('proposal input owns the terminal until it resolves', () => {
  it.each(['yes', 'no', 'error'] as const)('keeps the question and cursor visible, then resumes after %s', async (answer) => {
    const { repo, cleanup } = await tempFixtureRepo();
    let written = '';
    const out = { columns: 160, write: (chunk: string) => { written += chunk; } };
    const renderer = new InteractiveRenderer(out);
    let cursorVisible = false;
    let promptUnchanged = false;
    let resumed = false;
    let promptEnd = '';
    let calls = 0;
    let editsOffered = false;
    const provider: Provider = {
      name: 'prompt-test',
      chat: async (_messages, tools) => {
        calls++;
        if (calls === 2) {
          editsOffered = tools.some((tool) => tool.name === 'write_file');
          // Resumption must precede the tool-result log: the next turnStart can
          // otherwise hide a missing resume by independently restarting the renderer.
          const afterInput = written.slice(promptEnd.length);
          const toolResult = afterInput.indexOf('validate_change');
          resumed = toolResult >= 0 && afterInput.slice(0, toolResult).includes('\x1b[?25l');
        }
        return { text: null, toolCalls: calls === 1 ? [proposal, validate] : [finish], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    try {
      await runAgentLoop({
        repoRoot: repo, request: 'Verify approval prompt', model: 'test', provider, renderer,
        interactive: true,
        confirm: async (question) => {
          cursorVisible = written.endsWith('\x1b[?25h');
          out.write(`${question} [y/N] `);
          const before = written;
          // More than two 80 ms redraw ticks: neither the question nor typed input may be erased.
          await new Promise((resolve) => setTimeout(resolve, 190));
          promptUnchanged = written === before;
          promptEnd = written;
          if (answer === 'error') throw new Error('input closed');
          return answer === 'yes';
        },
      });
      expect(calls).toBe(2);
      expect({ cursorVisible, promptUnchanged }).toEqual({ cursorVisible: true, promptUnchanged: true });
      expect(resumed).toBe(true);
      expect(editsOffered).toBe(answer === 'yes');
    } finally {
      renderer.finish('test cleanup');
      await cleanup();
    }
  });
});
