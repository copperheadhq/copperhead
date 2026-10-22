# Fab Release Gate: Broken Fixture Zoo (`add-fab-release-gate` Task 4.1)

Minimal single-fault variants derived from `test/fixtures/open-key/` and the routed baseline board `_base/hardware/open-key.kicad_pcb`, each breaking one fabrication release gate invariant while leaving `test/fixtures/open-key/` untouched:

| Variant directory | Broken artifact | Single fault introduced vs. `_base` / `open-key` | Gate check that catches it |
| --- | --- | --- | --- |
| `_base/` | `hardware/open-key.kicad_pcb` | Routed baseline board (`R1`, `R2`, `U1` with `3V3`, `EN`, `GND`, and `KEY_DAH` routed on `F.Cu` and full 20-layer table preserved). | Baseline (0 unconnected nets) |
| `unrouted-net/` | `hardware/open-key.kicad_pcb`, `drc-unrouted-net.json` | Derived from `_base` by removing only the `KEY_DAH` (`net 4`) copper segments between `R2` pad 1 and `U1` pad 5 (`3V3`, `EN`, `GND` remain routed). | `fab.routing` *(planned)* |
| `mpn-less-bom/` | `docs/BOM.md` | Row `R2` (`1k`, `Resistor_SMD:R_0603_1608Metric`) has an empty MPN cell while `R1` and `U1` carry valid MPNs. | `fab.bom` *(planned)* |
| `unverified-bom/` | `docs/BOM.md` | All rows carry MPNs and footprints, with `U1` (`ESP32-S3-MINI-1-N8`) flagged `UNVERIFIED`. | `fab.bom` *(planned)* |
| `refdes-mismatch/` | `hardware/open-key.kicad_pcb` | Derived from `_base` by removing only `R2` and its connected segments while `R2` remains in `open-key.kicad_sch`. | `fab.schPcbMatch` *(planned)* |
| `footprint-mismatch/` | `hardware/open-key.kicad_pcb` | Derived from `_base` by changing only `R2`'s footprint ID to `Resistor_SMD:R_0805_2012Metric` (vs. `Resistor_SMD:R_0603_1608Metric` in `open-key.kicad_sch`). | `fab.schPcbMatch` *(planned)* |
| `missing-draft-quality/` | `docs/LAYOUT.md` | `docs/LAYOUT.md` documents board dimensions and placement notes but omits the required `## Draft quality` section. | `fab.docs` (`checkDocumentationPresence` in `src/kicad/fab.ts`) |
