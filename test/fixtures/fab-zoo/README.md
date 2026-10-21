# Fab Release Gate — Broken Fixture Zoo (`add-fab-release-gate` Task 4.1)

Minimal single-fault variants derived from `test/fixtures/open-key/`, each breaking exactly one fabrication release gate invariant while leaving `test/fixtures/open-key/` itself ERC/DRC clean:

| Variant directory | Broken artifact | Single fault introduced | Gate check that catches it |
| --- | --- | --- | --- |
| `unrouted-net/` | `open-key.kicad_pcb`, `drc-unrouted-net.json` | Net `KEY_DAH` between `R2` pad 1 and `U1` pad 5 is left unrouted (`unconnected_items` count = 1). | `fab.routing` (Routing completeness check) |
| `mpn-less-bom/` | `BOM.md` | Row `R2` (`1k`, `Resistor_SMD:R_0603_1608Metric`) has an empty MPN cell while `R1` and `U1` carry valid MPNs. | `fab.bom` (BOM readiness check — always `fail`) |
| `unverified-bom/` | `BOM.md` | All rows carry MPNs and footprints, but `U1` (`ESP32-S3-MINI-1-N8`) is flagged `UNVERIFIED`. | `fab.bom` (BOM readiness check — `warn` by default, `fail` under `--strict`) |
| `refdes-mismatch/` | `open-key.kicad_pcb` | Component `R2` is present in `open-key.kicad_sch` but omitted from `open-key.kicad_pcb` (only `R1` and `U1` placed). | `fab.schPcbMatch` (Schematic-to-PCB refdes parity check) |
| `footprint-mismatch/` | `open-key.kicad_pcb` | `R2` is placed on the board with `Resistor_SMD:R_0805_2012Metric` while `open-key.kicad_sch` specifies `Resistor_SMD:R_0603_1608Metric`. | `fab.schPcbMatch` (Schematic-to-PCB footprint assignment check) |
| `missing-draft-quality/` | `LAYOUT.md` | `LAYOUT.md` documents board dimensions and placement notes but omits the required `## Draft quality` section. | `fab.docs` (`checkDocumentationPresence`) |
