import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setColorEnabled } from '../src/agent/theme.js';
import {
  formatConfigInspect,
  formatConstraintsInspect,
  formatLastInspect,
  formatNetsInspect,
  formatPartsInspect,
  formatRunsInspect,
} from '../src/commands/repl-inspect.js';
import { tempFixtureRepo } from './helpers.js';

describe('repl inspect formatters', () => {
  let root: string;

  beforeAll(async () => {
    setColorEnabled(false);
    root = await mkdtemp(path.join(tmpdir(), 'copperhead-repl-inspect-'));
    await mkdir(path.join(root, '.copperhead', 'runs', '20260101T120000Z'), { recursive: true });
    await writeFile(
      path.join(root, '.copperhead', 'config.json'),
      JSON.stringify({ schematic: 'hw/board.kicad_sch', docs: 'docs/', maxTurns: 12 }, null, 2),
    );
    await writeFile(
      path.join(root, '.copperhead', 'constraints.json'),
      JSON.stringify(
        {
          '3v3.max_current_ma': {
            max: 500,
            source: 'BRIEF.md',
            affects: ['schematic', 'bom'],
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(root, '.copperhead', 'runs', '20260101T120000Z', 'summary.md'),
      '## Run stats\n\n- **Exit path:** `done`\n',
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('formats resolved config', async () => {
    const text = await formatConfigInspect(root);
    expect(text).toContain('Config');
    expect(text).toContain('hw/board.kicad_sch');
    expect(text).toContain('12');
    expect(text).toContain('packs');
  });

  it('formats constraints registry', async () => {
    const text = await formatConstraintsInspect(root);
    expect(text).toContain('3v3.max_current_ma');
    expect(text).toContain('max 500');
  });

  it('lists recent runs with exit path', async () => {
    const text = await formatRunsInspect(root);
    expect(text).toContain('20260101T120000Z');
    expect(text).toContain('done');
  });
});

describe('repl board inspect (open-key fixture)', () => {
  let repo: string;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    setColorEnabled(false);
    ({ repo, cleanup } = await tempFixtureRepo());
    await mkdir(path.join(repo, '.copperhead'), { recursive: true });
    await writeFile(
      path.join(repo, '.copperhead', 'config.json'),
      JSON.stringify({ schematic: 'hardware/open-key.kicad_sch', board: 'hardware/open-key.kicad_pcb', docs: 'docs/' }),
    );
  });

  afterAll(async () => {
    await cleanup();
  });

  it('lists parts from schematic', async () => {
    const text = await formatPartsInspect(repo);
    expect(text).toContain('R1');
    expect(text).toContain('10k');
    expect(text).toContain('U1');
  });

  it('lists nets and attachments', async () => {
    const text = await formatNetsInspect(repo);
    expect(text).toContain('KEY_DAH');
    expect(text).toContain('3V3');
  });
});

describe('repl last run preview', () => {
  let root: string;

  beforeAll(async () => {
    setColorEnabled(false);
    root = await mkdtemp(path.join(tmpdir(), 'copperhead-repl-last-'));
    await mkdir(path.join(root, '.copperhead', 'runs', '20260101T120000Z'), { recursive: true });
    await writeFile(
      path.join(root, '.copperhead', 'runs', '20260101T120000Z', 'summary.md'),
      '## Run stats\n\n- **Exit path:** `done`\n',
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('previews last run summary', async () => {
    const text = await formatLastInspect(root);
    expect(text).toContain('Last run');
    expect(text).toContain('Exit path');
  });
});
