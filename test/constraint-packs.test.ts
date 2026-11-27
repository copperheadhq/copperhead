import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { runCheck } from '../src/commands/check.js';
import { syncVerify } from '../src/commands/sync.js';
import {
  installConstraintPack,
  loadConstraints,
  parseConstraintPack,
  saveConstraint,
} from '../src/memory/constraints.js';
import { runInit } from '../src/memory/scaffold.js';
import { tempFixtureRepo } from './helpers.js';

const pack = (version: string, rules: Record<string, unknown> = {
  'pins.forbidden_gpio14': { forbidden: ['GPIO14'], affects: ['U1'] },
}) => ({
  id: 'battery-powered',
  version,
  name: 'Battery-powered',
  description: 'Low-power design constraints.',
  constraints: rules,
});
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('versioned constraint packs', () => {
  it('exposes local pack installation through the CLI without KiCad', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const source = path.join(repo, 'battery-powered.json');
      await writeFile(source, JSON.stringify(pack('1.0.0'), null, 2), 'utf8');

      const result = await execa(
        'npx',
        ['tsx', 'src/cli.ts', '--json', '--repo', repo, 'constraints', 'add', source],
        { cwd: ROOT, env: { ...process.env, NO_COLOR: '1' } },
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        id: 'battery-powered',
        version: '1.0.0',
        alreadyInstalled: false,
      });
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('vendors a pack and loads its rules with pack provenance', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const source = path.join(repo, 'battery-powered.json');
      await writeFile(source, JSON.stringify(pack('1.0.0'), null, 2), 'utf8');

      const result = await installConstraintPack(repo, source);
      expect(result).toMatchObject({
        id: 'battery-powered',
        version: '1.0.0',
        ruleCount: 1,
        path: '.copperhead/packs/battery-powered@1.0.0.json',
        updated: false,
        alreadyInstalled: false,
      });
      expect(JSON.parse(await readFile(path.join(repo, '.copperhead', 'config.json'), 'utf8'))).toMatchObject({
        constraintPacks: ['.copperhead/packs/battery-powered@1.0.0.json'],
      });
      expect(await loadConstraints(repo)).toMatchObject({
        'pins.forbidden_gpio14': {
          forbidden: ['GPIO14'],
          affects: ['U1'],
          source: 'constraint pack battery-powered@1.0.0',
        },
      });
      expect((await installConstraintPack(repo, source)).alreadyInstalled).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('feeds pack rules through the existing offline constraint check', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const subsystems = path.join(repo, 'docs', 'SUBSYSTEMS.md');
      await writeFile(subsystems, `${await readFile(subsystems, 'utf8')}\n## Keyer\n\nKey input block.\n`, 'utf8');
      const source = path.join(repo, 'battery-powered.json');
      await writeFile(
        source,
        JSON.stringify(
          pack('1.0.0', {
            'pins.forbidden_gpio14': { forbidden: ['GPIO14'], affects: ['U1'] },
            'power.sleep_current_uA': { max: 25, affects: ['power subsystem'] },
          }),
          null,
          2,
        ),
        'utf8',
      );
      await installConstraintPack(repo, source);

      const result = await runCheck(repo, () => {});
      expect(result.constraints.ok).toBe(false);
      expect(result.constraints.packs).toEqual([
        { source: 'constraint pack battery-powered@1.0.0', ruleCount: 2 },
      ]);
      expect(result.constraints.unverified).toContain('power.sleep_current_uA');
      expect(result.constraints.violations).toContainEqual(
        expect.objectContaining({
          key: 'pins.forbidden_gpio14',
          source: 'constraint pack battery-powered@1.0.0',
        }),
      );
      const sync = await syncVerify(repo);
      expect(sync.resolvable.filter((item) => item.claim.includes('pins.forbidden_gpio14'))).toEqual([]);
      expect(sync.resolvable.filter((item) => item.claim.includes('power.sleep_current_uA'))).toEqual([]);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('rejects project-rule collisions and updates by installing a new version', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const source = path.join(repo, 'battery-powered.json');
      await writeFile(source, JSON.stringify(pack('1.0.0'), null, 2), 'utf8');
      await installConstraintPack(repo, source);
      await expect(
        saveConstraint(repo, 'pins.forbidden_gpio14', {
          forbidden: ['GPIO14'],
          source: 'docs/SPEC.md',
          affects: [],
        }),
      ).rejects.toThrow(/comes from a constraint pack/);

      await writeFile(source, JSON.stringify(pack('2.0.0', {
        'power.sleep_current_uA': { max: 25, affects: ['power subsystem'] },
      }), null, 2), 'utf8');
      const result = await installConstraintPack(repo, source);
      expect(result.updated).toBe(true);
      expect(await loadConstraints(repo)).toMatchObject({
        'power.sleep_current_uA': {
          max: 25,
          source: 'constraint pack battery-powered@2.0.0',
        },
      });
      expect(Object.hasOwn(await loadConstraints(repo), 'pins.forbidden_gpio14')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('refuses to install a pack that collides with a project rule', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await saveConstraint(repo, 'pins.forbidden_gpio14', {
        forbidden: ['GPIO14'],
        source: 'docs/SPEC.md',
        affects: [],
      });
      const source = path.join(repo, 'battery-powered.json');
      await writeFile(source, JSON.stringify(pack('1.0.0'), null, 2), 'utf8');

      await expect(installConstraintPack(repo, source)).rejects.toThrow(
        /conflicts with existing constraint\(s\): pins\.forbidden_gpio14/,
      );
      expect(existsSync(path.join(repo, '.copperhead', 'packs', 'battery-powered@1.0.0.json'))).toBe(false);
      expect(Object.hasOwn(await loadConstraints(repo), 'pins.forbidden_gpio14')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('refuses an invalid constraint shape', async () => {
    expect(() => parseConstraintPack(pack('1.0.0', { 'power.sleep_current_uA': { max: 'low' } }))).toThrow(
      /max must be a finite number/,
    );
  });
});
