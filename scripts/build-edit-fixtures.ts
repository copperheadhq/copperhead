import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let EDITS_DIR = path.join(ROOT, 'test', 'fixtures', 'edits');

function uuidHex(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

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
        zone_display_mode: 0,
      },
      meta: {
        filename,
        version: 3,
      },
      schematic: {
        current_sheet: '',
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
    (40 "User.Drawings" user)
    (41 "User.Comments" user)
    (42 "User.Eco1" user)
    (43 "User.Eco2" user)
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
    (pcbplotparams
      (layerselection 0x00010fc_ffffffff)
      (plot_on_all_layers_selection 0x0000000_00000000)
      (disableapertmacros no)
      (usegerberextensions no)
      (usegerberattributes yes)
      (usegerberadvancedattributes yes)
      (creategerberjobfile yes)
      (dashed_line_dash_ratio 12.000000)
      (dashed_line_gap_ratio 3.000000)
      (svgprecision 4)
      (plotframeref no)
      (viasonmask no)
      (mode 1)
      (useauxorigin no)
      (hpglpennumber 1)
      (hpglpenspeed 20)
      (hpglpendiameter 15.000000)
      (pdf_front_fp_property_popups yes)
      (pdf_back_fp_property_popups yes)
      (dxfpolygonmode yes)
      (dxfimperialunits yes)
      (dxfcontourdxfunit 0)
      (outputdirectory "")
    )
  )
  (gr_rect (start 50 50) (end 150 120)
    (stroke (width 0.15) (type default))
    (fill (type none))
    (layer "Edge.Cuts")
    (uuid "${uuid}")
  )
)
`;
}

function configJsonContent(id: string, budgets: Record<string, number> = {}): string {
  const config: Record<string, unknown> = {
    schema_version: 1,
    schematic: `hardware/${id}.kicad_sch`,
    board: `hardware/${id}.kicad_pcb`,
    docs: 'docs',
    budgets,
  };
  return JSON.stringify(config, null, 2) + '\n';
}

function decisionsMdContent(): string {
  return `# Architectural Decisions

Record significant architectural decisions here.

- ADR-001: Initial baseline architecture for edit verification fixture.
`;
}

function changelogMdContent(): string {
  return `# Changelog

- Baseline initial revision for edit verification fixture.
`;
}

function layoutMdContent(): string {
  return `# Layout Constraints

Physical layout constraints and stackup details.

- 2-layer standard FR-4 stackup (1.6mm thickness).
- Outline rectangle defined on Edge.Cuts (100mm x 70mm).
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
    kicadPcbContent(uuidHex(`${id}:pcb`)),
    'utf8',
  );

  for (const [schName, content] of Object.entries(files.schFiles)) {
    await writeFile(path.join(dir, 'hardware', schName), content, 'utf8');
  }
}

// ----------------------------------------------------------------------------
// Reusable Symbol Definitions
// ----------------------------------------------------------------------------

const R_SYM = `    (symbol "Device:R"
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
    )`;

const PWR_FLAG_SYM = `    (symbol "power:PWR_FLAG"
      (power)
      (pin_numbers hide)
      (pin_names (offset 0) hide)
      (exclude_from_sim no)
      (in_bom yes)
      (on_board yes)
      (property "Reference" "#FLG" (at 0 1.905 0) (effects (font (size 1.27 1.27)) hide))
      (property "Value" "PWR_FLAG" (at 0 3.81 0) (effects (font (size 1.27 1.27))))
      (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (symbol "PWR_FLAG_0_0"
        (polyline
          (pts (xy 0 0) (xy 0 1.27))
          (stroke (width 0) (type default))
          (fill (type none))
        )
      )
      (symbol "PWR_FLAG_0_1"
        (polyline
          (pts (xy 0 1.27) (xy -0.762 1.905) (xy 0 2.54) (xy 0.762 1.905) (xy 0 1.27))
          (stroke (width 0) (type default))
          (fill (type none))
        )
      )
      (symbol "PWR_FLAG_1_1"
        (pin power_out line (at 0 0 90) (length 0) hide
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))
        )
      )
    )`;

const ESP32_S3_MINI_SYM = `    (symbol "fixture:ESP32-S3-MINI"
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
    )`;

const ESP32_S3_WROOM_1_SYM = `(symbol "RF_Module:ESP32-S3-WROOM-1"
		(exclude_from_sim no)
		(in_bom yes)
		(on_board yes)
		(in_pos_files yes)
		(duplicate_pin_numbers_are_jumpers no)
		(property "Reference" "U"
			(at -12.7 26.67 0)
			(show_name no)
			(do_not_autoplace no)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "Value" "ESP32-S3-WROOM-1"
			(at 12.7 26.67 0)
			(show_name no)
			(do_not_autoplace no)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "Footprint" "RF_Module:ESP32-S3-WROOM-1"
			(at 0 2.54 0)
			(show_name no)
			(do_not_autoplace no)
			(hide yes)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "Datasheet" "https://www.espressif.com/sites/default/files/documentation/esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf"
			(at 0 0 0)
			(show_name no)
			(do_not_autoplace no)
			(hide yes)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "Description" "RF Module, ESP32-S3 SoC, Wi-Fi 802.11b/g/n, Bluetooth, BLE, 32-bit, 3.3V, onboard antenna, SMD"
			(at 0 0 0)
			(show_name no)
			(do_not_autoplace no)
			(hide yes)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "ki_keywords" "RF Radio BT ESP ESP32-S3 Espressif onboard PCB antenna"
			(at 0 0 0)
			(show_name no)
			(do_not_autoplace no)
			(hide yes)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "ki_fp_filters" "ESP32?S3?WROOM?1*"
			(at 0 0 0)
			(show_name no)
			(do_not_autoplace no)
			(hide yes)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(symbol "ESP32-S3-WROOM-1_0_0"
			(rectangle
				(start -12.7 25.4)
				(end 12.7 -25.4)
				(stroke
					(width 0.254)
					(type default)
				)
				(fill
					(type background)
				)
			)
			(text "PSRAM"
				(at 5.08 2.54 900)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
		)
		(symbol "ESP32-S3-WROOM-1_0_1"
			(polyline
				(pts
					(xy 7.62 -1.27) (xy 6.35 -1.27) (xy 6.35 6.35) (xy 7.62 6.35)
				)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
		)
		(symbol "ESP32-S3-WROOM-1_1_1"
			(pin power_in line
				(at 0 -27.94 90)
				(length 2.54)
				(name "GND"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "1"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin power_in line
				(at 0 27.94 270)
				(length 2.54)
				(name "3V3"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "2"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin input line
				(at -15.24 22.86 0)
				(length 2.54)
				(name "EN"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "3"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at -15.24 7.62 0)
				(length 2.54)
				(name "IO4"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "4"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at -15.24 5.08 0)
				(length 2.54)
				(name "IO5"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "5"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at -15.24 2.54 0)
				(length 2.54)
				(name "IO6"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "6"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at -15.24 0 0)
				(length 2.54)
				(name "IO7"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "7"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at -15.24 -20.32 0)
				(length 2.54)
				(name "IO15"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "8"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at -15.24 -22.86 0)
				(length 2.54)
				(name "IO16"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "9"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at 15.24 17.78 180)
				(length 2.54)
				(name "IO17"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "10"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at 15.24 15.24 180)
				(length 2.54)
				(name "IO18"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "11"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at -15.24 -2.54 0)
				(length 2.54)
				(name "IO8"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "12"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at 15.24 12.7 180)
				(length 2.54)
				(name "USB_D-"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "13"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(alternate "IO19" bidirectional line)
			)
			(pin bidirectional line
				(at 15.24 10.16 180)
				(length 2.54)
				(name "USB_D+"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "14"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(alternate "IO20" bidirectional line)
			)
			(pin bidirectional line
				(at -15.24 10.16 0)
				(length 2.54)
				(name "IO3"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "15"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at 15.24 -17.78 180)
				(length 2.54)
				(name "IO46"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "16"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at -15.24 -5.08 0)
				(length 2.54)
				(name "IO9"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "17"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at -15.24 -7.62 0)
				(length 2.54)
				(name "IO10"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "18"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at -15.24 -10.16 0)
				(length 2.54)
				(name "IO11"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "19"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at -15.24 -12.7 0)
				(length 2.54)
				(name "IO12"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "20"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at -15.24 -15.24 0)
				(length 2.54)
				(name "IO13"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "21"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at -15.24 -17.78 0)
				(length 2.54)
				(name "IO14"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "22"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at 15.24 7.62 180)
				(length 2.54)
				(name "IO21"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "23"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at 15.24 -20.32 180)
				(length 2.54)
				(name "IO47"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "24"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at 15.24 -22.86 180)
				(length 2.54)
				(name "IO48"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "25"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at 15.24 -15.24 180)
				(length 2.54)
				(name "IO45"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "26"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at -15.24 17.78 0)
				(length 2.54)
				(name "IO0"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "27"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at 15.24 5.08 180)
				(length 2.54)
				(name "IO35"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "28"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at 15.24 2.54 180)
				(length 2.54)
				(name "IO36"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "29"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at 15.24 0 180)
				(length 2.54)
				(name "IO37"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "30"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at 15.24 -2.54 180)
				(length 2.54)
				(name "IO38"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "31"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at 15.24 -5.08 180)
				(length 2.54)
				(name "IO39"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "32"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at 15.24 -7.62 180)
				(length 2.54)
				(name "IO40"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "33"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at 15.24 -10.16 180)
				(length 2.54)
				(name "IO41"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "34"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at 15.24 -12.7 180)
				(length 2.54)
				(name "IO42"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "35"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at 15.24 20.32 180)
				(length 2.54)
				(name "RXD0"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "36"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at 15.24 22.86 180)
				(length 2.54)
				(name "TXD0"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "37"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at -15.24 12.7 0)
				(length 2.54)
				(name "IO2"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "38"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin bidirectional line
				(at -15.24 15.24 0)
				(length 2.54)
				(name "IO1"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "39"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin passive line
				(at 0 -27.94 90)
				(length 2.54)
				(hide yes)
				(name "GND"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "40"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin passive line
				(at 0 -27.94 90)
				(length 2.54)
				(hide yes)
				(name "GND"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "41"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
		)
		(embedded_fonts no)
	)`;
const LED_RGBK_SYM = `(symbol "Device:LED_RGBK"
		(pin_names
			(offset 0)
			(hide yes)
		)
		(exclude_from_sim no)
		(in_bom yes)
		(on_board yes)
		(in_pos_files yes)
		(duplicate_pin_numbers_are_jumpers no)
		(property "Reference" "D"
			(at 0 9.398 0)
			(show_name no)
			(do_not_autoplace no)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "Value" "LED_RGBK"
			(at 0 -8.89 0)
			(show_name no)
			(do_not_autoplace no)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "Footprint" ""
			(at 0 -1.27 0)
			(show_name no)
			(do_not_autoplace no)
			(hide yes)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "Datasheet" ""
			(at 0 -1.27 0)
			(show_name no)
			(do_not_autoplace no)
			(hide yes)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "Description" "RGB LED, red/green/blue/cathode"
			(at 0 0 0)
			(show_name no)
			(do_not_autoplace no)
			(hide yes)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "ki_keywords" "LED RGB diode"
			(at 0 0 0)
			(show_name no)
			(do_not_autoplace no)
			(hide yes)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "ki_fp_filters" "LED* LED_SMD:* LED_THT:*"
			(at 0 0 0)
			(show_name no)
			(do_not_autoplace no)
			(hide yes)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(symbol "LED_RGBK_0_0"
			(text "R"
				(at 1.905 3.81 0)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(text "G"
				(at 1.905 -1.27 0)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
			(text "B"
				(at 1.905 -6.35 0)
				(effects
					(font
						(size 1.27 1.27)
					)
				)
			)
		)
		(symbol "LED_RGBK_0_1"
			(circle
				(center -2.032 0)
				(radius 0.254)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type outline)
				)
			)
			(polyline
				(pts
					(xy -1.27 6.35) (xy -1.27 3.81)
				)
				(stroke
					(width 0.254)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(polyline
				(pts
					(xy -1.27 6.35) (xy -1.27 3.81) (xy -1.27 3.81)
				)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(polyline
				(pts
					(xy -1.27 5.08) (xy 1.27 5.08)
				)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(polyline
				(pts
					(xy -1.27 5.08) (xy -2.032 5.08) (xy -2.032 -5.08) (xy -1.016 -5.08)
				)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(polyline
				(pts
					(xy -1.27 1.27) (xy -1.27 -1.27)
				)
				(stroke
					(width 0.254)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(polyline
				(pts
					(xy -1.27 1.27) (xy -1.27 -1.27) (xy -1.27 -1.27)
				)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(polyline
				(pts
					(xy -1.27 0) (xy -2.54 0)
				)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(polyline
				(pts
					(xy -1.27 -3.81) (xy -1.27 -6.35)
				)
				(stroke
					(width 0.254)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(polyline
				(pts
					(xy -1.27 -5.08) (xy 1.27 -5.08)
				)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(polyline
				(pts
					(xy -1.016 6.35) (xy 0.508 7.874) (xy -0.254 7.874) (xy 0.508 7.874) (xy 0.508 7.112)
				)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(polyline
				(pts
					(xy -1.016 1.27) (xy 0.508 2.794) (xy -0.254 2.794) (xy 0.508 2.794) (xy 0.508 2.032)
				)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(polyline
				(pts
					(xy -1.016 -3.81) (xy 0.508 -2.286) (xy -0.254 -2.286) (xy 0.508 -2.286) (xy 0.508 -3.048)
				)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(polyline
				(pts
					(xy 0 6.35) (xy 1.524 7.874) (xy 0.762 7.874) (xy 1.524 7.874) (xy 1.524 7.112)
				)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(polyline
				(pts
					(xy 0 1.27) (xy 1.524 2.794) (xy 0.762 2.794) (xy 1.524 2.794) (xy 1.524 2.032)
				)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(polyline
				(pts
					(xy 0 -3.81) (xy 1.524 -2.286) (xy 0.762 -2.286) (xy 1.524 -2.286) (xy 1.524 -3.048)
				)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(polyline
				(pts
					(xy 1.27 6.35) (xy 1.27 3.81) (xy -1.27 5.08) (xy 1.27 6.35)
				)
				(stroke
					(width 0.254)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(rectangle
				(start 1.27 6.35)
				(end 1.27 6.35)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(polyline
				(pts
					(xy 1.27 5.08) (xy 2.54 5.08)
				)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(rectangle
				(start 1.27 3.81)
				(end 1.27 6.35)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(polyline
				(pts
					(xy 1.27 1.27) (xy 1.27 -1.27) (xy -1.27 0) (xy 1.27 1.27)
				)
				(stroke
					(width 0.254)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(rectangle
				(start 1.27 1.27)
				(end 1.27 1.27)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(polyline
				(pts
					(xy 1.27 0) (xy -1.27 0)
				)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(polyline
				(pts
					(xy 1.27 0) (xy 2.54 0)
				)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(rectangle
				(start 1.27 -1.27)
				(end 1.27 1.27)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(polyline
				(pts
					(xy 1.27 -3.81) (xy 1.27 -6.35) (xy -1.27 -5.08) (xy 1.27 -3.81)
				)
				(stroke
					(width 0.254)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(polyline
				(pts
					(xy 1.27 -5.08) (xy 2.54 -5.08)
				)
				(stroke
					(width 0)
					(type default)
				)
				(fill
					(type none)
				)
			)
			(rectangle
				(start 2.794 8.382)
				(end -2.794 -7.62)
				(stroke
					(width 0.254)
					(type default)
				)
				(fill
					(type background)
				)
			)
		)
		(symbol "LED_RGBK_1_1"
			(pin passive line
				(at 5.08 5.08 180)
				(length 2.54)
				(name "RA"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "1"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin passive line
				(at 5.08 0 180)
				(length 2.54)
				(name "GA"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "2"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin passive line
				(at 5.08 -5.08 180)
				(length 2.54)
				(name "BA"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "3"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
			(pin passive line
				(at -5.08 0 0)
				(length 2.54)
				(name "K"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
				(number "4"
					(effects
						(font
							(size 1.27 1.27)
						)
					)
				)
			)
		)
		(embedded_fonts no)
	)`;

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
      filesChanged: {
        mustChange: [
          'hardware/rename-net-cross-sheet.kicad_sch',
          'hardware/keyer.kicad_sch',
          'docs/PINOUT.md',
          'docs/SUBSYSTEMS.md',
        ],
        mayChange: [
          'openspec/changes/**',
          'docs/CHANGELOG.md',
          'docs/DECISIONS.md',
        ],
      },
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

Morse keyer design with hierarchical multi-sheet schematic architecture. Net KEY_DAH connects U1 on the root sheet to R2 on the Keyer sub-sheet.

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

- U1: ESP32-S3-MINI (Main controller)

## Sheet /Keyer/

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
    (title "rename-net-cross-sheet")
    (date "2026-07-31")
    (rev "A")
    (comment 1 "Hierarchical schematic root sheet")
  )
  (lib_symbols
${ESP32_S3_MINI_SYM}
  )
  (no_connect (at 127 96.52) (uuid "0b0b0b0b-0000-4000-8000-000000000001"))
  (no_connect (at 127 99.06) (uuid "0b0b0b0b-0000-4000-8000-000000000002"))
  (no_connect (at 127 104.14) (uuid "0b0b0b0b-0000-4000-8000-000000000003"))
  (no_connect (at 127 106.68) (uuid "0b0b0b0b-0000-4000-8000-000000000004"))
  (global_label "3V3" (shape input) (at 127 91.44 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000001")
  )
  (global_label "EN" (shape input) (at 127 93.98 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000002")
  )
  (global_label "KEY_DAH" (shape input) (at 127 101.6 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000003")
  )
  (global_label "GND" (shape input) (at 127 109.22 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000004")
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
    (uuid "0d0d0d0d-0000-4000-8000-000000000001")
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
    (uuid "0f0f0f0f-0000-4000-8000-000000000002")
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

  const keyerSch = `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (generator_version "8.0")
  (uuid "0b0b0b0b-0000-4000-8000-000000000001")
  (paper "A4")
  (title_block
    (title "Keyer Subsheet")
    (date "2026-07-31")
    (rev "A")
    (comment 1 "Hierarchical subsheet for morse key inputs")
  )
  (lib_symbols
${R_SYM}
  )
  (global_label "3V3" (shape input) (at 88.9 91.44 90) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify left))
    (uuid "0c0c0c0c-0000-4000-8000-000000000005")
  )
  (global_label "EN" (shape input) (at 88.9 99.06 270) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000006")
  )
  (global_label "KEY_DAH" (shape input) (at 96.52 106.68 90) (fields_autoplaced yes)
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
        (path "/0a0a0a0a-0000-4000-8000-000000000001/0f0f0f0f-0000-4000-8000-000000000002"
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
        (path "/0a0a0a0a-0000-4000-8000-000000000001/0f0f0f0f-0000-4000-8000-000000000002"
          (reference "R2") (unit 1)
        )
      )
    )
  )
  (sheet_instances
    (path "/0f0f0f0f-0000-4000-8000-000000000002" (page "2"))
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
      'keyer.kicad_sch': keyerSch,
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
    instruction: 'move the key input to an RTC-capable pin while avoiding strapping pins',
    expect: {
      outcome: 'success',
      erc: 'clean',
      commits: 1,
      check: 'ok',
      filesChanged: {
        mustChange: [
          'hardware/pin-choice-strapping.kicad_sch',
          'docs/PINOUT.md',
        ],
        mayChange: [
          'openspec/changes/**',
          'docs/CHANGELOG.md',
          'docs/DECISIONS.md',
        ],
      },
      mustMatch: {
        'docs/PINOUT.md': '\\\\| (?:U1 \\\\| )?\\\\d+ \\\\| (?:GPIO|IO)(1|2|14|18|21) \\\\| KEY_IN \\\\|',
      },
      mustNotContain: {
        'docs/PINOUT.md': [
          '| U1 | 27 | IO0 | KEY_IN |',
          '| U1 | 15 | IO3 | KEY_IN |',
          '| U1 | 26 | IO45 | KEY_IN |',
          '| U1 | 16 | IO46 | KEY_IN |',
          '| U1 | 31 | IO38 | KEY_IN |',
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
    'pinout.rtc_capable': {
      value: 'RTC-capable',
      source: 'docs/SPEC.md#rtc-capable-gpios',
      affects: ['KEY_IN'],
    },
  };

  const specMd = `# pin-choice-strapping — Specification

ESP32-S3 keyer design with deep-sleep wakeup requirements. Key input must be connected to an RTC-capable GPIO (\`rtc_capable\`) and strictly avoid boot strapping pins.

## Strapping pins

The following pins are ESP32-S3 strapping pins and MUST NOT be used for the key input or pulled low at boot:

- GPIO0 (IO0, strapping: boot mode selection)
- GPIO3 (IO3, strapping: JTAG configuration)
- GPIO45 (IO45, strapping: VDD_SPI voltage)
- GPIO46 (IO46, strapping: ROM message printing)

## RTC-capable GPIOs

ESP32-S3 RTC GPIOs available for deep-sleep wakeup (\`rtc_capable\`):

- GPIO0 (IO0, RTC_GPIO0, strapping: forbidden)
- GPIO3 (IO3, RTC_GPIO3, strapping: forbidden)
- GPIO1 (IO1, RTC_GPIO1)
- GPIO2 (IO2, RTC_GPIO2)
- GPIO14 (IO14, RTC_GPIO14)
- GPIO18 (IO18, RTC_GPIO18)
- GPIO21 (IO21, RTC_GPIO21)

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
| U1 | 1 | GND | GND | Ground |
| U1 | 2 | 3V3 | 3V3 | Main 3.3V rail |
| U1 | 3 | EN | EN | Enable line with pullup |
| U1 | 4 | IO4 | | |
| U1 | 5 | IO5 | | |
| U1 | 6 | IO6 | | |
| U1 | 7 | IO7 | | |
| U1 | 8 | IO15 | | |
| U1 | 9 | IO16 | | |
| U1 | 10 | IO17 | | |
| U1 | 11 | IO18 | | |
| U1 | 12 | IO8 | | |
| U1 | 13 | USB_D- | | |
| U1 | 14 | USB_D+ | | |
| U1 | 15 | IO3 | | Strapping pin (JTAG) |
| U1 | 16 | IO46 | | Strapping pin (ROM log) |
| U1 | 17 | IO9 | | |
| U1 | 18 | IO10 | | |
| U1 | 19 | IO11 | | |
| U1 | 20 | IO12 | | |
| U1 | 21 | IO13 | | |
| U1 | 22 | IO14 | | |
| U1 | 23 | IO21 | | |
| U1 | 24 | IO47 | | |
| U1 | 25 | IO48 | | |
| U1 | 26 | IO45 | | Strapping pin (VDD_SPI) |
| U1 | 27 | IO0 | | Strapping pin (boot mode) |
| U1 | 28 | IO35 | | |
| U1 | 29 | IO36 | | |
| U1 | 30 | IO37 | | |
| U1 | 31 | IO38 | KEY_IN | Current key input (non-RTC GPIO) |
| U1 | 32 | IO39 | | |
| U1 | 33 | IO40 | | |
| U1 | 34 | IO41 | | |
| U1 | 35 | IO42 | | |
| U1 | 36 | RXD0 | | |
| U1 | 37 | TXD0 | | |
| U1 | 38 | IO2 | | |
| U1 | 39 | IO1 | | |
| U1 | 40 | GND | GND | Ground |
| U1 | 41 | GND | GND | Ground |
`;

  const subsystemsMd = `# Subsystems

Per-sheet values and reasoning (regulator, charger, RF, ...).

## Sheet /

- R1: 10k (Chip enable pullup)
- R2: 1k (Key input series protection)
- U1: ESP32-S3-WROOM-1 (MCU with RTC-aware key input)
`;

  const noConnectCoords = [
    [124.46, 83.82], [124.46, 86.36], [124.46, 88.9], [124.46, 91.44],
    [124.46, 93.98], [124.46, 96.52], [124.46, 99.06], [124.46, 101.6],
    [124.46, 104.14], [124.46, 106.68], [124.46, 109.22], [124.46, 111.76],
    [124.46, 114.3], [124.46, 116.84], [124.46, 119.38], [124.46, 121.92],
    [124.46, 124.46],
    [154.94, 78.74], [154.94, 81.28], [154.94, 83.82], [154.94, 86.36],
    [154.94, 88.9], [154.94, 91.44], [154.94, 93.98], [154.94, 96.52],
    [154.94, 99.06], [154.94, 101.6], [154.94, 106.68], [154.94, 109.22],
    [154.94, 111.76], [154.94, 114.3], [154.94, 116.84], [154.94, 119.38],
    [154.94, 121.92], [154.94, 124.46],
  ];

  let ncStr = '';
  noConnectCoords.forEach((c, idx) => {
    const hex = (idx + 1).toString(16).padStart(12, '0');
    ncStr += `  (no_connect (at ${c[0]} ${c[1]}) (uuid "0b0b0b0b-0000-4000-8000-${hex}"))\\n`;
  });

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
${R_SYM}
${PWR_FLAG_SYM}
${ESP32_S3_WROOM_1_SYM}
  )
${ncStr}
  (global_label "3V3" (shape input) (at 139.7 73.66 90) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify left))
    (uuid "0c0c0c0c-0000-4000-8000-000000000001")
  )
  (global_label "GND" (shape input) (at 139.7 129.54 270) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000002")
  )
  (global_label "EN" (shape input) (at 124.46 78.74 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000003")
  )
  (global_label "KEY_IN" (shape input) (at 154.94 104.14 0) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify left))
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
    (lib_id "power:PWR_FLAG")
    (at 139.7 73.66 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (fields_autoplaced yes)
    (uuid "0d0d0d0d-0000-4000-8000-0000000000f1")
    (property "Reference" "#FLG01" (at 139.7 75.565 0) (effects (font (size 1.27 1.27)) hide))
    (property "Value" "3V3" (at 139.7 77.47 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "" (at 139.7 73.66 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 139.7 73.66 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "0e0e0e0e-0000-4000-8000-0000000000f1"))
    (instances
      (project "pin-choice-strapping"
        (path "/0a0a0a0a-0000-4000-8000-000000000001" (reference "#FLG01") (unit 1))
      )
    )
  )
  (symbol
    (lib_id "power:PWR_FLAG")
    (at 139.7 129.54 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (fields_autoplaced yes)
    (uuid "0d0d0d0d-0000-4000-8000-0000000000f2")
    (property "Reference" "#FLG02" (at 139.7 131.445 0) (effects (font (size 1.27 1.27)) hide))
    (property "Value" "GND" (at 139.7 133.35 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "" (at 139.7 129.54 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 139.7 129.54 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "0e0e0e0e-0000-4000-8000-0000000000f2"))
    (instances
      (project "pin-choice-strapping"
        (path "/0a0a0a0a-0000-4000-8000-000000000001" (reference "#FLG02") (unit 1))
      )
    )
  )
  (symbol
    (lib_id "RF_Module:ESP32-S3-WROOM-1")
    (at 139.7 101.6 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (fields_autoplaced yes)
    (uuid "0d0d0d0d-0000-4000-8000-000000000003")
    (property "Reference" "U1" (at 139.7 69.85 0) (effects (font (size 1.27 1.27))))
    (property "Value" "ESP32-S3-WROOM-1" (at 139.7 133.35 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "RF_Module:ESP32-S3-WROOM-1" (at 139.7 101.6 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 139.7 101.6 0) (effects (font (size 1.27 1.27)) hide))
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
    (pin "13" (uuid "0e0e0e0e-0000-4000-8000-000000000011"))
    (pin "14" (uuid "0e0e0e0e-0000-4000-8000-000000000012"))
    (pin "15" (uuid "0e0e0e0e-0000-4000-8000-000000000013"))
    (pin "16" (uuid "0e0e0e0e-0000-4000-8000-000000000014"))
    (pin "17" (uuid "0e0e0e0e-0000-4000-8000-000000000015"))
    (pin "18" (uuid "0e0e0e0e-0000-4000-8000-000000000016"))
    (pin "19" (uuid "0e0e0e0e-0000-4000-8000-000000000017"))
    (pin "20" (uuid "0e0e0e0e-0000-4000-8000-000000000018"))
    (pin "21" (uuid "0e0e0e0e-0000-4000-8000-000000000019"))
    (pin "22" (uuid "0e0e0e0e-0000-4000-8000-00000000001a"))
    (pin "23" (uuid "0e0e0e0e-0000-4000-8000-00000000001b"))
    (pin "24" (uuid "0e0e0e0e-0000-4000-8000-00000000001c"))
    (pin "25" (uuid "0e0e0e0e-0000-4000-8000-00000000001d"))
    (pin "26" (uuid "0e0e0e0e-0000-4000-8000-00000000001e"))
    (pin "27" (uuid "0e0e0e0e-0000-4000-8000-00000000001f"))
    (pin "28" (uuid "0e0e0e0e-0000-4000-8000-000000000020"))
    (pin "29" (uuid "0e0e0e0e-0000-4000-8000-000000000021"))
    (pin "30" (uuid "0e0e0e0e-0000-4000-8000-000000000022"))
    (pin "31" (uuid "0e0e0e0e-0000-4000-8000-000000000023"))
    (pin "32" (uuid "0e0e0e0e-0000-4000-8000-000000000024"))
    (pin "33" (uuid "0e0e0e0e-0000-4000-8000-000000000025"))
    (pin "34" (uuid "0e0e0e0e-0000-4000-8000-000000000026"))
    (pin "35" (uuid "0e0e0e0e-0000-4000-8000-000000000027"))
    (pin "36" (uuid "0e0e0e0e-0000-4000-8000-000000000028"))
    (pin "37" (uuid "0e0e0e0e-0000-4000-8000-000000000029"))
    (pin "38" (uuid "0e0e0e0e-0000-4000-8000-00000000002a"))
    (pin "39" (uuid "0e0e0e0e-0000-4000-8000-00000000002b"))
    (pin "40" (uuid "0e0e0e0e-0000-4000-8000-00000000002c"))
    (pin "41" (uuid "0e0e0e0e-0000-4000-8000-00000000002d"))
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
      footprintIn: 'LED_SMD',
      filesChanged: {
        mustChange: [
          'hardware/add-part-second-led.kicad_sch',
          'docs/BOM.md',
        ],
        mayChange: [
          'openspec/changes/**',
          'docs/CHANGELOG.md',
          'docs/DECISIONS.md',
        ],
      },
      mustContain: {
        'docs/BOM.md': '| D2 |',
        'hardware/add-part-second-led.kicad_sch': '(property "Reference" "D2"',
      },
    },
  };

  const specMd = `# add-part-second-led — Specification

ESP32-S3 design featuring an existing RGB LED (D1) on IO4/IO5/IO6 with series resistors. Requires adding a second RGB LED for status signalling connected to free non-strapping GPIOs.

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
| D1 | LED_RGBK | LED_SMD:LED_RGB_1210 | UNVERIFIED | Primary status RGB LED |
| R1 | 10k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | Chip enable pullup |
| R3 | 330 | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | D1 Red channel current limiting |
| R4 | 330 | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | D1 Green channel current limiting |
| R5 | 330 | Resistor_SMD:R_0603_1608Metric | UNVERIFIED | D1 Blue channel current limiting |
| U1 | ESP32-S3-WROOM-1 | RF_Module:ESP32-S3-WROOM-1 | UNVERIFIED | Main MCU |
`;

  const pinoutMd = `# Pinout

Pin assignment extracted from the schematic. Check strapping/RTC notes before
reassigning pins.

| Refdes | Pin | Name | Net | Notes |
|---|---|---|---|---|
| U1 | 1 | GND | GND | Ground |
| U1 | 2 | 3V3 | 3V3 | Main 3.3V rail |
| U1 | 3 | EN | EN | Enable line with pullup |
| U1 | 4 | IO4 | LED1_R | Red channel D1 driver |
| U1 | 5 | IO5 | LED1_G | Green channel D1 driver |
| U1 | 6 | IO6 | LED1_B | Blue channel D1 driver |
| U1 | 7 | IO7 | | Free GPIO |
| U1 | 8 | IO15 | | Free GPIO |
| U1 | 9 | IO16 | | Free GPIO |
| U1 | 10 | IO17 | | Free GPIO |
| U1 | 11 | IO18 | | Free GPIO |
| U1 | 12 | IO8 | | Free GPIO |
| U1 | 13 | USB_D- | | Native USB |
| U1 | 14 | USB_D+ | | Native USB |
| U1 | 15 | IO3 | | Strapping pin (JTAG) |
| U1 | 16 | IO46 | | Strapping pin (ROM log) |
| U1 | 17 | IO9 | | Free GPIO |
| U1 | 18 | IO10 | | Free GPIO |
| U1 | 19 | IO11 | | Free GPIO |
| U1 | 20 | IO12 | | Free GPIO |
| U1 | 21 | IO13 | | Free GPIO |
| U1 | 22 | IO14 | | Free GPIO |
| U1 | 23 | IO21 | | Free GPIO |
| U1 | 24 | IO47 | | Free GPIO |
| U1 | 25 | IO48 | | Free GPIO |
| U1 | 26 | IO45 | | Strapping pin (VDD_SPI) |
| U1 | 27 | IO0 | | Strapping pin (boot mode) |
| U1 | 28 | IO35 | | Free GPIO |
| U1 | 29 | IO36 | | Free GPIO |
| U1 | 30 | IO37 | | Free GPIO |
| U1 | 31 | IO38 | | Free GPIO |
| U1 | 32 | IO39 | | Free GPIO |
| U1 | 33 | IO40 | | Free GPIO |
| U1 | 34 | IO41 | | Free GPIO |
| U1 | 35 | IO42 | | Free GPIO |
| U1 | 36 | RXD0 | | UART RX |
| U1 | 37 | TXD0 | | UART TX |
| U1 | 38 | IO2 | | Free GPIO |
| U1 | 39 | IO1 | | Free GPIO |
| U1 | 40 | GND | GND | Ground |
| U1 | 41 | GND | GND | Ground |
`;

  const subsystemsMd = `# Subsystems

Per-sheet values and reasoning (regulator, charger, RF, ...).

## Sheet /

- D1: LED_RGBK (Primary user indicator)
- R1: 10k (Pullup)
- R3: 330 (LED1 Red series resistor)
- R4: 330 (LED1 Green series resistor)
- R5: 330 (LED1 Blue series resistor)
- U1: ESP32-S3-WROOM-1 (Main MCU)
`;

  const noConnectCoords3 = [
    [124.46, 83.82], [124.46, 86.36], [124.46, 88.9], [124.46, 91.44],
    [124.46, 101.6], [124.46, 104.14], [124.46, 106.68], [124.46, 109.22],
    [124.46, 111.76], [124.46, 114.3], [124.46, 116.84], [124.46, 119.38],
    [124.46, 121.92], [124.46, 124.46],
    [154.94, 78.74], [154.94, 81.28], [154.94, 83.82], [154.94, 86.36],
    [154.94, 88.9], [154.94, 91.44], [154.94, 93.98], [154.94, 96.52],
    [154.94, 99.06], [154.94, 101.6], [154.94, 104.14], [154.94, 106.68],
    [154.94, 109.22], [154.94, 111.76], [154.94, 114.3], [154.94, 116.84],
    [154.94, 119.38], [154.94, 121.92], [154.94, 124.46],
  ];

  let ncStr3 = '';
  noConnectCoords3.forEach((c, idx) => {
    const hex = (idx + 1).toString(16).padStart(12, '0');
    ncStr3 += `  (no_connect (at ${c[0]} ${c[1]}) (uuid "0b0b0b0b-0000-4000-8000-${hex}"))\\n`;
  });

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
    (comment 1 "Board with D1 RGB LED ready for adding second LED")
  )
  (lib_symbols
${R_SYM}
${LED_RGBK_SYM}
${PWR_FLAG_SYM}
${ESP32_S3_WROOM_1_SYM}
  )
${ncStr3}
  (global_label "3V3" (shape input) (at 139.7 73.66 90) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify left))
    (uuid "0c0c0c0c-0000-4000-8000-000000000001")
  )
  (global_label "GND" (shape input) (at 139.7 129.54 270) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000002")
  )
  (global_label "EN" (shape input) (at 124.46 78.74 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000003")
  )
  (global_label "LED1_R" (shape input) (at 124.46 93.98 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000004")
  )
  (global_label "LED1_G" (shape input) (at 124.46 96.52 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000005")
  )
  (global_label "LED1_B" (shape input) (at 124.46 99.06 180) (fields_autoplaced yes)
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
  (global_label "LED1_R" (shape input) (at 185.42 91.44 90) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify left))
    (uuid "0c0c0c0c-0000-4000-8000-000000000009")
  )
  (global_label "LED1_RA" (shape input) (at 185.42 99.06 270) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-00000000000a")
  )
  (global_label "LED1_G" (shape input) (at 195.58 91.44 90) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify left))
    (uuid "0c0c0c0c-0000-4000-8000-00000000000b")
  )
  (global_label "LED1_GA" (shape input) (at 195.58 99.06 270) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-00000000000c")
  )
  (global_label "LED1_B" (shape input) (at 205.74 91.44 90) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify left))
    (uuid "0c0c0c0c-0000-4000-8000-00000000000d")
  )
  (global_label "LED1_BA" (shape input) (at 205.74 99.06 270) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-00000000000e")
  )
  (global_label "LED1_RA" (shape input) (at 200.66 109.22 0) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify left))
    (uuid "0c0c0c0c-0000-4000-8000-00000000000f")
  )
  (global_label "LED1_GA" (shape input) (at 200.66 114.3 0) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify left))
    (uuid "0c0c0c0c-0000-4000-8000-000000000010")
  )
  (global_label "LED1_BA" (shape input) (at 200.66 119.38 0) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify left))
    (uuid "0c0c0c0c-0000-4000-8000-000000000011")
  )
  (global_label "GND" (shape input) (at 190.5 114.3 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000012")
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
    (lib_id "Device:R")
    (at 185.42 95.25 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (fields_autoplaced yes)
    (uuid "0d0d0d0d-0000-4000-8000-000000000003")
    (property "Reference" "R3" (at 187.96 94.6149 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "330" (at 187.96 97.1549 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 183.642 95.25 90) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 185.42 95.25 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "0e0e0e0e-0000-4000-8000-000000000003"))
    (pin "2" (uuid "0e0e0e0e-0000-4000-8000-000000000004"))
    (instances
      (project "add-part-second-led"
        (path "/0a0a0a0a-0000-4000-8000-000000000001" (reference "R3") (unit 1))
      )
    )
  )
  (symbol
    (lib_id "Device:R")
    (at 195.58 95.25 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (fields_autoplaced yes)
    (uuid "0d0d0d0d-0000-4000-8000-000000000004")
    (property "Reference" "R4" (at 198.12 94.6149 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "330" (at 198.12 97.1549 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 193.802 95.25 90) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 195.58 95.25 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "0e0e0e0e-0000-4000-8000-000000000005"))
    (pin "2" (uuid "0e0e0e0e-0000-4000-8000-000000000006"))
    (instances
      (project "add-part-second-led"
        (path "/0a0a0a0a-0000-4000-8000-000000000001" (reference "R4") (unit 1))
      )
    )
  )
  (symbol
    (lib_id "Device:R")
    (at 205.74 95.25 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (fields_autoplaced yes)
    (uuid "0d0d0d0d-0000-4000-8000-000000000005")
    (property "Reference" "R5" (at 208.28 94.6149 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "330" (at 208.28 97.1549 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 203.962 95.25 90) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 205.74 95.25 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "0e0e0e0e-0000-4000-8000-000000000007"))
    (pin "2" (uuid "0e0e0e0e-0000-4000-8000-000000000008"))
    (instances
      (project "add-part-second-led"
        (path "/0a0a0a0a-0000-4000-8000-000000000001" (reference "R5") (unit 1))
      )
    )
  )
  (symbol
    (lib_id "Device:LED_RGBK")
    (at 195.58 114.3 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (fields_autoplaced yes)
    (uuid "0d0d0d0d-0000-4000-8000-000000000006")
    (property "Reference" "D1" (at 195.58 104.14 0) (effects (font (size 1.27 1.27))))
    (property "Value" "LED_RGBK" (at 195.58 124.46 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "LED_SMD:LED_RGB_1210" (at 195.58 114.3 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 195.58 114.3 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "0e0e0e0e-0000-4000-8000-000000000009"))
    (pin "2" (uuid "0e0e0e0e-0000-4000-8000-00000000000a"))
    (pin "3" (uuid "0e0e0e0e-0000-4000-8000-00000000000b"))
    (pin "4" (uuid "0e0e0e0e-0000-4000-8000-00000000000c"))
    (instances
      (project "add-part-second-led"
        (path "/0a0a0a0a-0000-4000-8000-000000000001" (reference "D1") (unit 1))
      )
    )
  )
  (symbol
    (lib_id "power:PWR_FLAG")
    (at 139.7 73.66 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (fields_autoplaced yes)
    (uuid "0d0d0d0d-0000-4000-8000-0000000000f1")
    (property "Reference" "#FLG01" (at 139.7 75.565 0) (effects (font (size 1.27 1.27)) hide))
    (property "Value" "3V3" (at 139.7 77.47 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "" (at 139.7 73.66 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 139.7 73.66 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "0e0e0e0e-0000-4000-8000-0000000000f1"))
    (instances
      (project "add-part-second-led"
        (path "/0a0a0a0a-0000-4000-8000-000000000001" (reference "#FLG01") (unit 1))
      )
    )
  )
  (symbol
    (lib_id "power:PWR_FLAG")
    (at 139.7 129.54 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (fields_autoplaced yes)
    (uuid "0d0d0d0d-0000-4000-8000-0000000000f2")
    (property "Reference" "#FLG02" (at 139.7 131.445 0) (effects (font (size 1.27 1.27)) hide))
    (property "Value" "GND" (at 139.7 133.35 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "" (at 139.7 129.54 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 139.7 129.54 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "0e0e0e0e-0000-4000-8000-0000000000f2"))
    (instances
      (project "add-part-second-led"
        (path "/0a0a0a0a-0000-4000-8000-000000000001" (reference "#FLG02") (unit 1))
      )
    )
  )
  (symbol
    (lib_id "RF_Module:ESP32-S3-WROOM-1")
    (at 139.7 101.6 0)
    (unit 1)
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (dnp no)
    (fields_autoplaced yes)
    (uuid "0d0d0d0d-0000-4000-8000-000000000002")
    (property "Reference" "U1" (at 139.7 69.85 0) (effects (font (size 1.27 1.27))))
    (property "Value" "ESP32-S3-WROOM-1" (at 139.7 133.35 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "RF_Module:ESP32-S3-WROOM-1" (at 139.7 101.6 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "~" (at 139.7 101.6 0) (effects (font (size 1.27 1.27)) hide))
    (pin "1" (uuid "0e0e0e0e-0000-4000-8000-000000000015"))
    (pin "2" (uuid "0e0e0e0e-0000-4000-8000-000000000016"))
    (pin "3" (uuid "0e0e0e0e-0000-4000-8000-000000000017"))
    (pin "4" (uuid "0e0e0e0e-0000-4000-8000-000000000018"))
    (pin "5" (uuid "0e0e0e0e-0000-4000-8000-000000000019"))
    (pin "6" (uuid "0e0e0e0e-0000-4000-8000-00000000001a"))
    (pin "7" (uuid "0e0e0e0e-0000-4000-8000-00000000001b"))
    (pin "8" (uuid "0e0e0e0e-0000-4000-8000-00000000001c"))
    (pin "9" (uuid "0e0e0e0e-0000-4000-8000-00000000001d"))
    (pin "10" (uuid "0e0e0e0e-0000-4000-8000-00000000001e"))
    (pin "11" (uuid "0e0e0e0e-0000-4000-8000-00000000001f"))
    (pin "12" (uuid "0e0e0e0e-0000-4000-8000-000000000020"))
    (pin "13" (uuid "0e0e0e0e-0000-4000-8000-000000000021"))
    (pin "14" (uuid "0e0e0e0e-0000-4000-8000-000000000022"))
    (pin "15" (uuid "0e0e0e0e-0000-4000-8000-000000000023"))
    (pin "16" (uuid "0e0e0e0e-0000-4000-8000-000000000024"))
    (pin "17" (uuid "0e0e0e0e-0000-4000-8000-000000000025"))
    (pin "18" (uuid "0e0e0e0e-0000-4000-8000-000000000026"))
    (pin "19" (uuid "0e0e0e0e-0000-4000-8000-000000000027"))
    (pin "20" (uuid "0e0e0e0e-0000-4000-8000-000000000028"))
    (pin "21" (uuid "0e0e0e0e-0000-4000-8000-000000000029"))
    (pin "22" (uuid "0e0e0e0e-0000-4000-8000-00000000002a"))
    (pin "23" (uuid "0e0e0e0e-0000-4000-8000-00000000002b"))
    (pin "24" (uuid "0e0e0e0e-0000-4000-8000-00000000002c"))
    (pin "25" (uuid "0e0e0e0e-0000-4000-8000-00000000002d"))
    (pin "26" (uuid "0e0e0e0e-0000-4000-8000-00000000002e"))
    (pin "27" (uuid "0e0e0e0e-0000-4000-8000-00000000002f"))
    (pin "28" (uuid "0e0e0e0e-0000-4000-8000-000000000030"))
    (pin "29" (uuid "0e0e0e0e-0000-4000-8000-000000000031"))
    (pin "30" (uuid "0e0e0e0e-0000-4000-8000-000000000032"))
    (pin "31" (uuid "0e0e0e0e-0000-4000-8000-000000000033"))
    (pin "32" (uuid "0e0e0e0e-0000-4000-8000-000000000034"))
    (pin "33" (uuid "0e0e0e0e-0000-4000-8000-000000000035"))
    (pin "34" (uuid "0e0e0e0e-0000-4000-8000-000000000036"))
    (pin "35" (uuid "0e0e0e0e-0000-4000-8000-000000000037"))
    (pin "36" (uuid "0e0e0e0e-0000-4000-8000-000000000038"))
    (pin "37" (uuid "0e0e0e0e-0000-4000-8000-000000000039"))
    (pin "38" (uuid "0e0e0e0e-0000-4000-8000-00000000003a"))
    (pin "39" (uuid "0e0e0e0e-0000-4000-8000-00000000003b"))
    (pin "40" (uuid "0e0e0e0e-0000-4000-8000-00000000003c"))
    (pin "41" (uuid "0e0e0e0e-0000-4000-8000-00000000003d"))
    (instances
      (project "add-part-second-led"
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
      refusalBlocker: 'power.sleep_current_uA',
      filesChanged: {
        mustChange: [],
        mayChange: [],
      },
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
      value: 25,
      source: 'docs/SPEC.md#budgets',
      affects: ['KEY_DAH', 'R1', 'R2'],
    },
  };

  const specMd = `# budget-refusal-pullup — Specification

Ultra-low-power morse keyer design. Device operates on battery and has strict power budget limits.

## Budgets

Hard constraints; edits that exceed them must be refused.

\`\`\`yaml
budgets:
  power:
    sleep_current_uA: 25   # Maximum total sleep current
\`\`\`
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
- U1: ESP32-S3-MINI (Main MCU)
`;

  await writeCaseFiles(id, {
    manifest,
    budgets,
    constraints,
    specMd,
    bomMd,
    pinoutMd,
    subsystemsMd,
    schFiles: {
      'budget-refusal-pullup.kicad_sch': getStandardOpenKeySch(id),
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
    setup: {
      kicadCli: 'stub-fail-then-pass',
    },
    expect: {
      outcome: 'success',
      erc: 'clean',
      commits: 1,
      ercFailuresBeforePass: {
        min: 1,
      },
      repairCyclesUsed: {
        max: 5,
      },
      expectedInitialViolation: 'pin_not_connected',
      filesChanged: {
        mustChange: [
          'hardware/repair-loop.kicad_sch',
          'docs/BOM.md',
        ],
        mayChange: [
          'openspec/changes/**',
          'docs/CHANGELOG.md',
          'docs/DECISIONS.md',
        ],
      },
      mustContain: {
        'docs/BOM.md': 'R3',
        'hardware/repair-loop.kicad_sch': 'R3',
      },
    },
  };

  const specMd = `# repair-loop — Specification

ESP32-S3 keyer design intended to exercise repair loop capabilities. Proposed circuit edits that create temporary ERC violations (such as unconnected nets or duplicate references) must be detected and repaired automatically.

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
- U1: ESP32-S3-MINI (Main MCU)
`;

  await writeCaseFiles(id, {
    manifest,
    specMd,
    bomMd,
    pinoutMd,
    subsystemsMd,
    schFiles: {
      'repair-loop.kicad_sch': getStandardOpenKeySch(id),
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
    instruction: 'add a 10k pull-down R3 on GPIO21',
    setup: {
      maxRepairCycles: 1,
      kicadCli: 'stub-always-violating',
    },
    expect: {
      outcome: 'failure',
      exitCode: 'nonzero',
      failureReason: 'repair-cycles-exhausted',
      treeUnchanged: true,
      commits: 0,
      filesChanged: {
        mustChange: [],
        mayChange: [],
      },
    },
  };

  const specMd = `# rollback — Specification

ESP32-S3 keyer design used to verify rollback behavior upon unresolvable verification failures.

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
- U1: ESP32-S3-MINI (Main MCU)
`;

  await writeCaseFiles(id, {
    manifest,
    specMd,
    bomMd,
    pinoutMd,
    subsystemsMd,
    schFiles: {
      'rollback.kicad_sch': getStandardOpenKeySch(id),
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
${R_SYM}
${ESP32_S3_MINI_SYM}
  )
  (no_connect (at 127 96.52) (uuid "0b0b0b0b-0000-4000-8000-000000000001"))
  (no_connect (at 127 99.06) (uuid "0b0b0b0b-0000-4000-8000-000000000002"))
  (no_connect (at 127 104.14) (uuid "0b0b0b0b-0000-4000-8000-000000000003"))
  (no_connect (at 127 106.68) (uuid "0b0b0b0b-0000-4000-8000-000000000004"))
  (rectangle (start 76 84) (end 160 120)
    (stroke (width 0.152) (type solid))
    (fill (type none))
    (uuid "0f0f0f0f-0000-4000-8000-000000000001")
  )
  (text "Keyer" (at 81 87.5 0)
    (effects (font (size 2 2)))
    (uuid "0f0f0f0f-0000-4000-8000-000000000002")
  )
  (global_label "3V3" (shape input) (at 127 91.44 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000001")
    (property "Intersheetrefs" "\\\${INTERSHEET_REFS}" (at 118.4864 91.0286 0)
      (effects (font (size 1.27 1.27)) (justify right) hide)
    )
  )
  (global_label "EN" (shape input) (at 127 93.98 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000002")
    (property "Intersheetrefs" "\\\${INTERSHEET_REFS}" (at 120.7317 93.5686 0)
      (effects (font (size 1.27 1.27)) (justify right) hide)
    )
  )
  (global_label "KEY_DAH" (shape input) (at 127 101.6 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000003")
    (property "Intersheetrefs" "\\\${INTERSHEET_REFS}" (at 114.7738 101.1886 0)
      (effects (font (size 1.27 1.27)) (justify right) hide)
    )
  )
  (global_label "GND" (shape input) (at 127 109.22 180) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000004")
    (property "Intersheetrefs" "\\\${INTERSHEET_REFS}" (at 118.4864 108.8086 0)
      (effects (font (size 1.27 1.27)) (justify right) hide)
    )
  )
  (global_label "3V3" (shape input) (at 88.9 91.44 90) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify left))
    (uuid "0c0c0c0c-0000-4000-8000-000000000005")
    (property "Intersheetrefs" "\\\${INTERSHEET_REFS}" (at 89.3114 82.4904 90)
      (effects (font (size 1.27 1.27)) (justify left) hide)
    )
  )
  (global_label "EN" (shape input) (at 88.9 99.06 270) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000006")
    (property "Intersheetrefs" "\\\${INTERSHEET_REFS}" (at 88.4886 105.8117 90)
      (effects (font (size 1.27 1.27)) (justify right) hide)
    )
  )
  (global_label "KEY_DAH" (shape input) (at 96.52 106.68 90) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify left))
    (uuid "0c0c0c0c-0000-4000-8000-000000000007")
    (property "Intersheetrefs" "\\\${INTERSHEET_REFS}" (at 96.9314 94.4538 90)
      (effects (font (size 1.27 1.27)) (justify left) hide)
    )
  )
  (global_label "GND" (shape input) (at 96.52 114.3 270) (fields_autoplaced yes)
    (effects (font (size 1.27 1.27)) (justify right))
    (uuid "0c0c0c0c-0000-4000-8000-000000000008")
    (property "Intersheetrefs" "\\\${INTERSHEET_REFS}" (at 96.1086 121.0517 90)
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
      (project "${projectName}"
        (path "/0a0a0a0a-0000-4000-8000-000000000001"
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
      (project "${projectName}"
        (path "/0a0a0a0a-0000-4000-8000-000000000001"
          (reference "R2") (unit 1)
        )
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
      (project "${projectName}"
        (path "/0a0a0a0a-0000-4000-8000-000000000001"
          (reference "U1") (unit 1)
        )
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

These fixtures enable repeatable, automated verification of the core agent loop across acceptance criteria AC-3.1 through AC-3.6 without requiring an active LLM API key during fixture inspection and static validation. Starting projects are verified to be ERC- and DRC-clean in \`test/edits-fixtures.test.ts\`.

Fixtures are generated deterministically by \`scripts/build-edit-fixtures.ts\` and can be regenerated with \`npm run fixtures:edits\`.

## Fixture Catalog

| ID | Acceptance Criterion | Title | Primary Proof / Purpose |
|---|---|---|---|
| [\`rename-net-cross-sheet\`](rename-net-cross-sheet/) | AC-3.1 | Cross-sheet net rename | Proves propagating net rename across multi-sheet schematics and design docs (\`PINOUT.md\`, \`SUBSYSTEMS.md\`) with a surgical diff (< 5% lines changed). |
| [\`pin-choice-strapping\`](pin-choice-strapping/) | AC-3.2 | Constraint-aware pin selection | Proves reasoning over MCU constraints: selecting an RTC-capable GPIO while avoiding ESP32-S3 strapping pins (GPIO0, GPIO3, GPIO45, GPIO46). |
| [\`add-part-second-led\`](add-part-second-led/) | AC-3.3 | Add component with verified footprint | Proves adding a new component (RGB LED) with unique refdes, valid library footprint (\`LED_SMD:LED_RGB_1210\`), net hookup, and \`UNVERIFIED\` row added to \`BOM.md\`. |
| [\`budget-refusal-pullup\`](budget-refusal-pullup/) | AC-3.4 | Power budget refusal | Proves that the agent refuses an edit (or offers an alternative) when adding a 100kΩ pullup would violate the 25 µA sleep current budget in \`SPEC.md\`. |
| [\`repair-loop\`](repair-loop/) | AC-3.5 | ERC repair cycle | Proves parsing and targeted repair of an initial ERC violation within \`maxRepairCycles\`. |
| [\`rollback\`](rollback/) | AC-3.6 | Working tree rollback | Proves that unresolvable violations restore the working tree to a byte-identical snapshot (\`git status\` clean, exit non-zero). |

## Manifest Schema

Each fixture contains a \`manifest.json\` defining the test harness setup and post-edit expectations:

| Field | Type | Checked Against | Semantics |
|---|---|---|---|
| \`id\` | string | directory name | Unique fixture identifier matching directory name |
| \`ac\` | string | specification | Acceptance criterion identifier (AC-3.1 .. AC-3.6) |
| \`title\` | string | metadata | Descriptive title of the test case |
| \`description\` | string | metadata | Detailed test description |
| \`instruction\` | string | agent input | Natural language prompt dispatched to \`copperhead do\` |
| \`setup\` | object | harness runtime | Optional runtime environment overrides (e.g. \`kicadCli\`, \`maxRepairCycles\`) |
| \`expect.outcome\` | string | agent report | Expected finish outcome: \`success\`, \`refused\`, or \`failure\` |
| \`expect.erc\` | string | kicad-cli ERC | Required ERC status: \`clean\` (zero error-severity violations) |
| \`expect.commits\` | number | git log | Expected number of git commits authored by the run |
| \`expect.check\` | string | check command | Status gate outcome: \`ok\` verifies constraint and drift gates pass |
| \`expect.treeUnchanged\` | boolean | git status | When true, git working tree must be identical to starting snapshot |
| \`expect.filesChanged\` | object | git diff | Object with \`mustChange\` (files that must change) and \`mayChange\` (allowlist of optional files) |
| \`expect.mustContain\` | map | file text | Map of relative paths to substring(s) that must appear post-run |
| \`expect.mustNotContain\` | map | file text | Map of relative paths to substring(s) that must NOT appear post-run |
| \`expect.mustMatch\` | map | file text | Map of relative paths to regex pattern(s) that must match post-run |
| \`expect.footprintIn\` | string | component library | Footprint library prefix required for newly added components |
| \`expect.maxSchLinesChangedPct\` | number | git diff | Maximum allowable percentage of modified schematic lines (surgical diff) |
| \`expect.refusalBlocker\` | string | agent report | Specific constraint key cited as the blocker when refusing an edit |
| \`expect.ercFailuresBeforePass\` | object | agent telemetry | Minimum number of initial ERC failures before repair cycle passes |
| \`expect.repairCyclesUsed\` | object | agent telemetry | Maximum number of repair cycles consumed |
| \`expect.expectedInitialViolation\` | string | agent telemetry | Violation kind expected on naive initial edit |
| \`expect.exitCode\` | string | process exit | Expected exit code: \`nonzero\` on unresolvable rollback |
| \`expect.failureReason\` | string | agent report | Expected failure reason on rollback |

Example manifest:

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
    "filesChanged": {
      "mustChange": [
        "hardware/rename-net-cross-sheet.kicad_sch",
        "hardware/keyer.kicad_sch",
        "docs/PINOUT.md",
        "docs/SUBSYSTEMS.md"
      ],
      "mayChange": [
        "openspec/changes/**",
        "docs/CHANGELOG.md",
        "docs/DECISIONS.md"
      ]
    },
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

export async function buildAllFixtures(targetDir?: string): Promise<void> {
  if (targetDir) EDITS_DIR = path.resolve(targetDir);
  console.log('Generating edit fixtures in', EDITS_DIR);
  await buildCase1();
  await buildCase2();
  await buildCase3();
  await buildCase4();
  await buildCase5();
  await buildCase6();
  await writeFile(path.join(EDITS_DIR, 'README.md'), buildReadme(), 'utf8');
}

async function main(): Promise<void> {
  const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  await buildAllFixtures(targetDir);
  console.log('All fixtures built successfully.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error('Error generating fixtures:', err);
    process.exit(1);
  });
}
