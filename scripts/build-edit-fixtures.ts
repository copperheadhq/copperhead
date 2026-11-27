import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EDITS_DIR = path.join(ROOT, 'test', 'fixtures', 'edits');

function kicadProContent(filename: string): string {
  return JSON.stringify(
    {
      board: {
        design_settings: {
          defaults: {},
          rules: {},
        },
      },
      erc: {
        erc_exclusions: [],
        meta: {
          version: 0,
        },
        rule_severities: {
          footprint_link_issues: 'ignore',
          lib_symbol_issues: 'ignore',
        },
      },
      meta: {
        filename,
        version: 1,
      },
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
        meta: {
          version: 3,
        },
      },
      schematic: {
        annotate_start_num: 0,
        drawing: {
          default_line_thickness: 6.0,
          default_text_size: 50.0,
        },
      },
    },
    null,
    2,
  ) + '\n';
}

function kicadPrlContent(filename: string): string {
  return JSON.stringify(
    {
      board: {
        active_layer: 0,
        active_layer_preset: '',
        auto_track_width: true,
        hidden_netclasses: [],
        hidden_nets: [],
        high_contrast_mode: 0,
        net_color_mode: 1,
        opacity: {
          images: 0.6,
          pads: 1.0,
          shapes: 1.0,
          tracks: 1.0,
          vias: 1.0,
          zones: 0.6,
        },
        prototype_zone_fills: false,
        selection_filter: {
          dimensions: true,
          footprints: true,
          graphics: true,
          keepouts: true,
          lockedItems: false,
          otherItems: true,
          pads: true,
          text: true,
          tracks: true,
          vias: true,
          zones: true,
        },
        visible_items: [
          'vias',
          'footprint_text',
          'footprint_anchors',
          'ratsnest',
          'grid',
          'footprints_front',
          'footprints_back',
          'footprint_values',
          'footprint_references',
          'tracks',
          'drc_errors',
          'drawing_sheet',
          'bitmaps',
          'pads',
          'zones',
          'drc_warnings',
          'drc_exclusions',
          'locked_item_shadows',
          'conflict_shadows',
          'shapes',
          'board_outline_area',
          'ly_points',
        ],
        visible_layers: 'ffffffff_ffffffff_ffffffff_ffffffff',
        zone_display_mode: 0,
      },
      git: {
        integration_disabled: false,
        repo_type: '',
        repo_username: '',
        ssh_key: '',
      },
      meta: {
        filename,
        version: 5,
      },
      net_inspector_panel: {
        col_hidden: [],
        col_order: [],
        col_widths: [],
        custom_group_rules: [],
        expanded_rows: [],
        filter_by_net_name: true,
        filter_by_netclass: true,
        filter_text: '',
        group_by_constraint: false,
        group_by_netclass: false,
        show_time_domain_details: false,
        show_unconnected_nets: false,
        show_zero_pad_nets: false,
        sort_ascending: true,
        sorting_column: -1,
      },
      open_jobsets: [],
      project: {
        files: [],
      },
      schematic: {
        hierarchy_collapsed: [],
        selection_filter: {
          graphics: true,
          images: true,
          labels: true,
          lockedItems: false,
          otherItems: true,
          pins: true,
          ruleAreas: true,
          symbols: true,
          text: true,
          wires: true,
        },
      },
    },
    null,
    2,
  ) + '\n';
}

function kicadPcbContent(uuid: string): string {
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
  (gr_rect (start 100 100) (end 140 130)
    (stroke (width 0.1) (type default))
    (layer "Edge.Cuts")
    (uuid "${uuid}")
  )
)
`;
}

function configJsonContent(id: string, budgets: Record<string, number> = {}): string {
  return JSON.stringify(
    {
      schematic: `hardware/${id}.kicad_sch`,
      board: `hardware/${id}.kicad_pcb`,
      docs: 'docs',
      model: null,
      maxTurns: 40,
      maxRepairCycles: 5,
      budgets,
      turnTimeoutMs: 300000,
      turnMaxMs: 3600000,
      heartbeatMs: 30000,
      maxStageRetries: 2,
    },
    null,
    2,
  ) + '\n';
}

function decisionsMdContent(): string {
  return `# Decision log

Append-only. Every non-trivial agent decision lands here: date, run id,
decision, rationale, and what it affects. Entries are never rewritten.
`;
}

function changelogMdContent(): string {
  return `# Design changelog

Append-only, newest first. One entry per committed copperhead run.
`;
}

function layoutMdContent(): string {
  return `# Layout intent

Placement and routing intent: keepouts, pours, ESD placement.

## Draft quality

<!-- copperhead writes an honest assessment here after any layout pass -->
`;
}

async function writeCaseFiles(
  id: string,
  files: {
    manifest: Record<string, unknown>;
    constraints?: Record<string, unknown>;
    budgets?: Record<string, number>;
    specMd: string;
    bomMd: string;
    pinoutMd: string;
    subsystemsMd: string;
    schFiles: Record<string, string>;
  },
): Promise<void> {
  const dir = path.join(EDITS_DIR, id);
  await mkdir(path.join(dir, '.copperhead'), { recursive: true });
  await mkdir(path.join(dir, 'docs'), { recursive: true });
  await mkdir(path.join(dir, 'hardware'), { recursive: true });

  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(files.manifest, null, 2) + '\n', 'utf8');
  await writeFile(path.join(dir, '.copperhead', 'config.json'), configJsonContent(id, files.budgets ?? {}), 'utf8');
  await writeFile(
    path.join(dir, '.copperhead', 'constraints.json'),
    JSON.stringify(files.constraints ?? {}, null, 2) + '\n',
    'utf8',
  );

  await writeFile(path.join(dir, 'docs', 'SPEC.md'), files.specMd, 'utf8');
  await writeFile(path.join(dir, 'docs', 'BOM.md'), files.bomMd, 'utf8');
  await writeFile(path.join(dir, 'docs', 'PINOUT.md'), files.pinoutMd, 'utf8');
  await writeFile(path.join(dir, 'docs', 'SUBSYSTEMS.md'), files.subsystemsMd, 'utf8');
  await writeFile(path.join(dir, 'docs', 'LAYOUT.md'), layoutMdContent(), 'utf8');
  await writeFile(path.join(dir, 'docs', 'DECISIONS.md'), decisionsMdContent(), 'utf8');
  await writeFile(path.join(dir, 'docs', 'CHANGELOG.md'), changelogMdContent(), 'utf8');

  await writeFile(path.join(dir, 'hardware', `${id}.kicad_pro`), kicadProContent(`${id}.kicad_pro`), 'utf8');
  await writeFile(path.join(dir, 'hardware', `${id}.kicad_prl`), kicadPrlContent(`${id}.kicad_prl`), 'utf8');
  await writeFile(
    path.join(dir, 'hardware', `${id}.kicad_pcb`),
    kicadPcbContent(`1a1a1a1a-0000-4000-8000-${id.slice(0, 12).padEnd(12, '0')}`),
    'utf8',
  );

  for (const [schName, content] of Object.entries(files.schFiles)) {
    await writeFile(path.join(dir, 'hardware', schName), content, 'utf8');
  }
}

// ============================================================================
// Case 1: rename-net-cross-sheet (AC-3.1)
// ============================================================================
async function buildCase1(): Promise<void> {
  const id = 'rename-net-cross-sheet';
  const manifest = {
    id,
    ac: 'AC-3.1',
    title: 'Cross-sheet net rename',
    description: 'Propagate net rename across multiple schematic sheets and synchronize design documentation with a surgical diff (< 5% lines changed).',
    instruction: 'rename net KEY_DAH to KEY_DASH',
    expect: {
      outcome: 'success',
      erc: 'clean',
      commits: 1,
      filesChanged: [
        'hardware/rename-net-cross-sheet.kicad_sch',
        'hardware/keyer.kicad_sch',
        'docs/PINOUT.md',
        'docs/SUBSYSTEMS.md',
      ],
      maxSchLinesChangedPct: 5,
      mustContain: {
        'docs/PINOUT.md': 'KEY_DASH',
        'docs/SUBSYSTEMS.md': 'KEY_DASH',
        'hardware/rename-net-cross-sheet.kicad_sch': 'KEY_DASH',
        'hardware/keyer.kicad_sch': 'KEY_DASH',
      },
      mustNotContain: {
        'docs/PINOUT.md': 'KEY_DAH',
        'docs/SUBSYSTEMS.md': 'KEY_DAH',
        'hardware/rename-net-cross-sheet.kicad_sch': '"KEY_DAH"',
        'hardware/keyer.kicad_sch': '"KEY_DAH"',
      },
    },
  };

  const specMd = `# rename-net-cross-sheet — Specification

Two-sheet Morse keyer design based on ESP32-S3. The KEY_DAH paddle signal traverses the root MCU sheet and the keyer conditioning subsheet.

## Budgets

<!-- Hard budgets -->

## Assumptions

- Keyer conditioning uses 1k series protection and 10k pullup.
`;

  const bomMd = `# Bill of Materials

Every part: refdes, MPN, value, package, and WHY it was chosen. MPNs the agent
introduces without a datasheet check are flagged UNVERIFIED.

Value holds the component value only ("4.7uF", "1M", "500mAh Li-Po") — the
schematic stage draws it as the symbol's Value field, so a description there
collides with neighbouring symbols and fails the legibility gate. Prose belongs
in Rationale. One row per refdes; a grouped row ("C5-C8") matches no symbol.

| Refdes | Value | Footprint | MPN | Rationale |
|---|---|---|---|---|
| R1 | 10k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | extracted from schematic by copperhead init |
| R2 | 1k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | extracted from schematic by copperhead init |
| U1 | ESP32-S3-MINI | RF_Module:ESP32-S3-MINI-1 | UNVERIFIED | extracted from schematic by copperhead init |
`;

  const pinoutMd = `# Pinout

Pin assignment extracted from the schematic. Check strapping/RTC notes before
reassigning pins.

| Refdes | Pin | Name | Net | Notes |
|---|---|---|---|---|
| U1 | 1 | 3V3 | 3V3 | |
| U1 | 2 | EN | EN | |
| U1 | 3 | GPIO0 | | |
| U1 | 4 | GPIO3 | | |
| U1 | 5 | GPIO14 | KEY_DAH | Key paddle input |
| U1 | 6 | GPIO18 | | |
| U1 | 7 | GPIO21 | | |
| U1 | 8 | GND | GND | |
`;

  const subsystemsMd = `# Subsystems

Per-sheet values and reasoning (regulator, charger, RF, ...).

## Sheet /

- U1: ESP32-S3-MINI (MCU with key input on KEY_DAH)

## Sheet Keyer

- R1: 10k (Pullup)
- R2: 1k (Series protection on KEY_DAH)
`;

  const rootSch = `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (generator_version "8.0")
  (uuid "0a0a0a0a-0000-4000-8000-000000000001")
  (paper "A4")
  (title_block
    (title "rename-net-cross-sheet root")
    (date "2026-07-31")
    (rev "A")
    (comment 1 "Root sheet of multi-sheet net rename fixture")
  )
  (lib_symbols
    (symbol "fixture:ESP32-S3-MINI"
      (pin_names (offset 1.016))
      (exclude_from_sim no)
      (in_bom yes)
      (on_board yes)
      (property "Reference" "U" (at 0 11.43 0)
        (effects (font (size 1.27 1.27)))
      )
      (property "Value" "ESP32-S3-MINI" (at 0 -11.43 0)
        (effects (font (size 1.27 1.27)))
      )
      (property "Footprint" "" (at 0 0 0)
        (effects (font (size 1.27 1.27)) hide)
      )
      (property "Datasheet" "~" (at 0 0 0)
        (effects (font (size 1.27 1.27)) hide)
      )
      (symbol "ESP32-S3-MINI_0_1"
        (rectangle (start -10.16 10.16) (end 10.16 -10.16)
          (stroke (width 0.254) (type default))
          (fill (type background))
        )
      )
      (symbol "ESP32-S3-MINI_1_1"
        (pin passive line (at -12.7 8.89 0) (length 2.54)
          (name "3V3" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 6.35 0) (length 2.54)
          (name "EN" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 3.81 0) (length 2.54)
          (name "GPIO0" (effects (font (size 1.27 1.27))))
          (number "3" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 1.27 0) (length 2.54)
          (name "GPIO3" (effects (font (size 1.27 1.27))))
          (number "4" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 -1.27 0) (length 2.54)
          (name "GPIO14" (effects (font (size 1.27 1.27))))
          (number "5" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 -3.81 0) (length 2.54)
          (name "GPIO18" (effects (font (size 1.27 1.27))))
          (number "6" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 -6.35 0) (length 2.54)
          (name "GPIO21" (effects (font (size 1.27 1.27))))
          (number "7" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 -8.89 0) (length 2.54)
          (name "GND" (effects (font (size 1.27 1.27))))
          (number "8" (effects (font (size 1.27 1.27))))
        )
      )
    )
  )
  (no_connect (at 127 96.52) (uuid "0b0b0b0b-0000-4000-8000-000000000001"))
  (no_connect (at 127 99.06) (uuid "0b0b0b0b-0000-4000-8000-000000000002"))
  (no_connect (at 127 104.14) (uuid "0b0b0b0b-0000-4000-8000-000000000003"))
  (no_connect (at 127 106.68) (uuid "0b0b0b0b-0000-4000-8000-000000000004"))
  (global_label "3V3" (shape input) (at 127 91.44 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000001")
    (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 118.4864 91.0286 0)
      (effects (font (size 1.27 1.27)) (justify right) hide)
    )
  )
  (global_label "EN" (shape input) (at 127 93.98 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000002")
    (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 119.8536 93.5686 0)
      (effects (font (size 1.27 1.27)) (justify right) hide)
    )
  )
  (global_label "KEY_DAH" (shape input) (at 127 101.6 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000003")
    (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 115.1014 101.1886 0)
      (effects (font (size 1.27 1.27)) (justify right) hide)
    )
  )
  (global_label "GND" (shape input) (at 127 109.22 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000004")
    (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 119.2536 108.8086 0)
      (effects (font (size 1.27 1.27)) (justify right) hide)
    )
  )
  (symbol
    (lib_id "fixture:ESP32-S3-MINI")
    (at 139.7 100.33 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (fields_autoplaced yes)
    (uuid "0d0d0d0d-0000-4000-8000-000000000003")
    (property "Reference" "U1" (at 139.7 87.96 0)
      (effects (font (size 1.27 1.27)))
    )
    (property "Value" "ESP32-S3-MINI" (at 139.7 112.725 0)
      (effects (font (size 1.27 1.27)))
    )
    (property "Footprint" "RF_Module:ESP32-S3-MINI-1" (at 139.7 100.33 0)
      (effects (font (size 1.27 1.27)) hide)
    )
    (property "Datasheet" "~" (at 139.7 100.33 0)
      (effects (font (size 1.27 1.27)) hide)
    )
    (pin "1" (uuid "0e0e0e0e-0000-4000-8000-000000000005"))
    (pin "2" (uuid "0e0e0e0e-0000-4000-8000-000000000006"))
    (pin "3" (uuid "0e0e0e0e-0000-4000-8000-000000000007"))
    (pin "4" (uuid "0e0e0e0e-0000-4000-8000-000000000008"))
    (pin "5" (uuid "0e0e0e0e-0000-4000-8000-000000000009"))
    (pin "6" (uuid "0e0e0e0e-0000-4000-8000-00000000000a"))
    (pin "7" (uuid "0e0e0e0e-0000-4000-8000-00000000000b"))
    (pin "8" (uuid "0e0e0e0e-0000-4000-8000-00000000000c"))
    (instances
      (project "rename-net-cross-sheet"
        (path "/0a0a0a0a-0000-4000-8000-000000000001"
          (reference "U1") (unit 1)
        )
      )
    )
  )
  (sheet (at 60 140) (size 40 25) (fields_autoplaced yes)
    (stroke (width 0.152) (type solid))
    (fill (type none))
    (uuid "0f0f0f0f-0000-4000-8000-00000000sh01")
    (property "Sheetname" "Keyer" (at 60 138 0)
      (effects (font (size 1.27 1.27)) (justify left bottom))
    )
    (property "Sheetfile" "keyer.kicad_sch" (at 60 166 0)
      (effects (font (size 1.27 1.27)) (justify left top))
    )
  )
  (sheet_instances
    (path "/" (page "1"))
  )
)
`;

  const childSch = `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (generator_version "8.0")
  (uuid "0a0a0a0a-0000-4000-8000-000000000002")
  (paper "A4")
  (title_block
    (title "Keyer Subsheet")
    (date "2026-07-31")
    (rev "A")
    (comment 1 "Keyer conditioning circuit")
  )
  (lib_symbols
    (symbol "Device:R"
      (pin_numbers hide)
      (pin_names (offset 0))
      (exclude_from_sim no)
      (in_bom yes)
      (on_board yes)
      (property "Reference" "R" (at 2.032 0 90)
        (effects (font (size 1.27 1.27)))
      )
      (property "Value" "R" (at 0 0 90)
        (effects (font (size 1.27 1.27)))
      )
      (property "Footprint" "" (at -1.778 0 90)
        (effects (font (size 1.27 1.27)) hide)
      )
      (property "Datasheet" "~" (at 0 0 0)
        (effects (font (size 1.27 1.27)) hide)
      )
      (symbol "R_0_1"
        (rectangle (start -1.016 -2.54) (end 1.016 2.54)
          (stroke (width 0.254) (type default))
          (fill (type none))
        )
      )
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27))))
        )
      )
    )
  )
  (global_label "3V3" (shape input) (at 88.9 91.44 90) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify left))
    (uuid "0c0c0c0c-0000-4000-8000-000000000005")
    (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 88.9814 87.0964 90)
      (effects (font (size 1.27 1.27)) (justify left) hide)
    )
  )
  (global_label "EN" (shape input) (at 88.9 99.06 270) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000006")
    (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 88.9814 103.4036 270)
      (effects (font (size 1.27 1.27)) (justify right) hide)
    )
  )
  (global_label "KEY_DAH" (shape input) (at 96.52 106.68 90) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify left))
    (uuid "0c0c0c0c-0000-4000-8000-000000000007")
    (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 96.6014 102.3364 90)
      (effects (font (size 1.27 1.27)) (justify left) hide)
    )
  )
  (global_label "GND" (shape input) (at 96.52 114.3 270) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000008")
    (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 96.6014 118.6436 270)
      (effects (font (size 1.27 1.27)) (justify right) hide)
    )
  )
  (symbol
    (lib_id "Device:R")
    (at 88.9 95.25 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (fields_autoplaced yes)
    (uuid "0d0d0d0d-0000-4000-8000-000000000001")
    (property "Reference" "R1" (at 91.44 94.6149 0)
      (effects (font (size 1.27 1.27)) (justify left))
    )
    (property "Value" "10k" (at 91.44 97.1549 0)
      (effects (font (size 1.27 1.27)) (justify left))
    )
    (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 87.122 95.25 90)
      (effects (font (size 1.27 1.27)) hide)
    )
    (property "Datasheet" "~" (at 88.9 95.25 0)
      (effects (font (size 1.27 1.27)) hide)
    )
    (pin "1" (uuid "0e0e0e0e-0000-4000-8000-000000000001"))
    (pin "2" (uuid "0e0e0e0e-0000-4000-8000-000000000002"))
    (instances
      (project "rename-net-cross-sheet"
        (path "/0a0a0a0a-0000-4000-8000-000000000001/0f0f0f0f-0000-4000-8000-00000000sh01"
          (reference "R1") (unit 1)
        )
      )
    )
  )
  (symbol
    (lib_id "Device:R")
    (at 96.52 110.49 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (fields_autoplaced yes)
    (uuid "0d0d0d0d-0000-4000-8000-000000000002")
    (property "Reference" "R2" (at 99.06 109.8549 0)
      (effects (font (size 1.27 1.27)) (justify left))
    )
    (property "Value" "1k" (at 99.06 112.3949 0)
      (effects (font (size 1.27 1.27)) (justify left))
    )
    (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 94.742 110.49 90)
      (effects (font (size 1.27 1.27)) hide)
    )
    (property "Datasheet" "~" (at 96.52 110.49 0)
      (effects (font (size 1.27 1.27)) hide)
    )
    (pin "1" (uuid "0e0e0e0e-0000-4000-8000-000000000003"))
    (pin "2" (uuid "0e0e0e0e-0000-4000-8000-000000000004"))
    (instances
      (project "rename-net-cross-sheet"
        (path "/0a0a0a0a-0000-4000-8000-000000000001/0f0f0f0f-0000-4000-8000-00000000sh01"
          (reference "R2") (unit 1)
        )
      )
    )
  )
  (sheet_instances
    (path "/0f0f0f0f-0000-4000-8000-00000000sh01" (page "2"))
  )
)
`;

  await writeCaseFiles(id, {
    manifest,
    specMd,
    bomMd,
    pinoutMd,
    subsystemsMd,
    schFiles: {
      'rename-net-cross-sheet.kicad_sch': rootSch,
      'keyer.kicad_sch': childSch,
    },
  });
}

// ============================================================================
// Case 2: pin-choice-strapping (AC-3.2)
// ============================================================================
async function buildCase2(): Promise<void> {
  const id = 'pin-choice-strapping';
  const manifest = {
    id,
    ac: 'AC-3.2',
    title: 'Constraint-aware pin selection',
    description: 'Move an input signal to an RTC-capable pin while respecting strapping-pin constraints (GPIO0, GPIO3, GPIO45, GPIO46 forbidden).',
    instruction: 'move the key input to a different RTC-capable pin',
    expect: {
      outcome: 'success',
      erc: 'clean',
      commits: 1,
      filesChanged: [
        'hardware/pin-choice-strapping.kicad_sch',
        'docs/PINOUT.md',
      ],
      mustNotContain: {
        'docs/PINOUT.md': [
          '| U1 | 3 | GPIO0 | KEY_IN |',
          '| U1 | 4 | GPIO3 | KEY_IN |',
          '| U1 | 9 | GPIO45 | KEY_IN |',
          '| U1 | 10 | GPIO46 | KEY_IN |',
          '| U1 | 5 | GPIO14 | KEY_IN |',
        ],
      },
    },
  };

  const constraints = {
    'pinout.strapping': {
      forbidden: ['GPIO0', 'GPIO3', 'GPIO45', 'GPIO46'],
      source: 'docs/SPEC.md#strapping-pins',
      affects: ['U1', 'KEY_IN'],
    },
    'pinout.rtc_required': {
      value: 'RTC-capable',
      source: 'docs/SPEC.md#rtc-capable-gpios',
      affects: ['KEY_IN'],
    },
  };

  const specMd = `# pin-choice-strapping — Specification

ESP32-S3 keyer design with deep-sleep wakeup requirements. Key input must be connected to an RTC-capable GPIO and strictly avoid boot strapping pins.

## Strapping pins

The following pins are ESP32-S3 strapping pins and MUST NOT be used for the key input or pulled low at boot:

- GPIO0 (strapping: boot mode selection)
- GPIO3 (strapping: JTAG configuration)
- GPIO45 (strapping: VDD_SPI voltage)
- GPIO46 (strapping: ROM message printing)

## RTC-capable GPIOs

ESP32-S3 RTC GPIOs available for deep-sleep wakeup:

- GPIO0 (RTC_GPIO0, strapping: forbidden)
- GPIO3 (RTC_GPIO3, strapping: forbidden)
- GPIO1 (RTC_GPIO1, available)
- GPIO2 (RTC_GPIO2, available)
- GPIO14 (RTC_GPIO14, current key input)
- GPIO18 (RTC_GPIO18, available)
- GPIO21 (RTC_GPIO21, available)

## Budgets

<!-- Hard budgets -->
`;

  const bomMd = `# Bill of Materials

Every part: refdes, MPN, value, package, and WHY it was chosen. MPNs the agent
introduces without a datasheet check are flagged UNVERIFIED.

Value holds the component value only ("4.7uF", "1M", "500mAh Li-Po") — the
schematic stage draws it as the symbol's Value field, so a description there
collides with neighbouring symbols and fails the legibility gate. Prose belongs
in Rationale. One row per refdes; a grouped row ("C5-C8") matches no symbol.

| Refdes | Value | Footprint | MPN | Rationale |
|---|---|---|---|---|
| R1 | 10k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | extracted from schematic by copperhead init |
| R2 | 1k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | extracted from schematic by copperhead init |
| U1 | ESP32-S3-WROOM-1 | RF_Module:ESP32-S3-WROOM-1 | UNVERIFIED | extracted from schematic by copperhead init |
`;

  const pinoutMd = `# Pinout

Pin assignment extracted from the schematic. Check strapping/RTC notes before
reassigning pins.

| Refdes | Pin | Name | Net | Notes |
|---|---|---|---|---|
| U1 | 1 | 3V3 | 3V3 | Main 3.3V rail |
| U1 | 2 | EN | EN | Enable line with pullup |
| U1 | 3 | GPIO0 | | Strapping pin (boot mode) — forbidden for key |
| U1 | 4 | GPIO3 | | Strapping pin (JTAG) — forbidden for key |
| U1 | 5 | GPIO14 | KEY_IN | Current key input (RTC_GPIO14) |
| U1 | 6 | GPIO18 | | RTC_GPIO18 (RTC capable, available) |
| U1 | 7 | GPIO21 | | RTC_GPIO21 (RTC capable, available) |
| U1 | 8 | GND | GND | Ground |
| U1 | 9 | GPIO45 | | Strapping pin (VDD_SPI) — forbidden |
| U1 | 10 | GPIO46 | | Strapping pin (ROM log) — forbidden |
| U1 | 11 | GPIO1 | | RTC_GPIO1 (RTC capable, available) |
| U1 | 12 | GPIO2 | | RTC_GPIO2 (RTC capable, available) |
`;

  const subsystemsMd = `# Subsystems

Per-sheet values and reasoning (regulator, charger, RF, ...).

## Sheet /

- R1: 10k (Chip enable pullup)
- R2: 1k (Key input series protection)
- U1: ESP32-S3-WROOM-1 (MCU with RTC-aware key input)
`;

  const sch = `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (generator_version "8.0")
  (uuid "0a0a0a0a-0000-4000-8000-000000000001")
  (paper "A4")
  (title_block
    (title "pin-choice-strapping")
    (date "2026-07-31")
    (rev "A")
    (comment 1 "ESP32-S3 design for constraint-aware pin choice")
  )
  (lib_symbols
    (symbol "Device:R"
      (pin_numbers hide)
      (pin_names (offset 0))
      (exclude_from_sim no)
      (in_bom yes)
      (on_board yes)
      (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
      (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
      (property "Footprint" "" (at -1.778 0 90) (effects (font (size 1.27 1.27)) hide))
      (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (symbol "R_0_1"
        (rectangle (start -1.016 -2.54) (end 1.016 2.54)
          (stroke (width 0.254) (type default))
          (fill (type none))
        )
      )
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27))))
        )
      )
    )
    (symbol "fixture:ESP32-S3-WROOM-1"
      (pin_names (offset 1.016))
      (exclude_from_sim no)
      (in_bom yes)
      (on_board yes)
      (property "Reference" "U" (at 0 16.51 0) (effects (font (size 1.27 1.27))))
      (property "Value" "ESP32-S3-WROOM-1" (at 0 -16.51 0) (effects (font (size 1.27 1.27))))
      (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (symbol "ESP32-S3-WROOM-1_0_1"
        (rectangle (start -10.16 15.24) (end 10.16 -15.24)
          (stroke (width 0.254) (type default))
          (fill (type background))
        )
      )
      (symbol "ESP32-S3-WROOM-1_1_1"
        (pin passive line (at -12.7 13.97 0) (length 2.54)
          (name "3V3" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 11.43 0) (length 2.54)
          (name "EN" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 8.89 0) (length 2.54)
          (name "GPIO0" (effects (font (size 1.27 1.27))))
          (number "3" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 6.35 0) (length 2.54)
          (name "GPIO3" (effects (font (size 1.27 1.27))))
          (number "4" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 3.81 0) (length 2.54)
          (name "GPIO14" (effects (font (size 1.27 1.27))))
          (number "5" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 1.27 0) (length 2.54)
          (name "GPIO18" (effects (font (size 1.27 1.27))))
          (number "6" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 -1.27 0) (length 2.54)
          (name "GPIO21" (effects (font (size 1.27 1.27))))
          (number "7" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 -3.81 0) (length 2.54)
          (name "GND" (effects (font (size 1.27 1.27))))
          (number "8" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 -6.35 0) (length 2.54)
          (name "GPIO45" (effects (font (size 1.27 1.27))))
          (number "9" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 -8.89 0) (length 2.54)
          (name "GPIO46" (effects (font (size 1.27 1.27))))
          (number "10" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 -11.43 0) (length 2.54)
          (name "GPIO1" (effects (font (size 1.27 1.27))))
          (number "11" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 -13.97 0) (length 2.54)
          (name "GPIO2" (effects (font (size 1.27 1.27))))
          (number "12" (effects (font (size 1.27 1.27))))
        )
      )
    )
  )
  (no_connect (at 127 91.44) (uuid "0b0b0b0b-0000-4000-8000-000000000001"))
  (no_connect (at 127 93.98) (uuid "0b0b0b0b-0000-4000-8000-000000000002"))
  (no_connect (at 127 99.06) (uuid "0b0b0b0b-0000-4000-8000-000000000003"))
  (no_connect (at 127 101.6) (uuid "0b0b0b0b-0000-4000-8000-000000000004"))
  (no_connect (at 127 106.68) (uuid "0b0b0b0b-0000-4000-8000-000000000005"))
  (no_connect (at 127 109.22) (uuid "0b0b0b0b-0000-4000-8000-000000000006"))
  (no_connect (at 127 111.76) (uuid "0b0b0b0b-0000-4000-8000-000000000007"))
  (no_connect (at 127 114.3) (uuid "0b0b0b0b-0000-4000-8000-000000000008"))
  (global_label "3V3" (shape input) (at 127 86.36 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000001")
  )
  (global_label "EN" (shape input) (at 127 88.9 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000002")
  )
  (global_label "KEY_IN" (shape input) (at 127 96.52 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000003")
  )
  (global_label "GND" (shape input) (at 127 104.14 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000004")
  )
  (global_label "3V3" (shape input) (at 88.9 91.44 90) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify left))
    (uuid "0c0c0c0c-0000-4000-8000-000000000005")
  )
  (global_label "EN" (shape input) (at 88.9 99.06 270) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000006")
  )
  (global_label "KEY_IN" (shape input) (at 96.52 106.68 90) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify left))
    (uuid "0c0c0c0c-0000-4000-8000-000000000007")
  )
  (global_label "GND" (shape input) (at 96.52 114.3 270) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000008")
  )
  (symbol
    (lib_id "Device:R")
    (at 88.9 95.25 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (fields_autoplaced yes)
    (uuid "0d0d0d0d-0000-4000-8000-000000000001")
    (property "Reference" "R1" (at 91.44 94.6149 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "10k" (at 91.44 97.1549 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 87.122 95.25 90) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 88.9 95.25 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "0e0e0e0e-0000-4000-8000-000000000001"))
    (pin "2" (uuid "0e0e0e0e-0000-4000-8000-000000000002"))
    (instances
      (project "pin-choice-strapping"
        (path "/0a0a0a0a-0000-4000-8000-000000000001" (reference "R1") (unit 1))
      )
    )
  )
  (symbol
    (lib_id "Device:R")
    (at 96.52 110.49 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (fields_autoplaced yes)
    (uuid "0d0d0d0d-0000-4000-8000-000000000002")
    (property "Reference" "R2" (at 99.06 109.8549 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "1k" (at 99.06 112.3949 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 94.742 110.49 90) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 96.52 110.49 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "0e0e0e0e-0000-4000-8000-000000000003"))
    (pin "2" (uuid "0e0e0e0e-0000-4000-8000-000000000004"))
    (instances
      (project "pin-choice-strapping"
        (path "/0a0a0a0a-0000-4000-8000-000000000001" (reference "R2") (unit 1))
      )
    )
  )
  (symbol
    (lib_id "fixture:ESP32-S3-WROOM-1")
    (at 139.7 100.33 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (fields_autoplaced yes)
    (uuid "0d0d0d0d-0000-4000-8000-000000000003")
    (property "Reference" "U1" (at 139.7 82.55 0) (effects (font (size 1.27 1.27))))
    (property "Value" "ESP32-S3-WROOM-1" (at 139.7 118.11 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "RF_Module:ESP32-S3-WROOM-1" (at 139.7 100.33 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 139.7 100.33 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "0e0e0e0e-0000-4000-8000-000000000005"))
    (pin "2" (uuid "0e0e0e0e-0000-4000-8000-000000000006"))
    (pin "3" (uuid "0e0e0e0e-0000-4000-8000-000000000007"))
    (pin "4" (uuid "0e0e0e0e-0000-4000-8000-000000000008"))
    (pin "5" (uuid "0e0e0e0e-0000-4000-8000-000000000009"))
    (pin "6" (uuid "0e0e0e0e-0000-4000-8000-00000000000a"))
    (pin "7" (uuid "0e0e0e0e-0000-4000-8000-00000000000b"))
    (pin "8" (uuid "0e0e0e0e-0000-4000-8000-00000000000c"))
    (pin "9" (uuid "0e0e0e0e-0000-4000-8000-00000000000d"))
    (pin "10" (uuid "0e0e0e0e-0000-4000-8000-00000000000e"))
    (pin "11" (uuid "0e0e0e0e-0000-4000-8000-00000000000f"))
    (pin "12" (uuid "0e0e0e0e-0000-4000-8000-000000000010"))
    (instances
      (project "pin-choice-strapping"
        (path "/0a0a0a0a-0000-4000-8000-000000000001" (reference "U1") (unit 1))
      )
    )
  )
  (sheet_instances
    (path "/" (page "1"))
  )
)
`;

  await writeCaseFiles(id, {
    manifest,
    constraints,
    specMd,
    bomMd,
    pinoutMd,
    subsystemsMd,
    schFiles: {
      'pin-choice-strapping.kicad_sch': sch,
    },
  });
}

// ============================================================================
// Case 3: add-part-second-led (AC-3.3)
// ============================================================================
async function buildCase3(): Promise<void> {
  const id = 'add-part-second-led';
  const manifest = {
    id,
    ac: 'AC-3.3',
    title: 'Add part with verified footprint and UNVERIFIED BOM row',
    description: 'Add a second RGB LED with a unique refdes, valid footprint from existing libraries, and BOM row flagged UNVERIFIED.',
    instruction: 'add a second RGB LED',
    expect: {
      outcome: 'success',
      erc: 'clean',
      commits: 1,
      filesChanged: [
        'hardware/add-part-second-led.kicad_sch',
        'docs/BOM.md',
      ],
      mustContain: {
        'docs/BOM.md': 'UNVERIFIED',
        'hardware/add-part-second-led.kicad_sch': 'D2',
      },
    },
  };

  const specMd = `# add-part-second-led — Specification

ESP32-S3 design featuring an existing RGB LED (D1) on GPIO14/18/21. Requires adding a second RGB LED for status signalling.

## Budgets

<!-- Hard budgets -->

## Assumptions

- Second LED refdes shall be D2.
- Available footprint: LED_SMD:LED_RGB_1210_3227Metric.
`;

  const bomMd = `# Bill of Materials

Every part: refdes, MPN, value, package, and WHY it was chosen. MPNs the agent
introduces without a datasheet check are flagged UNVERIFIED.

Value holds the component value only ("4.7uF", "1M", "500mAh Li-Po") — the
schematic stage draws it as the symbol's Value field, so a description there
collides with neighbouring symbols and fails the legibility gate. Prose belongs
in Rationale. One row per refdes; a grouped row ("C5-C8") matches no symbol.

| Refdes | Value | Footprint | MPN | Rationale |
|---|---|---|---|---|
| D1 | LED_RGB | LED_SMD:LED_RGB_1210_3227Metric | UNVERIFIED | Primary status RGB LED |
| R1 | 10k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | extracted from schematic by copperhead init |
| U1 | ESP32-S3-MINI | RF_Module:ESP32-S3-MINI-1 | UNVERIFIED | extracted from schematic by copperhead init |
`;

  const pinoutMd = `# Pinout

Pin assignment extracted from the schematic. Check strapping/RTC notes before
reassigning pins.

| Refdes | Pin | Name | Net | Notes |
|---|---|---|---|---|
| U1 | 1 | 3V3 | 3V3 | |
| U1 | 2 | EN | EN | |
| U1 | 3 | GPIO0 | | |
| U1 | 4 | GPIO3 | | |
| U1 | 5 | GPIO14 | LED1_R | Red channel D1 |
| U1 | 6 | GPIO18 | LED1_G | Green channel D1 |
| U1 | 7 | GPIO21 | LED1_B | Blue channel D1 |
| U1 | 8 | GND | GND | |
`;

  const subsystemsMd = `# Subsystems

Per-sheet values and reasoning (regulator, charger, RF, ...).

## Sheet /

- D1: LED_RGB (Primary user indicator)
- R1: 10k (Pullup)
- U1: ESP32-S3-MINI (Main MCU)
`;

  const sch = `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (generator_version "8.0")
  (uuid "0a0a0a0a-0000-4000-8000-000000000001")
  (paper "A4")
  (title_block
    (title "add-part-second-led")
    (date "2026-07-31")
    (rev "A")
    (comment 1 "Board with D1 RGB LED ready for adding D2")
  )
  (lib_symbols
    (symbol "Device:LED_RGB"
      (pin_numbers hide)
      (pin_names (offset 0))
      (exclude_from_sim no)
      (in_bom yes)
      (on_board yes)
      (property "Reference" "D" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
      (property "Value" "LED_RGB" (at 0 0 90) (effects (font (size 1.27 1.27))))
      (property "Footprint" "" (at -1.778 0 90) (effects (font (size 1.27 1.27)) hide))
      (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (symbol "LED_RGB_0_1"
        (rectangle (start -2.54 -5.08) (end 2.54 5.08)
          (stroke (width 0.254) (type default))
          (fill (type background))
        )
      )
      (symbol "LED_RGB_1_1"
        (pin passive line (at -5.08 3.81 0) (length 2.54)
          (name "R" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -5.08 1.27 0) (length 2.54)
          (name "G" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -5.08 -1.27 0) (length 2.54)
          (name "B" (effects (font (size 1.27 1.27))))
          (number "3" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at 5.08 0 180) (length 2.54)
          (name "COM" (effects (font (size 1.27 1.27))))
          (number "4" (effects (font (size 1.27 1.27))))
        )
      )
    )
    (symbol "Device:R"
      (pin_numbers hide)
      (pin_names (offset 0))
      (exclude_from_sim no)
      (in_bom yes)
      (on_board yes)
      (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
      (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
      (property "Footprint" "" (at -1.778 0 90) (effects (font (size 1.27 1.27)) hide))
      (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (symbol "R_0_1"
        (rectangle (start -1.016 -2.54) (end 1.016 2.54)
          (stroke (width 0.254) (type default))
          (fill (type none))
        )
      )
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27))))
        )
      )
    )
    (symbol "fixture:ESP32-S3-MINI"
      (pin_names (offset 1.016))
      (exclude_from_sim no)
      (in_bom yes)
      (on_board yes)
      (property "Reference" "U" (at 0 11.43 0) (effects (font (size 1.27 1.27))))
      (property "Value" "ESP32-S3-MINI" (at 0 -11.43 0) (effects (font (size 1.27 1.27))))
      (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (symbol "ESP32-S3-MINI_0_1"
        (rectangle (start -10.16 10.16) (end 10.16 -10.16)
          (stroke (width 0.254) (type default))
          (fill (type background))
        )
      )
      (symbol "ESP32-S3-MINI_1_1"
        (pin passive line (at -12.7 8.89 0) (length 2.54)
          (name "3V3" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 6.35 0) (length 2.54)
          (name "EN" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 3.81 0) (length 2.54)
          (name "GPIO0" (effects (font (size 1.27 1.27))))
          (number "3" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 1.27 0) (length 2.54)
          (name "GPIO3" (effects (font (size 1.27 1.27))))
          (number "4" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 -1.27 0) (length 2.54)
          (name "GPIO14" (effects (font (size 1.27 1.27))))
          (number "5" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 -3.81 0) (length 2.54)
          (name "GPIO18" (effects (font (size 1.27 1.27))))
          (number "6" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 -6.35 0) (length 2.54)
          (name "GPIO21" (effects (font (size 1.27 1.27))))
          (number "7" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 -8.89 0) (length 2.54)
          (name "GND" (effects (font (size 1.27 1.27))))
          (number "8" (effects (font (size 1.27 1.27))))
        )
      )
    )
  )
  (no_connect (at 127 96.52) (uuid "0b0b0b0b-0000-4000-8000-000000000001"))
  (no_connect (at 127 99.06) (uuid "0b0b0b0b-0000-4000-8000-000000000002"))
  (global_label "3V3" (shape input) (at 127 91.44 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000001")
  )
  (global_label "EN" (shape input) (at 127 93.98 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000002")
  )
  (global_label "LED1_R" (shape input) (at 127 101.6 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000003")
  )
  (global_label "LED1_G" (shape input) (at 127 104.14 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000004")
  )
  (global_label "LED1_B" (shape input) (at 127 106.68 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000005")
  )
  (global_label "GND" (shape input) (at 127 109.22 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000006")
  )
  (global_label "3V3" (shape input) (at 88.9 91.44 90) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify left))
    (uuid "0c0c0c0c-0000-4000-8000-000000000007")
  )
  (global_label "EN" (shape input) (at 88.9 99.06 270) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000008")
  )
  (global_label "LED1_R" (shape input) (at 165.1 96.52 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000009")
  )
  (global_label "LED1_G" (shape input) (at 165.1 99.06 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-00000000000a")
  )
  (global_label "LED1_B" (shape input) (at 165.1 101.6 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-00000000000b")
  )
  (global_label "GND" (shape input) (at 180.34 100.33 0) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify left))
    (uuid "0c0c0c0c-0000-4000-8000-00000000000c")
  )
  (symbol
    (lib_id "Device:R")
    (at 88.9 95.25 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (fields_autoplaced yes)
    (uuid "0d0d0d0d-0000-4000-8000-000000000001")
    (property "Reference" "R1" (at 91.44 94.6149 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "10k" (at 91.44 97.1549 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 87.122 95.25 90) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 88.9 95.25 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "0e0e0e0e-0000-4000-8000-000000000001"))
    (pin "2" (uuid "0e0e0e0e-0000-4000-8000-000000000002"))
    (instances
      (project "add-part-second-led"
        (path "/0a0a0a0a-0000-4000-8000-000000000001" (reference "R1") (unit 1))
      )
    )
  )
  (symbol
    (lib_id "fixture:ESP32-S3-MINI")
    (at 139.7 100.33 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (fields_autoplaced yes)
    (uuid "0d0d0d0d-0000-4000-8000-000000000003")
    (property "Reference" "U1" (at 139.7 87.96 0) (effects (font (size 1.27 1.27))))
    (property "Value" "ESP32-S3-MINI" (at 139.7 112.725 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "RF_Module:ESP32-S3-MINI-1" (at 139.7 100.33 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 139.7 100.33 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "0e0e0e0e-0000-4000-8000-000000000005"))
    (pin "2" (uuid "0e0e0e0e-0000-4000-8000-000000000006"))
    (pin "3" (uuid "0e0e0e0e-0000-4000-8000-000000000007"))
    (pin "4" (uuid "0e0e0e0e-0000-4000-8000-000000000008"))
    (pin "5" (uuid "0e0e0e0e-0000-4000-8000-000000000009"))
    (pin "6" (uuid "0e0e0e0e-0000-4000-8000-00000000000a"))
    (pin "7" (uuid "0e0e0e0e-0000-4000-8000-00000000000b"))
    (pin "8" (uuid "0e0e0e0e-0000-4000-8000-00000000000c"))
    (instances
      (project "add-part-second-led"
        (path "/0a0a0a0a-0000-4000-8000-000000000001" (reference "U1") (unit 1))
      )
    )
  )
  (symbol
    (lib_id "Device:LED_RGB")
    (at 172.72 100.33 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (fields_autoplaced yes)
    (uuid "0d0d0d0d-0000-4000-8000-000000000004")
    (property "Reference" "D1" (at 172.72 92.71 0) (effects (font (size 1.27 1.27))))
    (property "Value" "LED_RGB" (at 172.72 107.95 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "LED_SMD:LED_RGB_1210_3227Metric" (at 172.72 100.33 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 172.72 100.33 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "0e0e0e0e-0000-4000-8000-00000000000d"))
    (pin "2" (uuid "0e0e0e0e-0000-4000-8000-00000000000e"))
    (pin "3" (uuid "0e0e0e0e-0000-4000-8000-00000000000f"))
    (pin "4" (uuid "0e0e0e0e-0000-4000-8000-000000000010"))
    (instances
      (project "add-part-second-led"
        (path "/0a0a0a0a-0000-4000-8000-000000000001" (reference "D1") (unit 1))
      )
    )
  )
  (sheet_instances
    (path "/" (page "1"))
  )
)
`;

  await writeCaseFiles(id, {
    manifest,
    specMd,
    bomMd,
    pinoutMd,
    subsystemsMd,
    schFiles: {
      'add-part-second-led.kicad_sch': sch,
    },
  });
}

// ============================================================================
// Case 4: budget-refusal-pullup (AC-3.4)
// ============================================================================
async function buildCase4(): Promise<void> {
  const id = 'budget-refusal-pullup';
  const manifest = {
    id,
    ac: 'AC-3.4',
    title: 'Power budget violation refusal',
    description: 'Refuse an edit that would violate a documented sleep current budget (25 µA hard limit vs ~33 µA leakage from 100k pullup).',
    instruction: 'add a 100kΩ pullup to 3V3 on KEY_DAH',
    expect: {
      outcome: 'refused',
      treeUnchanged: true,
      commits: 0,
      refusalCitesBudget: 'sleep_current_uA',
      mustNotContain: {
        'hardware/budget-refusal-pullup.kicad_sch': '"100k"',
      },
    },
  };

  const budgets = {
    'power.sleep_current_uA': 25,
  };

  const constraints = {
    'power.sleep_current_uA': {
      max: 25,
      source: 'docs/SPEC.md#budgets',
      affects: ['KEY_DAH', 'GPIO-pullups'],
    },
  };

  const specMd = `# budget-refusal-pullup — Specification

Ultra-low-power battery-operated Morse keyer. Key paddle is normally open and grounds KEY_DAH when pressed.

## Budgets

- sleep_current_uA: 25 (hard budget; 3.3 V rail; every leakage path counts; key switch grounds KEY_DAH when closed, leaking 3.3V / R_pullup)

## Assumptions

- Internal MCU weak pullup (~45k to 100k) is disabled during sleep or uses capacitive sense.
`;

  const bomMd = `# Bill of Materials

Every part: refdes, MPN, value, package, and WHY it was chosen. MPNs the agent
introduces without a datasheet check are flagged UNVERIFIED.

Value holds the component value only ("4.7uF", "1M", "500mAh Li-Po") — the
schematic stage draws it as the symbol's Value field, so a description there
collides with neighbouring symbols and fails the legibility gate. Prose belongs
in Rationale. One row per refdes; a grouped row ("C5-C8") matches no symbol.

| Refdes | Value | Footprint | MPN | Rationale |
|---|---|---|---|---|
| R1 | 10k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | extracted from schematic by copperhead init |
| R2 | 1k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | extracted from schematic by copperhead init |
| U1 | ESP32-S3-MINI | RF_Module:ESP32-S3-MINI-1 | UNVERIFIED | extracted from schematic by copperhead init |
`;

  const pinoutMd = `# Pinout

Pin assignment extracted from the schematic. Check strapping/RTC notes before
reassigning pins.

| Refdes | Pin | Name | Net | Notes |
|---|---|---|---|---|
| U1 | 1 | 3V3 | 3V3 | |
| U1 | 2 | EN | EN | |
| U1 | 3 | GPIO0 | | |
| U1 | 4 | GPIO3 | | |
| U1 | 5 | GPIO14 | KEY_DAH | Paddle keyer input (sleep budget sensitive) |
| U1 | 6 | GPIO18 | | |
| U1 | 7 | GPIO21 | | |
| U1 | 8 | GND | GND | |
`;

  const subsystemsMd = `# Subsystems

Per-sheet values and reasoning (regulator, charger, RF, ...).

## Sheet /

- R1: 10k (Pullup)
- R2: 1k (Series protection)
- U1: ESP32-S3-MINI (MCU)
`;

  // Standard open-key schematic with KEY_DAH
  const sch = getStandardOpenKeySch('budget-refusal-pullup');

  await writeCaseFiles(id, {
    manifest,
    budgets,
    constraints,
    specMd,
    bomMd,
    pinoutMd,
    subsystemsMd,
    schFiles: {
      'budget-refusal-pullup.kicad_sch': sch,
    },
  });
}

// ============================================================================
// Case 5: repair-loop (AC-3.5)
// ============================================================================
async function buildCase5(): Promise<void> {
  const id = 'repair-loop';
  const manifest = {
    id,
    ac: 'AC-3.5',
    title: 'Repair loop recovery on ERC violation',
    description: 'Exercise the ERC violation parse-and-repair cycle where a proposed edit initially triggers an ERC violation and is repaired within maxRepairCycles.',
    instruction: 'add a 10k pull-down resistor R3 on GPIO21 to GND',
    expect: {
      outcome: 'success',
      erc: 'clean',
      commits: 1,
      repairCycles: {
        min: 1,
        max: 5,
      },
      filesChanged: [
        'hardware/repair-loop.kicad_sch',
        'docs/BOM.md',
      ],
      mustContain: {
        'docs/BOM.md': 'R3',
        'hardware/repair-loop.kicad_sch': 'R3',
      },
    },
  };

  const specMd = `# repair-loop — Specification

Fixture designed to exercise the agent's iterative repair loop when an initial edit produces an ERC violation.

## Budgets

<!-- Hard budgets -->

## Assumptions

- GPIO21 is available for pull-down termination.
`;

  const bomMd = `# Bill of Materials

Every part: refdes, MPN, value, package, and WHY it was chosen. MPNs the agent
introduces without a datasheet check are flagged UNVERIFIED.

Value holds the component value only ("4.7uF", "1M", "500mAh Li-Po") — the
schematic stage draws it as the symbol's Value field, so a description there
collides with neighbouring symbols and fails the legibility gate. Prose belongs
in Rationale. One row per refdes; a grouped row ("C5-C8") matches no symbol.

| Refdes | Value | Footprint | MPN | Rationale |
|---|---|---|---|---|
| R1 | 10k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | extracted from schematic by copperhead init |
| R2 | 1k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | extracted from schematic by copperhead init |
| U1 | ESP32-S3-MINI | RF_Module:ESP32-S3-MINI-1 | UNVERIFIED | extracted from schematic by copperhead init |
`;

  const pinoutMd = `# Pinout

Pin assignment extracted from the schematic. Check strapping/RTC notes before
reassigning pins.

| Refdes | Pin | Name | Net | Notes |
|---|---|---|---|---|
| U1 | 1 | 3V3 | 3V3 | |
| U1 | 2 | EN | EN | |
| U1 | 3 | GPIO0 | | |
| U1 | 4 | GPIO3 | | |
| U1 | 5 | GPIO14 | KEY_DAH | |
| U1 | 6 | GPIO18 | | |
| U1 | 7 | GPIO21 | | Target pin for pulldown |
| U1 | 8 | GND | GND | |
`;

  const subsystemsMd = `# Subsystems

Per-sheet values and reasoning (regulator, charger, RF, ...).

## Sheet /

- R1: 10k (Pullup)
- R2: 1k (Series protection)
- U1: ESP32-S3-MINI (MCU)
`;

  const sch = getStandardOpenKeySch('repair-loop');

  await writeCaseFiles(id, {
    manifest,
    specMd,
    bomMd,
    pinoutMd,
    subsystemsMd,
    schFiles: {
      'repair-loop.kicad_sch': sch,
    },
  });
}

// ============================================================================
// Case 6: rollback (AC-3.6)
// ============================================================================
async function buildCase6(): Promise<void> {
  const id = 'rollback';
  const manifest = {
    id,
    ac: 'AC-3.6',
    title: 'Rollback on unresolvable verification failure',
    description: 'Restore the working tree to a byte-identical state when an edit cannot be repaired within maxRepairCycles.',
    instruction: 'short the 3V3 rail directly into GND with a net alias',
    expect: {
      outcome: 'failure',
      treeUnchanged: true,
      commits: 0,
      filesChanged: [],
    },
  };

  const specMd = `# rollback — Specification

Fixture designed to verify complete rollback to a byte-identical git working tree when an edit repeatedly fails verification.

## Budgets

<!-- Hard budgets -->

## Assumptions

- 3V3 and GND power rails must never be shorted together.
`;

  const bomMd = `# Bill of Materials

Every part: refdes, MPN, value, package, and WHY it was chosen. MPNs the agent
introduces without a datasheet check are flagged UNVERIFIED.

Value holds the component value only ("4.7uF", "1M", "500mAh Li-Po") — the
schematic stage draws it as the symbol's Value field, so a description there
collides with neighbouring symbols and fails the legibility gate. Prose belongs
in Rationale. One row per refdes; a grouped row ("C5-C8") matches no symbol.

| Refdes | Value | Footprint | MPN | Rationale |
|---|---|---|---|---|
| R1 | 10k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | extracted from schematic by copperhead init |
| R2 | 1k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | extracted from schematic by copperhead init |
| U1 | ESP32-S3-MINI | RF_Module:ESP32-S3-MINI-1 | UNVERIFIED | extracted from schematic by copperhead init |
`;

  const pinoutMd = `# Pinout

Pin assignment extracted from the schematic. Check strapping/RTC notes before
reassigning pins.

| Refdes | Pin | Name | Net | Notes |
|---|---|---|---|---|
| U1 | 1 | 3V3 | 3V3 | |
| U1 | 2 | EN | EN | |
| U1 | 3 | GPIO0 | | |
| U1 | 4 | GPIO3 | | |
| U1 | 5 | GPIO14 | KEY_DAH | |
| U1 | 6 | GPIO18 | | |
| U1 | 7 | GPIO21 | | |
| U1 | 8 | GND | GND | |
`;

  const subsystemsMd = `# Subsystems

Per-sheet values and reasoning (regulator, charger, RF, ...).

## Sheet /

- R1: 10k (Pullup)
- R2: 1k (Series protection)
- U1: ESP32-S3-MINI (MCU)
`;

  const sch = getStandardOpenKeySch('rollback');

  await writeCaseFiles(id, {
    manifest,
    specMd,
    bomMd,
    pinoutMd,
    subsystemsMd,
    schFiles: {
      'rollback.kicad_sch': sch,
    },
  });
}

function getStandardOpenKeySch(projectName: string): string {
  return `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (generator_version "8.0")
  (uuid "0a0a0a0a-0000-4000-8000-000000000001")
  (paper "A4")
  (title_block
    (title "${projectName}")
    (date "2026-07-31")
    (rev "A")
    (comment 1 "Standard fixture schematic")
  )
  (lib_symbols
    (symbol "Device:R"
      (pin_numbers hide)
      (pin_names (offset 0))
      (exclude_from_sim no)
      (in_bom yes)
      (on_board yes)
      (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
      (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
      (property "Footprint" "" (at -1.778 0 90) (effects (font (size 1.27 1.27)) hide))
      (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (symbol "R_0_1"
        (rectangle (start -1.016 -2.54) (end 1.016 2.54)
          (stroke (width 0.254) (type default))
          (fill (type none))
        )
      )
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27))))
        )
      )
    )
    (symbol "fixture:ESP32-S3-MINI"
      (pin_names (offset 1.016))
      (exclude_from_sim no)
      (in_bom yes)
      (on_board yes)
      (property "Reference" "U" (at 0 11.43 0) (effects (font (size 1.27 1.27))))
      (property "Value" "ESP32-S3-MINI" (at 0 -11.43 0) (effects (font (size 1.27 1.27))))
      (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (symbol "ESP32-S3-MINI_0_1"
        (rectangle (start -10.16 10.16) (end 10.16 -10.16)
          (stroke (width 0.254) (type default))
          (fill (type background))
        )
      )
      (symbol "ESP32-S3-MINI_1_1"
        (pin passive line (at -12.7 8.89 0) (length 2.54)
          (name "3V3" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 6.35 0) (length 2.54)
          (name "EN" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 3.81 0) (length 2.54)
          (name "GPIO0" (effects (font (size 1.27 1.27))))
          (number "3" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 1.27 0) (length 2.54)
          (name "GPIO3" (effects (font (size 1.27 1.27))))
          (number "4" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 -1.27 0) (length 2.54)
          (name "GPIO14" (effects (font (size 1.27 1.27))))
          (number "5" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 -3.81 0) (length 2.54)
          (name "GPIO18" (effects (font (size 1.27 1.27))))
          (number "6" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 -6.35 0) (length 2.54)
          (name "GPIO21" (effects (font (size 1.27 1.27))))
          (number "7" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at -12.7 -8.89 0) (length 2.54)
          (name "GND" (effects (font (size 1.27 1.27))))
          (number "8" (effects (font (size 1.27 1.27))))
        )
      )
    )
  )
  (no_connect (at 127 96.52) (uuid "0b0b0b0b-0000-4000-8000-000000000001"))
  (no_connect (at 127 99.06) (uuid "0b0b0b0b-0000-4000-8000-000000000002"))
  (no_connect (at 127 104.14) (uuid "0b0b0b0b-0000-4000-8000-000000000003"))
  (no_connect (at 127 106.68) (uuid "0b0b0b0b-0000-4000-8000-000000000004"))
  (rectangle (start 76 84) (end 160 120)
    (stroke (width 0.152) (type solid))
    (fill (type none))
    (uuid "0f0f0f0f-0000-4000-8000-00000000r001")
  )
  (text "Keyer" (at 81 87.5 0)
    (effects (font (size 2 2)))
    (uuid "0f0f0f0f-0000-4000-8000-00000000t001")
  )
  (global_label "3V3" (shape input) (at 127 91.44 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000001")
    (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 118.4864 91.0286 0)
      (effects (font (size 1.27 1.27)) (justify right) hide)
    )
  )
  (global_label "EN" (shape input) (at 127 93.98 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000002")
    (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 119.8536 93.5686 0)
      (effects (font (size 1.27 1.27)) (justify right) hide)
    )
  )
  (global_label "KEY_DAH" (shape input) (at 127 101.6 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000003")
    (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 115.1014 101.1886 0)
      (effects (font (size 1.27 1.27)) (justify right) hide)
    )
  )
  (global_label "GND" (shape input) (at 127 109.22 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000004")
    (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 119.2536 108.8086 0)
      (effects (font (size 1.27 1.27)) (justify right) hide)
    )
  )
  (global_label "3V3" (shape input) (at 88.9 91.44 90) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify left))
    (uuid "0c0c0c0c-0000-4000-8000-000000000005")
    (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 88.9814 87.0964 90)
      (effects (font (size 1.27 1.27)) (justify left) hide)
    )
  )
  (global_label "EN" (shape input) (at 88.9 99.06 270) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000006")
    (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 88.9814 103.4036 270)
      (effects (font (size 1.27 1.27)) (justify right) hide)
    )
  )
  (global_label "KEY_DAH" (shape input) (at 96.52 106.68 90) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify left))
    (uuid "0c0c0c0c-0000-4000-8000-000000000007")
    (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 96.6014 102.3364 90)
      (effects (font (size 1.27 1.27)) (justify left) hide)
    )
  )
  (global_label "GND" (shape input) (at 96.52 114.3 270) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000008")
    (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 96.6014 118.6436 270)
      (effects (font (size 1.27 1.27)) (justify right) hide)
    )
  )
  (symbol
    (lib_id "Device:R")
    (at 88.9 95.25 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (fields_autoplaced yes)
    (uuid "0d0d0d0d-0000-4000-8000-000000000001")
    (property "Reference" "R1" (at 91.44 94.6149 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "10k" (at 91.44 97.1549 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 87.122 95.25 90) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 88.9 95.25 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "0e0e0e0e-0000-4000-8000-000000000001"))
    (pin "2" (uuid "0e0e0e0e-0000-4000-8000-000000000002"))
    (instances
      (project "${projectName}"
        (path "/0a0a0a0a-0000-4000-8000-000000000001" (reference "R1") (unit 1))
      )
    )
  )
  (symbol
    (lib_id "Device:R")
    (at 96.52 110.49 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (fields_autoplaced yes)
    (uuid "0d0d0d0d-0000-4000-8000-000000000002")
    (property "Reference" "R2" (at 99.06 109.8549 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "1k" (at 99.06 112.3949 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 94.742 110.49 90) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 96.52 110.49 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "0e0e0e0e-0000-4000-8000-000000000003"))
    (pin "2" (uuid "0e0e0e0e-0000-4000-8000-000000000004"))
    (instances
      (project "${projectName}"
        (path "/0a0a0a0a-0000-4000-8000-000000000001" (reference "R2") (unit 1))
      )
    )
  )
  (symbol
    (lib_id "fixture:ESP32-S3-MINI")
    (at 139.7 100.33 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (fields_autoplaced yes)
    (uuid "0d0d0d0d-0000-4000-8000-000000000003")
    (property "Reference" "U1" (at 139.7 87.96 0) (effects (font (size 1.27 1.27))))
    (property "Value" "ESP32-S3-MINI" (at 139.7 112.725 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "RF_Module:ESP32-S3-MINI-1" (at 139.7 100.33 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 139.7 100.33 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "0e0e0e0e-0000-4000-8000-000000000005"))
    (pin "2" (uuid "0e0e0e0e-0000-4000-8000-000000000006"))
    (pin "3" (uuid "0e0e0e0e-0000-4000-8000-000000000007"))
    (pin "4" (uuid "0e0e0e0e-0000-4000-8000-000000000008"))
    (pin "5" (uuid "0e0e0e0e-0000-4000-8000-000000000009"))
    (pin "6" (uuid "0e0e0e0e-0000-4000-8000-00000000000a"))
    (pin "7" (uuid "0e0e0e0e-0000-4000-8000-00000000000b"))
    (pin "8" (uuid "0e0e0e0e-0000-4000-8000-00000000000c"))
    (instances
      (project "${projectName}"
        (path "/0a0a0a0a-0000-4000-8000-000000000001" (reference "U1") (unit 1))
      )
    )
  )
  (sheet_instances
    (path "/" (page "1"))
  )
)
`;
}

function buildReadme(): string {
  return `# Edit-Verification Fixtures (AC-3.x)

This dataset provides self-contained, ERC- and DRC-clean "before" KiCad projects paired with a \`manifest.json\` specifying the exact natural language edit instruction and assertions for \`copperhead do\`.

These fixtures enable repeatable, automated verification of the core agent loop across acceptance criteria AC-3.1 through AC-3.6 without requiring an active LLM API key during fixture inspection and static validation.

## Fixture Catalog

| ID | Acceptance Criterion | Title | Primary Proof / Purpose |
|---|---|---|---|
| [\`rename-net-cross-sheet\`](rename-net-cross-sheet/) | AC-3.1 | Cross-sheet net rename | Proves propagating net rename across multi-sheet schematics and design docs (\`PINOUT.md\`, \`SUBSYSTEMS.md\`) with a surgical diff (< 5% lines changed). |
| [\`pin-choice-strapping\`](pin-choice-strapping/) | AC-3.2 | Constraint-aware pin selection | Proves reasoning over MCU constraints: selecting an RTC-capable GPIO while avoiding ESP32-S3 strapping pins (GPIO0, GPIO3, GPIO45, GPIO46). |
| [\`add-part-second-led\`](add-part-second-led/) | AC-3.3 | Add component with verified footprint | Proves adding a new component (RGB LED) with unique refdes, valid library footprint, net hookup, and \`UNVERIFIED\` row added to \`BOM.md\`. |
| [\`budget-refusal-pullup\`](budget-refusal-pullup/) | AC-3.4 | Power budget refusal | Proves that the agent refuses an edit (or offers an alternative) when adding a 100kΩ pullup would violate the 25 µA sleep current budget in \`SPEC.md\`. |
| [\`repair-loop\`](repair-loop/) | AC-3.5 | ERC repair cycle | Proves parsing and targeted repair of an initial ERC violation within \`maxRepairCycles\`. |
| [\`rollback\`](rollback/) | AC-3.6 | Working tree rollback | Proves that unresolvable violations restore the working tree to a byte-identical snapshot (\`git status\` clean, exit non-zero). |

## Manifest Schema

Each fixture contains a \`manifest.json\` defining the post-edit expectations:

\`\`\`json
{
  "id": "rename-net-cross-sheet",
  "ac": "AC-3.1",
  "title": "Cross-sheet net rename",
  "description": "Propagate net rename across multiple schematic sheets...",
  "instruction": "rename net KEY_DAH to KEY_DASH",
  "expect": {
    "outcome": "success",
    "erc": "clean",
    "commits": 1,
    "filesChanged": [
      "hardware/rename-net-cross-sheet.kicad_sch",
      "hardware/keyer.kicad_sch",
      "docs/PINOUT.md",
      "docs/SUBSYSTEMS.md"
    ],
    "maxSchLinesChangedPct": 5,
    "mustContain": {
      "docs/PINOUT.md": "KEY_DASH"
    },
    "mustNotContain": {
      "docs/PINOUT.md": "KEY_DAH"
    }
  }
}
\`\`\`

## Fixture Structure

Each fixture directory under \`test/fixtures/edits/<id>/\` is a fully standalone KiCad repository:

\`\`\`text
<id>/
├── manifest.json
├── .copperhead/
│   ├── config.json
│   └── constraints.json
├── docs/
│   ├── SPEC.md
│   ├── BOM.md
│   ├── PINOUT.md
│   ├── SUBSYSTEMS.md
│   ├── LAYOUT.md
│   ├── DECISIONS.md
│   └── CHANGELOG.md
└── hardware/
    ├── <id>.kicad_pro
    ├── <id>.kicad_prl
    ├── <id>.kicad_pcb
    └── <id>.kicad_sch
\`\`\`
`;
}

async function main(): Promise<void> {
  console.log('Generating edit fixtures in', EDITS_DIR);
  await mkdir(EDITS_DIR, { recursive: true });

  await buildCase1();
  console.log('Created case 1: rename-net-cross-sheet');

  await buildCase2();
  console.log('Created case 2: pin-choice-strapping');

  await buildCase3();
  console.log('Created case 3: add-part-second-led');

  await buildCase4();
  console.log('Created case 4: budget-refusal-pullup');

  await buildCase5();
  console.log('Created case 5: repair-loop');

  await buildCase6();
  console.log('Created case 6: rollback');

  await writeFile(path.join(EDITS_DIR, 'README.md'), buildReadme(), 'utf8');
  console.log('Wrote README.md');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
