## ADDED Requirements

### Requirement: pcb reuse command

`copperhead pcb reuse --board <path>` SHALL run the reuse placer, and accept:
- `--reference <path>`, `--mode revision|related`;
- `--model <id>`, `--plans <k>`, `--rounds <n>`;
- `--max-variants <n>`, `--options <n>`, `--option A|B|C`;
- `--no-critical-routing`, `--no-probe`, `--probe-top <n>`;
- `--budget-seconds <s>`, `--replay <run-dir>`, `--apply`, `--run-dir <path>`, `--json`.

Without `--model` it SHALL make no model or network call.

The run directory SHALL hold:
- `options.md`;
- `ranking.json` and `outcome.json`;
- a `board.svg` and `board.png` per option;
- `variants/` with every plan, phase log, screen result and critical-routing result.

`--apply` SHALL write option A, or the option `--option` names.

#### Scenario: Apply writes the chosen option
- **WHEN** `pcb reuse --board b.kicad_pcb --apply --option B` completes with three options
- **THEN** the board file carries option B's placements, and `outcome.json` names option B as applied

#### Scenario: Placement without a reference
- **WHEN** `pcb reuse --board b.kicad_pcb` runs without `--reference`
- **THEN** every movable part is placed by the default plans, and the options are presented as with a reference
