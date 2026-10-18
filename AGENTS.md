# AGENTS.md

This file provides repository guidance for Codex and other coding agents. Claude Code users also have `CLAUDE.md`; keep shared architectural and verification guidance aligned between the two files.

## Repository overview

`copperhead` is a TypeScript CLI agent for designing and editing real KiCad projects. It edits `.kicad_sch` and `.kicad_pcb` s-expression files, keeps design documentation synchronized, and verifies changes with `kicad-cli`. The package is ESM-only, requires Node.js 20 or newer, and is licensed under Apache-2.0.

Phase 1 is implemented. Deterministic commands and the offline test suite are the proven path; live agent-loop acceptance tests require model API keys and must not be described as passing unless they were actually run.

## Sources of truth

- Read `openspec/specs/SPEC.md` before making architectural or behavior changes. It defines the product, CLI, agent loop, tool contracts, configuration, safety rails, and acceptance criteria.
- The active Phase 1 artifacts are in `openspec/changes/build-copperhead-phase-1/`: `proposal.md`, `design.md`, capability specs, and `tasks.md`.
- The planned part-research work is separate and lives in `openspec/changes/add-part-research-tools/`; do not implement it incidentally.
- When behavior changes at the specification level, update `openspec/specs/SPEC.md` and the applicable change artifacts together.

## Build and verification

Use these commands from the repository root:

```bash
npm install
npm run typecheck
npm test
npm run build
npm run docs:build
```

Run the narrowest relevant tests while iterating, then run `npm run typecheck` and `npm test` before considering a code change complete. Run `npm run build` for CLI or packaging changes and `npm run docs:build` for documentation-site changes.

Tests that touch a live LLM are in `test/agent-integration.test.ts`. Direct providers require `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`; the saved-login Codex path is opt-in with `COPPERHEAD_TEST_CODEX=1`. Never add credentials to the repository or transcripts merely to make these tests run.

## Architecture

The main path is:

```text
Commander CLI -> provider-agnostic agent loop -> file, KiCad, and memory tools
```

Important locations:

- `src/cli.ts`: command definitions and model resolution
- `src/commands/`: deterministic check/sync/create command orchestration
- `src/agent/`: provider mappings, prompts, tools, loop, ledger, transcripts
- `src/kicad/`: `kicad-cli` wrapper, report normalization, read-only s-expression parsing
- `src/memory/`: document scaffolding, constraints, and drift detection
- `test/fixtures/`: the known-good KiCad fixture used by offline tests

TypeScript source uses ESM imports with `.js` specifiers. Keep provider-specific SDK formats inside `src/agent/providers/`; the loop should consume only the normalized internal types.

## Non-negotiable invariants

1. **Spec-gated in:** `edit_file` and `write_file` must be absent from the provider's tool list until a valid OpenSpec change proposal exists. A prompt warning is not an acceptable substitute.
2. **Verification-gated out:** every KiCad mutation must be followed by ERC, and board changes also require DRC, before success or commit. Persistent verification failure restores the git snapshot.
3. `check`/`verify` remains deterministic, LLM-free, and network-free. Its module graph must not import a provider or model SDK.
4. KiCad edits never serialize a parse tree. The agent edits with anchored exact-match text replacement; the deterministic writers (board populate, `move_footprint`, the sym-lib-table rewrite) splice the spans `src/kicad/spans.ts` locates and keep every byte they do not change. The s-expression reader validates and extracts data; it must not serialize whole KiCad files.
5. Sync obligations must be cleared before commit: drift checks, constraint dual-writes, decisions, and changelog entries are gates, not suggestions.
6. API keys stay in environment variables. `.env` and `.copperhead/runs/` stay ignored, and transcripts/summaries redact secret material at write time.
7. Preserve user work in dirty trees. Do not weaken the snapshot, rollback, path-sandbox, or verification protections to make a test pass.

## OpenSpec workflow

If OpenSpec helper skills are installed, use them. Otherwise inspect and update the artifacts directly, then validate with the CLI:

```bash
openspec status --change build-copperhead-phase-1
openspec validate build-copperhead-phase-1
openspec instructions <artifact> --change <change-name> --json
```

Do not archive a change or mark its tasks complete until implementation and the applicable verification are genuinely complete.

## Review expectations

- Treat a change as complete only when implementation, docs/specs, and relevant verification agree.
- Call out skipped live tests explicitly; a green offline suite does not prove provider parity.
- Prefer focused diffs and preserve unrelated worktree changes.
- For agent-loop changes, review all providers and the structural gates, not only the happy path for one model.
