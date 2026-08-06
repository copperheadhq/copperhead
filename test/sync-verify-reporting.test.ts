import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { runInit } from '../src/memory/scaffold.js';
import { syncVerify } from '../src/commands/sync.js';
import { tempFixtureRepo } from './helpers.js';

/**
 * `syncVerify` reporting details: the location a coverage item points at, and
 * which registry keys count as satisfying a configured budget.
 */

async function writeConfig(repo: string, patch: Record<string, unknown>): Promise<void> {
  const p = path.join(repo, '.copperhead', 'config.json');
  await writeFile(p, JSON.stringify({ budgets: {}, ...patch }, null, 2), 'utf8');
}

async function writeRegistry(repo: string, registry: Record<string, unknown>): Promise<void> {
  await writeFile(
    path.join(repo, '.copperhead', 'constraints.json'),
    JSON.stringify(registry, null, 2),
    'utf8',
  );
}

/** Remove the transparency docs so the coverage items are always reported. */
async function dropCoverageDocs(repo: string, docsDir: string): Promise<void> {
  for (const name of ['DECISIONS.md', 'CHANGELOG.md']) {
    await rm(path.join(repo, docsDir, name), { force: true });
  }
}

describe('syncVerify coverage locations', () => {
  it('joins the docs dir and the file name when docs has no trailing slash', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      await writeConfig(repo, { docs: 'docs' });
      await dropCoverageDocs(repo, 'docs');

      const locations = (await syncVerify(repo)).resolvable
        .filter((i) => i.kind === 'coverage')
        .map((i) => i.doc);

      expect(locations).toContain('docs/DECISIONS.md');
      expect(locations).toContain('docs/CHANGELOG.md');
    } finally {
      await cleanup();
    }
  });

  it('does not double the separator when docs already ends with one', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      await writeConfig(repo, { docs: 'docs/' });
      await dropCoverageDocs(repo, 'docs');

      const locations = (await syncVerify(repo)).resolvable
        .filter((i) => i.kind === 'coverage')
        .map((i) => i.doc);

      expect(locations).toContain('docs/DECISIONS.md');
      expect(locations).not.toContain('docs//DECISIONS.md');
    } finally {
      await cleanup();
    }
  });

  it('handles a nested docs directory', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      await mkdir(path.join(repo, 'docs', 'design'), { recursive: true });
      await writeConfig(repo, { docs: 'docs/design' });

      const locations = (await syncVerify(repo)).resolvable
        .filter((i) => i.kind === 'coverage')
        .map((i) => i.doc);

      expect(locations).toContain('docs/design/DECISIONS.md');
    } finally {
      await cleanup();
    }
  });
});

describe('syncVerify budget dual-write', () => {
  it('does not treat an unrelated key as recording the budget', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      await writeConfig(repo, { docs: 'docs/', budgets: { cost: 10 } });
      // `power.unit_cost` ends with "cost" but is a different quantity
      await writeRegistry(repo, { 'power.unit_cost': { source: 'SPEC.md', value: '5' } });

      const budgetItems = (await syncVerify(repo)).resolvable.filter(
        (i) => i.kind === 'dual-write' && i.claim.startsWith('budget cost='),
      );

      expect(budgetItems).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('accepts a key whose final segment is the budget name', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      await writeConfig(repo, { docs: 'docs/', budgets: { cost: 10 } });
      await writeRegistry(repo, { 'power.cost': { source: 'SPEC.md', value: '10' } });

      const budgetItems = (await syncVerify(repo)).resolvable.filter(
        (i) => i.kind === 'dual-write' && i.claim.startsWith('budget cost='),
      );

      expect(budgetItems).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('accepts an undotted key equal to the budget name', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      await writeConfig(repo, { docs: 'docs/', budgets: { cost: 10 } });
      await writeRegistry(repo, { cost: { source: 'SPEC.md', value: '10' } });

      const budgetItems = (await syncVerify(repo)).resolvable.filter(
        (i) => i.kind === 'dual-write' && i.claim.startsWith('budget cost='),
      );

      expect(budgetItems).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});
