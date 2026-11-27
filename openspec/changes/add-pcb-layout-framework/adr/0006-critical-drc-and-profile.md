# ADR 0006: Critical DRC violations and the default fabrication profile

**Status:** Accepted (2026-09-06)
**RFC:** 11 §10.5, §10.7, Appendix C.2 items 5 and 6

## Evidence

KiCad 10's DRC report types observed across the PCBench sweep and the golden boards: `clearance`, `shorting_items`, `track_width`, `via_diameter`, `hole_clearance`, `hole_near_hole`, `annular_width`, `copper_edge_clearance`, `courtyards_overlap`, `pth_inside_courtyard`, `malformed_courtyard`, `missing_courtyard`, `invalid_outline`, `items_not_allowed`, `solder_mask_bridge`, `silk_over_copper`, `silk_overlap`, `text_height`, `text_thickness`, `lib_footprint_mismatch`, `footprint_type_mismatch`, `track_dangling`, `via_dangling`, `isolated_copper`, `unconnected_items` (reported separately). PCBWorld counts only error-severity violations as DRVs in its canonical mode and promotes dangling via, dangling track, and net conflict in its second mode (ADR 0001). kicad-tools' JLCPCB 2-layer 1 oz rules: 0.127 mm trace and clearance, 0.3 mm drill, 0.6 mm via, 0.15 mm annular ring, 0.3 mm copper-to-edge, 0.5 mm hole-to-edge, 0.15/1.0 mm silk, 0.1 mm mask dam (ADR 0002).

## Decision

1. **A critical DRC violation is an error-severity report whose type is in the active profile's `criticalDrc` list.** For `jlcpcb-2layer` the list is: `clearance`, `shorting_items`, `track_width`, `via_diameter`, `hole_clearance`, `hole_near_hole`, `annular_width`, `copper_edge_clearance`, `courtyards_overlap`, `pth_inside_courtyard`, `items_not_allowed`, `invalid_outline`, `isolated_copper`, `zones_intersect`, `starved_thermal`. Advisory (reported, never gating): `solder_mask_bridge`, `silk_over_copper`, `silk_overlap`, `text_height`, `text_thickness`, `lib_footprint_mismatch`, `footprint_type_mismatch`, `malformed_courtyard`, `missing_courtyard` (the pre-flight courtyard check refuses earlier, so DRC never sees it on a snapshot that passed), `track_dangling`, `via_dangling`. `unconnected_items` are completion, never violations. A stricter profile promotes a type by listing it.
2. **The default profile is `jlcpcb-2layer`**, vendored from kicad-tools `cfc166b` `manufacturers/data/jlcpcb.yaml` block `2layer_1oz` and `rules/jlcpcb-2layer-1oz.kicad_dru`, into `src/pcb/verify/profiles/jlcpcb-2layer.json` with the source recorded. The profile also fixes `viaInPad: forbidden` and the `kicadToolsMfr: jlcpcb` mapping.
3. The profile's minimums are gates only through the KiCad DRC run against the project's design rules; `pcb import` writes the profile's minimums into the snapshot's rules when the project's own rules are looser, and records that as an `ecad_rules` constraint override with source `profile:jlcpcb-2layer`, so the designer sees it.

## Consequences

The 15-type critical list is the definition the delta specs' "zero critical DRC" scenarios test against; a bench report names the profile and its commit so a future list change cannot silently move numbers.
