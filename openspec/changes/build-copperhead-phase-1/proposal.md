# Proposal: Build copperhead Phase 1

## Why

Hardware design has no equivalent of a coding agent: every schematic change is manual, docs drift from the design immediately, and nothing verifies that a change respects the product's constraints. copperhead (per `openspec/specs/SPEC.md`) closes that gap — an AI agent that edits real KiCad files, keeps design docs as memory, and gates every edit behind a validated spec proposal and an ERC/DRC pass. Phase 1 delivers the complete CLI and agent core; the repo today contains only the spec, so everything must be built.

## What Changes

- Scaffold the TypeScript/Node ≥ 20 project: `package.json` (bin: `copperhead`), `tsconfig.json`, `.env.example`, test fixture KiCad project.
- Implement the CLI surface: `copperhead create`, `init`, `do`, `check` (alias `verify`), `sync`, with global flags `--repo`, `--dry-run`, `--json` (`explain` is stretch, `watch` is Phase 2 — out of scope).
- Implement `copperhead sync`: verify the entire design state for inconsistencies (doc tables vs schematic, constraints.json vs docs and specs, PINOUT.md vs pins.h, decision/changelog coverage) and resolve the drift via a spec-gated agent run — with a truth-precedence rule that never silently rewrites a requirement violation (SPEC.md AC-7).
- Implement the provider-agnostic agent loop (OpenAI GPT-5 + Anthropic Claude behind one `Provider` interface) with turn budgets, repair cycles, retry/backoff, and provider failover.
- Implement KiCad tooling: `kicad-cli` subprocess wrapper for ERC/DRC/SVG export, minimal s-expression reader (read-only: symbols/nets), and ERC/DRC report parser producing structured violations.
- Implement docs-as-memory: `init` scaffolds `docs/` (SPEC/BOM/PINOUT/SUBSYSTEMS/LAYOUT.md) pre-filled from the parsed schematic; `check_drift` compares doc claims against the schematic.
- Make agent memory user-viewable, not a black box: an append-only `docs/DECISIONS.md` log of every agent decision with rationale, a per-run design changelog (`docs/CHANGELOG.md`), a human-readable `summary.md` per run alongside the JSONL transcript, and a generated `.copperhead/README.md` documenting every config key and the memory layout.
- Implement an event-driven sync layer so nothing goes stale: post-edit hooks inside the loop record sync obligations (drift check, constraint dual-write, `affects` revisit, decision-log and changelog entries) that MUST clear before the run may commit; `init` installs a git pre-commit hook running `copperhead check` so human edits are held to the same bar.
- Implement spec-gated editing: the agent drives OpenSpec as a subprocess; `edit_file`/`write_file` tools are absent from the tool list until `openspec validate --change <id>` passes; constraint registry `.copperhead/constraints.json` built alongside docs.
- Implement the Mode A `create` pipeline: brief → seeded specs → architecture → BOM → schematic → first-draft layout → outputs package (gerbers, DXF/STEP, renders, order BOM) → firmware scaffold → DEVPLAN.md, with run-to-completion guarantee and `--interactive` gates.
- Implement safety rails: repo-root path sandboxing, dirty-tree refusal, snapshot/rollback on failure, secret redaction in transcripts, `UNVERIFIED` flagging of invented parts.

## Capabilities

### New Capabilities

- `cli-surface`: The `copperhead` command set (`create`, `init`, `do`, `check`, `sync`), global flags, exit codes, and JSON output mode — including the full-state consistency verify-and-resolve command.
- `agent-core`: The provider-agnostic LLM tool-use loop — provider abstraction, tool schemas and dispatch, system prompt rules, turn/repair budgets, failure handling, and the post-edit hook/obligations engine that blocks commit until docs, constraints, and logs are in sync.
- `kicad-tooling`: kicad-cli wrapper (ERC, DRC, SVG export), read-only s-expression parsing (`list_symbols`, `list_nets`), and structured violation reports.
- `docs-memory`: docs/ scaffolding from a real schematic (`init`), the docs-as-memory convention, doc-vs-schematic drift checking, the user-viewable decision log (`docs/DECISIONS.md`) and design changelog (`docs/CHANGELOG.md`), the self-describing `.copperhead/README.md`, and git pre-commit hook installation.
- `spec-gating`: OpenSpec-driven change workflow (propose → validate → edit-unlock → archive) and the machine-readable constraint registry with `affects` propagation.
- `create-pipeline`: Mode A end-to-end pipeline from `brief.md` to the full output package, firmware scaffold, and DEVPLAN.md, resumable and run-to-completion.
- `safety-rails`: Path sandboxing, git-state preconditions, snapshot/rollback, secret hygiene, no-invented-MPN policy, and human-readable per-run summaries in the audit trail.

### Modified Capabilities

None — no per-capability specs exist yet (`openspec/specs/` holds only the source technical spec document).

## Impact

- New source tree under `src/` (cli, agent/, kicad/, memory/, util/), `test/fixtures/`, and project config files — all greenfield.
- Runtime dependencies: commander, OpenAI SDK, Anthropic SDK, execa (subprocess), ripgrep-style search; dev: TypeScript, a test runner (vitest), tsx.
- External requirements: `kicad-cli` ≥ 8 on PATH; `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` via env only; `openspec` CLI available in target repos.
- Acceptance is defined by SPEC.md §9 (AC-1 … AC-4, AC-6, AC-7); priority order AC-3.4 > AC-3.2 > AC-3.1 > AC-2.1 > AC-1.2.

## Create-stage evidence follow-up

The related completion and export corrections are tracked in
[fix-create-stage-evidence](../fix-create-stage-evidence/proposal.md), with a
coherent design, focused delta specs, actual validation results and unchecked
remaining acceptance tasks. This reference does not mark this change archived
or assert that unperformed manual tests or invariant reviews are complete.
