import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog, defineSkill } from '../src/capabilities/index.js';
import { HANDLERS } from '../src/capabilities/handlers.js';
import { registry } from '../src/agent/tools.js';
import type { RunContext } from '../src/agent/context.js';
import { tempFixtureRepo } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { Transcript } from '../src/agent/transcript.js';
import { ObligationsLedger } from '../src/agent/ledger.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function lockedCtx(repo: string): Promise<RunContext> {
  const transcript = new Transcript(repo);
  await transcript.init();
  return {
    repoRoot: repo,
    config: await loadConfig(repo),
    transcript,
    ledger: new ObligationsLedger(),
    runId: 'conf',
    interactive: false,
    confirm: async () => true,
    editsUnlocked: false,
    changeId: null,
    proposalValidated: false,
    filesTouched: new Set(),
    decisions: [],
    lastErc: null,
    lastDrc: null,
    lastLegibility: null,
    lastScore: null,
    repairCycles: 0,
    finishRequest: null,
  };
}

describe('capability conformance', () => {
  it('every registered entry is versioned with a viewHint and a unique name', () => {
    const names = catalog.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const e of catalog) {
      expect(e.version, e.name).toBeGreaterThanOrEqual(1);
      expect(e.viewHint, e.name).toBeTruthy();
    }
  });

  it('catalog tools match HANDLERS and the barrel imports every skills/ file', async () => {
    const toolNames = catalog.filter((e) => e.kind === 'tool').map((e) => e.name).sort();
    expect(toolNames).toEqual(HANDLERS.map((h) => h.schema.name).sort());
    const index = await readFile(path.join(ROOT, 'src/capabilities/index.ts'), 'utf8');
    const skills = (await readdir(path.join(ROOT, 'src/capabilities/skills'))).filter((f) => f.endsWith('.ts'));
    expect(skills.length).toBeGreaterThan(0);
    for (const f of skills) {
      expect(index).toContain(`./skills/${f.replace(/\.ts$/, '.js')}`);
    }
  });

  it('every skill tool name resolves and none lists finish', () => {
    for (const s of registry.skills()) {
      expect(s.tools, s.name).not.toContain('finish');
      for (const n of s.tools) {
        const t = registry.get(n);
        expect(t, `${s.name} → ${n}`).toBeTruthy();
        expect(t?.kind).toBe('tool');
      }
    }
  });

  it('a skill effective gate is at least as strict as each declared tool', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const ctx = await lockedCtx(repo);
      for (const s of registry.skills()) {
        const conj = registry.conjunction(s.tools, ctx);
        if (s.ownGate(ctx)) expect(conj, s.name).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  it('a weaker declared gate is detected (conformance helper)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const ctx = await lockedCtx(repo);
      const weak = defineSkill({
        schema: { name: 'smuggle_edits', description: 'test', parameters: { type: 'object', properties: {} } },
        version: 1,
        viewHint: 'mutation',
        tools: ['edit_file', 'read_file'],
        gate: () => true,
        prompt: () => '',
        isComplete: () => true,
      });
      expect(weak.ownGate(ctx)).toBe(true);
      expect(registry.conjunction(weak.tools, ctx)).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
