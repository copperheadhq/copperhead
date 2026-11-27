# Edit-Verification Fixtures (AC-3.x)

This dataset provides self-contained, ERC- and DRC-clean "before" KiCad projects paired with a `manifest.json` specifying the exact natural language edit instruction and assertions for `copperhead do`.

These fixtures enable repeatable, automated verification of the core agent loop across acceptance criteria AC-3.1 through AC-3.6 without requiring an active LLM API key during fixture inspection and static validation.

## Fixture Catalog

| ID | Acceptance Criterion | Title | Primary Proof / Purpose |
|---|---|---|---|
| [`rename-net-cross-sheet`](rename-net-cross-sheet/) | AC-3.1 | Cross-sheet net rename | Proves propagating net rename across multi-sheet schematics and design docs (`PINOUT.md`, `SUBSYSTEMS.md`) with a surgical diff (< 5% lines changed). |
| [`pin-choice-strapping`](pin-choice-strapping/) | AC-3.2 | Constraint-aware pin selection | Proves reasoning over MCU constraints: selecting an RTC-capable GPIO while avoiding ESP32-S3 strapping pins (GPIO0, GPIO3, GPIO45, GPIO46). |
| [`add-part-second-led`](add-part-second-led/) | AC-3.3 | Add component with verified footprint | Proves adding a new component (RGB LED) with unique refdes, valid library footprint, net hookup, and `UNVERIFIED` row added to `BOM.md`. |
| [`budget-refusal-pullup`](budget-refusal-pullup/) | AC-3.4 | Power budget refusal | Proves that the agent refuses an edit (or offers an alternative) when adding a 100kΩ pullup would violate the 25 µA sleep current budget in `SPEC.md`. |
| [`repair-loop`](repair-loop/) | AC-3.5 | ERC repair cycle | Proves parsing and targeted repair of an initial ERC violation within `maxRepairCycles`. |
| [`rollback`](rollback/) | AC-3.6 | Working tree rollback | Proves that unresolvable violations restore the working tree to a byte-identical snapshot (`git status` clean, exit non-zero). |

## Manifest Schema

Each fixture contains a `manifest.json` defining the post-edit expectations:

```json
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
```

## Fixture Structure

Each fixture directory under `test/fixtures/edits/<id>/` is a fully standalone KiCad repository:

```text
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
```
