import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { configPath, loadConfig, type CopperheadConfig } from '../config.js';
import { CREATE_ORIGIN } from './fab.js';

/**
 * The create pipeline starts from a brief with no KiCad files, but the agent
 * cannot create them: `write_file` refuses KiCad files and `edit_file` only
 * edits existing ones. Without a project on disk the schematic stage can never
 * satisfy its contract (config.schematic stays null), so the pipeline stalls
 * indefinitely. This module scaffolds a minimal, kicad-cli-loadable empty
 * project (schematic ERC-clean, board DRC-clean with a default outline) and
 * wires it into .copperhead/config.json, giving the agent a file to populate.
 */

/** Slug for the project filename, taken from the brief's first H1 (a leading
 * "Brief:" label is dropped). Falls back to "board". */
export function projectSlug(brief: string): string {
  const m = brief.match(/^#\s+(.+?)\s*$/m);
  const title = (m?.[1] ?? 'board').replace(/^brief\s*:\s*/i, '');
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'board';
}

/** A stable, valid-shaped v4 UUID derived from a seed, so a given project
 * bootstraps to the same UUIDs on every run (no Date/random — runs stay
 * reproducible). */
function uuidFrom(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function emptySchematic(rootUuid: string): string {
  return `(kicad_sch
	(version 20231120)
	(generator "copperhead-draft")
	(generator_version "0")
	(uuid "${rootUuid}")
	(paper "A4")
	(lib_symbols)
	(sheet_instances
		(path "/" (page "1"))
	)
)
`;
}

function emptyBoard(outlineUuid: string): string {
  // A default 30x20mm outline on Edge.Cuts so the blank board is DRC-clean out
  // of the gate; the layout stage resizes/replaces it with the real outline.
  return `(kicad_pcb
	(version 20240108)
	(generator "pcbnew")
	(generator_version "8.0")
	(general
		(thickness 1.6)
		(legacy_teardrops no)
	)
	(paper "A4")
	(layers
		(0 "F.Cu" signal)
		(31 "B.Cu" signal)
		(32 "B.Adhes" user "B.Adhesive")
		(33 "F.Adhes" user "F.Adhesive")
		(34 "B.Paste" user)
		(35 "F.Paste" user)
		(36 "B.SilkS" user "B.Silkscreen")
		(37 "F.SilkS" user "F.Silkscreen")
		(38 "B.Mask" user)
		(39 "F.Mask" user)
		(40 "Dwgs.User" user "User.Drawings")
		(41 "Cmts.User" user "User.Comments")
		(42 "Eco1.User" user "User.Eco1")
		(43 "Eco2.User" user "User.Eco2")
		(44 "Edge.Cuts" user)
		(45 "Margin" user)
		(46 "B.CrtYd" user "B.Courtyard")
		(47 "F.CrtYd" user "F.Courtyard")
		(48 "B.Fab" user)
		(49 "F.Fab" user)
	)
	(setup
		(pad_to_mask_clearance 0)
		(allow_soldermask_bridges_in_footprints no)
	)
	(net 0 "")
	(gr_rect (start 100 100) (end 130 120)
		(stroke (width 0.1) (type default))
		(layer "Edge.Cuts")
		(uuid "${outlineUuid}")
	)
)
`;
}

function projectFile(slug: string, rootUuid: string): string {
  return (
    JSON.stringify(
      {
        board: { design_settings: { defaults: {}, rules: {} } },
        erc: {
          erc_exclusions: [],
          meta: { version: 0 },
          rule_severities: { footprint_link_issues: 'ignore', lib_symbol_issues: 'ignore' },
        },
        meta: { filename: `${slug}.kicad_pro`, version: 1 },
        net_settings: {
          classes: [
            {
              bus_width: 12,
              clearance: 0.2,
              diff_pair_gap: 0.25,
              diff_pair_via_gap: 0.25,
              diff_pair_width: 0.2,
              line_style: 0,
              microvia_diameter: 0.3,
              microvia_drill: 0.1,
              name: 'Default',
              pcb_color: 'rgba(0, 0, 0, 0.000)',
              schematic_color: 'rgba(0, 0, 0, 0.000)',
              track_width: 0.25,
              via_diameter: 0.6,
              via_drill: 0.3,
              wire_width: 6,
            },
          ],
          meta: { version: 3 },
        },
        schematic: {
          annotate_start_num: 0,
          drawing: { default_line_thickness: 6.0, default_text_size: 50.0 },
          legacy_lib_dir: '',
          legacy_lib_list: [],
          meta: { version: 1 },
        },
        sheets: [[rootUuid, 'Root']],
        text_variables: {},
      },
      null,
      2,
    ) + '\n'
  );
}

async function persist(repoRoot: string, config: CopperheadConfig): Promise<void> {
  await mkdir(path.dirname(configPath(repoRoot)), { recursive: true });
  await writeFile(configPath(repoRoot), JSON.stringify(config, null, 2) + '\n', 'utf8');
}

/**
 * Stamp the config as create-produced (`origin: "create"`). The marker is what
 * scopes the legibility finish gate (`isCreateProducedRepo` feeds the
 * obligations ledger) and the fab release gate — a gate hung on a marker
 * nothing writes is silently inert, so `runCreate` stamps it up front and
 * `bootstrapKicadProject` re-stamps on every (re-)scaffold, covering the
 * rollback path that deletes an uncommitted config.
 */
export async function markCreateOrigin(repoRoot: string): Promise<void> {
  const config = await loadConfig(repoRoot);
  if (config.origin === CREATE_ORIGIN) return;
  config.origin = CREATE_ORIGIN;
  await persist(repoRoot, config);
}

/**
 * Ensure a KiCad project exists and is wired into config. No-op (returns null)
 * when config already points at a schematic on disk. If project files exist but
 * config doesn't reference them, just wires config. Otherwise scaffolds an empty
 * project. Returns the schematic's repo-relative path when it created or wired
 * one, else null.
 */
export async function bootstrapKicadProject(repoRoot: string, brief: string): Promise<string | null> {
  const config = await loadConfig(repoRoot);
  if (config.schematic && existsSync(path.join(repoRoot, config.schematic))) return null;
  // Only `create` scaffolds through here, so the repo is create-produced by
  // definition; stamping on every scaffold keeps the marker alive across the
  // rollback-then-rescaffold path (git clean deletes an uncommitted config).
  config.origin = CREATE_ORIGIN;

  const slug = projectSlug(brief);
  const schRel = `${slug}.kicad_sch`;
  const pcbRel = `${slug}.kicad_pcb`;
  const proRel = `${slug}.kicad_pro`;
  const schAbs = path.join(repoRoot, schRel);

  if (!existsSync(schAbs)) {
    const rootUuid = uuidFrom(slug);
    await writeFile(schAbs, emptySchematic(rootUuid), 'utf8');
    await writeFile(path.join(repoRoot, pcbRel), emptyBoard(uuidFrom(`${slug}:edge`)), 'utf8');
    await writeFile(path.join(repoRoot, proRel), projectFile(slug, rootUuid), 'utf8');
  }

  config.schematic = schRel;
  config.board = existsSync(path.join(repoRoot, pcbRel)) ? pcbRel : null;
  await persist(repoRoot, config);
  return schRel;
}
