import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { bootstrapKicadProject, markCreateOrigin, projectSlug } from '../src/kicad/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { isCreateProducedRepo } from '../src/kicad/fab.js';
import { listSymbols } from '../src/kicad/sexp.js';
import { kicadLoadError } from '../src/kicad/cli.js';

const BRIEF = '# Brief: USB-C power breakout\n\nA small board.\n';

async function emptyRepo(): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-bootstrap-'));
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  return { repo, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

describe('KiCad project bootstrap (create schematic-stage gap #19)', () => {
  it('derives a filename slug from the brief H1, dropping a "Brief:" label', () => {
    expect(projectSlug(BRIEF)).toBe('usb-c-power-breakout');
    expect(projectSlug('# My Cool Board\n')).toBe('my-cool-board');
    expect(projectSlug('no heading here')).toBe('board');
  });

  it('scaffolds an empty, loadable project and wires config', async () => {
    const { repo, cleanup } = await emptyRepo();
    try {
      const created = await bootstrapKicadProject(repo, BRIEF);
      expect(created).toBe('usb-c-power-breakout.kicad_sch');
      expect(existsSync(path.join(repo, 'usb-c-power-breakout.kicad_sch'))).toBe(true);
      expect(existsSync(path.join(repo, 'usb-c-power-breakout.kicad_pcb'))).toBe(true);
      expect(existsSync(path.join(repo, 'usb-c-power-breakout.kicad_pro'))).toBe(true);

      const config = await loadConfig(repo);
      expect(config.schematic).toBe('usb-c-power-breakout.kicad_sch');
      expect(config.board).toBe('usb-c-power-breakout.kicad_pcb');

      // Empty but valid: parses to zero symbols and loads in KiCad.
      expect(await listSymbols(path.join(repo, config.schematic!))).toHaveLength(0);
      expect(await kicadLoadError(path.join(repo, config.schematic!))).toBeNull();
      expect(await kicadLoadError(path.join(repo, config.board!))).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('is idempotent: a second call is a no-op once config points at a schematic', async () => {
    const { repo, cleanup } = await emptyRepo();
    try {
      await bootstrapKicadProject(repo, BRIEF);
      const before = await readFile(path.join(repo, 'usb-c-power-breakout.kicad_sch'), 'utf8');
      const second = await bootstrapKicadProject(repo, BRIEF);
      expect(second).toBeNull();
      const after = await readFile(path.join(repo, 'usb-c-power-breakout.kicad_sch'), 'utf8');
      expect(after).toBe(before); // untouched
    } finally {
      await cleanup();
    }
  });
});

describe('create-origin marker (legibility and fab gate scoping)', () => {
  // The gates scoped by isCreateProducedRepo were hung on a config marker that
  // no code path wrote, so they were silently inert in every real repo: the
  // legibility obligation never opened and finish("done") sailed through on an
  // illegible sheet.
  it('bootstrapKicadProject stamps origin: create into the persisted config', async () => {
    const { repo, cleanup } = await emptyRepo();
    try {
      await bootstrapKicadProject(repo, BRIEF);
      expect(isCreateProducedRepo(await loadConfig(repo))).toBe(true);
      const raw = JSON.parse(await readFile(path.join(repo, '.copperhead', 'config.json'), 'utf8'));
      expect(raw.origin).toBe('create');
    } finally {
      await cleanup();
    }
  });

  it('markCreateOrigin stamps a resumed repo whose project predates the marker', async () => {
    const { repo, cleanup } = await emptyRepo();
    try {
      // Scaffold, then strip the marker to simulate a pre-marker create repo.
      await bootstrapKicadProject(repo, BRIEF);
      const cfgPath = path.join(repo, '.copperhead', 'config.json');
      const raw = JSON.parse(await readFile(cfgPath, 'utf8'));
      delete raw.origin;
      await writeFile(cfgPath, JSON.stringify(raw, null, 2), 'utf8');
      expect(isCreateProducedRepo(await loadConfig(repo))).toBe(false);

      await markCreateOrigin(repo);
      expect(isCreateProducedRepo(await loadConfig(repo))).toBe(true);
      // bootstrap stays a no-op on the resumed repo (schematic already wired),
      // so markCreateOrigin has to be the writer here.
      expect(await bootstrapKicadProject(repo, BRIEF)).toBeNull();
    } finally {
      await cleanup();
    }
  });
});
