# open-key fixture

The project-local `hardware/sym-lib-table` resolves `Device:R` to
`hardware/Device.kicad_sym`. This library contains the resistor already embedded
in `hardware/open-key.kicad_sch`, with only the library nickname removed from its
top-level symbol name. It uses the repository's existing fixture content.

Pin the library with the schematic: comparing this fixed fixture against a newer
system `Device` library can produce `lib_symbol_mismatch` warnings even when its
connectivity has not changed. The local table keeps ERC reproducible without
suppressing that check or changing the schematic's geometry, nets or values.

Copy the complete `hardware/` directory when using the fixture. If the resistor
definition changes, update both copies and rerun the real KiCad checks. This is a
synthetic test circuit, not a validated hardware design.
