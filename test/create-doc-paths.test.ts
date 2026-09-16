import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { STAGES } from '../src/commands/create.js';
import { buildSystemPrompt } from '../src/agent/prompts.js';
import { loadConfig, docPath, DEFAULTS } from '../src/config.js';

/**
 * Every design-doc path put in front of the agent must resolve through
 * `config.docs`, because that is what the stage completion contracts check.
 * When the two disagree the agent writes a valid document where nothing looks
 * for it: the stage cannot recognize its own output and retries until the
 * pipeline stalls (issue #310).
 */

const DOC_NAMES = ['SPEC.md', 'SUBSYSTEMS.md', 'BOM.md', 'PINOUT.md', 'LAYOUT.md', 'DEVPLAN.md'];

async function tempRepo(docs: string): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-docpath-'));
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  await mkdir(path.join(repo, docs), { recursive: true });
  await mkdir(path.join(repo, 'hardware'), { recursive: true });
  await writeFile(
    path.join(repo, 'hardware', 'board.kicad_pcb'),
    '(kicad_pcb (footprint "Resistor_SMD:R_0603_1608Metric"))',
  );
  await writeFile(
    path.join(repo, '.copperhead', 'config.json'),
    JSON.stringify({ docs, schematic: 'hardware/board.kicad_sch', board: 'hardware/board.kicad_pcb' }),
  );
  return { repo, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

const LAYOUT_DOC = '# Layout intent\n\n## Draft quality\n\nConnectors on the edge; power routed, the rest left as ratsnest.\n';
const SPEC_DOC = '# Spec\n\n## Budgets\n\n- sleep current: 30 uA\n';

describe('create: doc paths named to the agent resolve through config.docs (#310)', () => {
  for (const docs of [DEFAULTS.docs, 'documentation/']) {
    it(`no stage prompt names a design doc outside "${docs}"`, () => {
      for (const stage of STAGES) {
        const prompt = stage.prompt('a usb-c breakout board', docs);
        for (const name of DOC_NAMES) {
          const mention = new RegExp('[^\\s(]*' + name.replace('.', '\\.'), 'g');
          for (const at of [...prompt.matchAll(mention)]) {
            expect(at[0], `${stage.name} names ${at[0]}`).toBe(docPath(docs, name));
          }
        }
      }
    });
  }

  it('stage 5 sends the layout document where the stage 5 contract reads it', async () => {
    const { repo, cleanup } = await tempRepo(DEFAULTS.docs);
    try {
      const stage = STAGES.find((s) => s.name === 'layout-draft')!;
      const named = docPath(DEFAULTS.docs, 'LAYOUT.md');
      expect(stage.prompt('', DEFAULTS.docs)).toContain(named);

      // The bare-name regression: a document at the repo root is not the contract's.
      await writeFile(path.join(repo, 'LAYOUT.md'), LAYOUT_DOC);
      expect(await stage.isComplete(repo, DEFAULTS.docs)).toBe(false);

      await writeFile(path.join(repo, named), LAYOUT_DOC);
      expect(await stage.isComplete(repo, DEFAULTS.docs)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('stage 1 follows a custom docs directory instead of the literal docs/', async () => {
    const docs = 'documentation/';
    const { repo, cleanup } = await tempRepo(docs);
    try {
      const stage = STAGES.find((s) => s.name === 'spec-seed')!;
      expect(stage.prompt('a usb-c breakout board', docs)).toContain(docPath(docs, 'SPEC.md'));

      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs', 'SPEC.md'), SPEC_DOC);
      expect(await stage.isComplete(repo, docs)).toBe(false);

      await writeFile(path.join(repo, docs, 'SPEC.md'), SPEC_DOC);
      expect(await stage.isComplete(repo, docs)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('system-prompt doc headings carry the configured directory', async () => {
    const docs = 'documentation/';
    const { repo, cleanup } = await tempRepo(docs);
    try {
      await writeFile(path.join(repo, docs, 'SPEC.md'), SPEC_DOC);
      const system = await buildSystemPrompt(repo, await loadConfig(repo), {});
      expect(system).toContain(`## ${docPath(docs, 'SPEC.md')}`);
      expect(system).not.toContain('## docs/SPEC.md');
    } finally {
      await cleanup();
    }
  });
});
