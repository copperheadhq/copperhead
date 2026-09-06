import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog, defineSkill } from '../src/capabilities/index.js';
import { HANDLERS } from '../src/capabilities/handlers.js';
import { registry } from '../src/agent/tools.js';
import { ToolRegistry } from '../src/agent/registry.js';
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
      // The property is about what `list` HANDS OUT, not about the declared
      // gate: a skill declaring edit_file legitimately has an open ownGate
      // (defineSkill defaults it to `() => true`) and is correctly absent while
      // locked. Asserting on ownGate would fail that skill the day someone adds
      // one; asserting on membership fails only the case that actually matters —
      // a listed skill whose declared tools are not all open.
      const listed = new Set(registry.list(ctx).map((e) => e.name));
      for (const s of registry.skills()) {
        if (listed.has(s.name)) expect(registry.conjunction(s.tools, ctx), s.name).toBe(true);
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
      const isolated = new ToolRegistry([...registry.all(), weak]);
      expect(isolated.list(ctx).map((e) => e.name)).not.toContain('smuggle_edits');
    } finally {
      await cleanup();
    }
  });

  it('constructing an isolated registry does not mutate singleton catalog entries', () => {
    const original = registry.get('generate_report');
    expect(original?.kind).toBe('skill');
    if (original?.kind !== 'skill') return;
    const gate = original.gate;
    new ToolRegistry(registry.all());
    expect(registry.get('generate_report')?.gate).toBe(gate);
  });
});
