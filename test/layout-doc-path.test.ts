import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { STAGES, layoutDocGap } from '../src/commands/create.js';
import { HANDLERS } from '../src/capabilities/handlers.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import type { RunContext } from '../src/agent/context.js';

const layout = STAGES.find((s) => s.name === 'layout-draft')!;
const finish = HANDLERS.find((h) => h.schema.name === 'finish')!;

describe('the layout document path is named everywhere the gate reads it (#310)', () => {
  it('the stage prompt names the configured path and rules out the repo root', () => {
    const prompt = layout.prompt('brief', 'docs/');
    expect(prompt).toContain('"## Draft quality" section in docs/LAYOUT.md');
    expect(prompt).toContain('including the repository root, is not read');
    expect(layout.prompt('brief', 'design/notes')).toContain('section in design/notes/LAYOUT.md');
    // a root docs dir: the root file IS the document, so no warning against it
    const root = layout.prompt('brief', '.');
    expect(root).toContain('section in LAYOUT.md (at the repository root)');
    expect(root).not.toContain('is not read');
  });

  it('the stage prompt says edit_file is the tool for tracks, zones and reference text', () => {
    const prompt = layout.prompt('brief', 'docs/');
    expect(prompt).toMatch(/Everything else on the board is an anchored edit_file .* tracks, vias, zones, the outline, and the \(at …\) inside a part's Reference or Value property \(the label's own position, not the footprint's\)/);
  });

  it('the failure text names the path, and the stray root LAYOUT.md when that is the cause', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ch-layout-doc-'));
    try {
      const section = '# Layout\n\n## Draft quality\n\nPower routed.\n';
      expect(await layoutDocGap(root, 'docs/')).toBe('docs/LAYOUT.md has no "## Draft quality" section');

      await writeFile(path.join(root, 'LAYOUT.md'), section, 'utf8');
      const gap = await layoutDocGap(root, 'docs/');
      expect(gap).toContain('docs/LAYOUT.md has no "## Draft quality" section');
      expect(gap).toContain('the section was written to LAYOUT.md at the repository root');

      await mkdir(path.join(root, 'docs'), { recursive: true });
      await writeFile(path.join(root, 'docs', 'LAYOUT.md'), section, 'utf8');
      expect(await layoutDocGap(root, 'docs/')).toBeNull();

      // a docs dir at the root is the one case where the root file IS the layout doc
      expect(await layoutDocGap(root, '.')).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('finish consults the stage contract before approving (#310)', () => {
  const ctx = (stageGate?: () => Promise<string | null>) =>
    ({
      filesTouched: new Set<string>(),
      ledger: new ObligationsLedger(),
      lastErc: null,
      lastDrc: null,
      finishRequest: null,
      ...(stageGate ? { stageGate } : {}),
    }) as unknown as RunContext;

  it('refuses while the contract names a gap, and says what the gap is', async () => {
    const c = ctx(async () => 'the layout-draft contract is not met: docs/LAYOUT.md has no "## Draft quality" section');
    const out = await finish.handler(c, { outcome: 'done', summary: 's' });
    expect(out).toContain('cannot finish yet');
    expect(out).toContain('docs/LAYOUT.md has no "## Draft quality" section');
    expect(c.finishRequest).toBeNull();
  });

  it('approves when the contract is met', async () => {
    const c = ctx(async () => null);
    expect(await finish.handler(c, { outcome: 'done', summary: 's' })).toBe('all gates satisfied; run will commit');
    expect(c.finishRequest).toEqual({ outcome: 'done', summary: 's' });
  });

  it('treats a contract check that throws as unmet, never as met', async () => {
    const c = ctx(async () => {
      throw new Error('kicad-cli crashed');
    });
    const out = await finish.handler(c, { outcome: 'done', summary: 's' });
    expect(out).toContain('the stage contract could not be checked: kicad-cli crashed');
    expect(c.finishRequest).toBeNull();
  });

  it('does not run the contract for a refusal', async () => {
    let called = false;
    const c = ctx(async () => {
      called = true;
      return 'gap';
    });
    await finish.handler(c, { outcome: 'refuse', summary: 'budget' });
    expect(called).toBe(false);
  });
});
