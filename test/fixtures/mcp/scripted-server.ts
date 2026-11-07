/**
 * A test-only MCP server entry: the real server on the real stdio transport,
 * with copperhead_do driven by a scripted provider instead of a model. The
 * stdio progress test spawns it (`npx tsx`), so notifications travel the same
 * pipe a host reads, with no live model and no network.
 *
 * Usage: tsx test/fixtures/mcp/scripted-server.ts <repoRoot>
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from '../../../src/mcp/server.js';
import type { Provider, Turn } from '../../../src/agent/types.js';

const repoRoot = process.argv[2];
if (!repoRoot) {
  process.stderr.write('usage: scripted-server.ts <repoRoot>\n');
  process.exit(2);
}

/** One turn that declines the request: enough to start, report and end a run. */
const provider: Provider = {
  name: 'scripted',
  async chat(): Promise<Turn> {
    return {
      text: null,
      toolCalls: [{ id: 'call-1', name: 'finish', args: { outcome: 'refuse', summary: 'scripted refusal' } }],
      usage: { inputTokens: 100, outputTokens: 10 },
    };
  },
};

await createMcpServer({ repoRoot, provider }).connect(new StdioServerTransport());
