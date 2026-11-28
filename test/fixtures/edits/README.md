# Edit-Verification Fixtures (AC-3.x)

This dataset provides self-contained, ERC- and DRC-clean "before" KiCad projects paired with a `manifest.json` specifying the exact natural language edit instruction and assertions for `copperhead do`.

These fixtures enable repeatable, automated verification of the core agent loop across acceptance criteria AC-3.1 through AC-3.6 without requiring an active LLM API key during fixture inspection and static validation. Starting projects are verified to be ERC- and DRC-clean in `test/edits-fixtures.test.ts`.

Fixtures are generated deterministically by `scripts/build-edit-fixtures.ts` and can be regenerated with `npm run fixtures:edits`.

## Fixture Catalog

| ID | Acceptance Criterion | Title | Primary Proof / Purpose |
|---|---|---|---|
| [`rename-net-cross-sheet`](rename-net-cross-sheet/) | AC-3.1 | Cross-sheet net rename | Proves propagating net rename across multi-sheet schematics and design docs (`PINOUT.md`, `SUBSYSTEMS.md`) with a surgical diff (< 5% lines changed). |
| [`pin-choice-strapping`](pin-choice-strapping/) | AC-3.2 | Constraint-aware pin selection | Proves reasoning over MCU constraints: selecting an RTC-capable GPIO while avoiding ESP32-S3 strapping pins (GPIO0, GPIO3, GPIO45, GPIO46). |
| [`add-part-second-led`](add-part-second-led/) | AC-3.3 | Add component with verified footprint | Proves adding a new component (RGB LED) with unique refdes, valid library footprint (`LED_SMD:LED_RGB_1210`), net hookup, and `UNVERIFIED` row added to `BOM.md`. |
| [`budget-refusal-pullup`](budget-refusal-pullup/) | AC-3.4 | Power budget refusal | Proves that the agent refuses an edit (or offers an alternative) when adding a 100kΩ pullup would violate the 25 µA sleep current budget in `SPEC.md`. |
| [`repair-loop`](repair-loop/) | AC-3.5 | ERC repair cycle | Proves parsing and targeted repair of an initial ERC violation within `maxRepairCycles`. |
| [`rollback`](rollback/) | AC-3.6 | Working tree rollback | Proves that unresolvable violations restore the working tree to a byte-identical snapshot (`git status` clean, exit non-zero). |

## Manifest Schema

Each fixture contains a `manifest.json` defining the test harness setup and post-edit expectations:

| Field | Type | Checked Against | Semantics |
|---|---|---|---|
| `id` | string | directory name | Unique fixture identifier matching directory name |
| `ac` | string | specification | Acceptance criterion identifier (AC-3.1 .. AC-3.6) |
| `title` | string | metadata | Descriptive title of the test case |
| `description` | string | metadata | Detailed test description |
| `instruction` | string | agent input | Natural language prompt dispatched to `copperhead do` |
| `setup` | object | harness runtime | Optional runtime environment overrides (e.g. `kicadCli`, `maxRepairCycles`) |
| `expect.outcome` | string | agent report | Expected finish outcome: `success`, `refused`, or `failure` |
| `expect.erc` | string | kicad-cli ERC | Required ERC status: `clean` (zero error-severity violations) |
| `expect.commits` | number | git log | Expected number of git commits authored by the run |
| `expect.check` | string | check command | Status gate outcome: `ok` verifies constraint and drift gates pass |
| `expect.treeUnchanged` | boolean | git status | When true, git working tree must be identical to starting snapshot |
| `expect.filesChanged` | object | git diff | Object with `mustChange` (files that must change) and `mayChange` (allowlist of optional files) |
| `expect.mustContain` | map | file text | Map of relative paths to substring(s) that must appear post-run |
| `expect.mustNotContain` | map | file text | Map of relative paths to substring(s) that must NOT appear post-run |
| `expect.mustMatch` | map | file text | Map of relative paths to regex pattern(s) that must match post-run |
| `expect.footprintIn` | string | component library | Footprint library prefix required for newly added components |
| `expect.maxSchLinesChangedPct` | number | git diff | Maximum allowable percentage of modified schematic lines (surgical diff) |
| `expect.refusalBlocker` | string | agent report | Specific constraint key cited as the blocker when refusing an edit |
| `expect.ercFailuresBeforePass` | object | agent telemetry | Minimum number of initial ERC failures before repair cycle passes |
| `expect.repairCyclesUsed` | object | agent telemetry | Maximum number of repair cycles consumed |
| `expect.expectedInitialViolation` | string | agent telemetry | Violation kind expected on naive initial edit |
| `expect.exitCode` | string | process exit | Expected exit code: `nonzero` on unresolvable rollback |
| `expect.failureReason` | string | agent report | Expected failure reason on rollback |

Example manifest:

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
