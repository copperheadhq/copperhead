# add-electrical-diff-command: Design

## Context

KiCad schematic files (`.kicad_sch`) store graphical layout and electrical connectivity in a single s-expression tree. Moving a resistor or re-annotating UUIDs produces large text diffs with zero electrical impact, while changing a net label or rewiring a single pin can be buried in thousands of lines.

## Decisions

1. **Smart default base revision**: When `--base` is omitted, `runDiff` compares against `HEAD` if the schematic has uncommitted working-tree changes relative to `HEAD`, or `HEAD~1` when the working tree is clean after a committed run (falling back to `HEAD` on a single-commit repo).
2. **Surviving-component connection filtering**: Pin-level connection changes under `Connections:` are emitted only for components present in both snapshots; newly added components already list their connected nets inline under `Components:`.
3. **Surviving-pin net rename and multi-pin merge detection**: Net renames compare surviving pin sets so adding a pull-up resistor on a renamed net still detects the rename. Net merge warnings require at least two surviving pins on each contributing prior net so rewiring a single pin does not false-positive as a net short.
4. **Boundary-safe constraint token matching**: Affected constraints match refdes, nets (including `+3V3`, `~{RESET}`), and pin labels (`U1.1` vs `U1.14`) using non-alphanumeric token boundaries.
