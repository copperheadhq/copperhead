# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

**copperhead** — "Cursor for circuit boards": a TypeScript CLI agent that designs and edits real KiCad projects (`.kicad_sch`/`.kicad_pcb` s-expression files), keeps markdown design docs as memory, and verifies its own work with `kicad-cli` ERC/DRC. Apache-2.0, Node ≥ 20.

**Current state: Phase 1 implemented, pending full live verification.** The CLI builds and runs (`init`, `check`/`verify`, `do`, `sync`, `create`), and the offline test suite is green. Live AC-3.x integration tests run only for explicitly configured providers: API keys enable the direct OpenAI/Anthropic paths, and `COPPERHEAD_TEST_CODEX=1` enables the local saved-login Codex path. See the status note at the top of `openspec/changes/build-copperhead-phase-1/tasks.md` for the exact split.

## Sources of truth

- `openspec/specs/SPEC.md` — the complete technical specification: product definition, architecture, CLI surface, agent loop, tool schemas, config, safety rails, and binary acceptance criteria (AC-1 … AC-7). Read this before any design or implementation work.
- `openspec/changes/build-copperhead-phase-1/` — the active change: `proposal.md` (what/why), `design.md` (decisions D1–D14 with rationale), `specs/*/spec.md` (seven capability delta specs with WHEN/THEN scenarios), `tasks.md` (implementation checklist in dependency order).

When spec-level behavior changes, update SPEC.md and the change artifacts together — the delta specs' scenarios are meant to map 1:1 onto SPEC.md's acceptance criteria.

## Workflow (OpenSpec)

This repo uses OpenSpec spec-driven development. Planning artifacts are managed with the `openspec` CLI and the `/opsx:*` skills:

- `/opsx:apply` — implement tasks from the change (check off `tasks.md` as you go)
- `/opsx:update` — revise planning artifacts coherently (never edits code)
- `/opsx:archive` — archive the change when implemented; merges delta specs into `openspec/specs/`

Useful commands:

```bash
openspec status --change build-copperhead-phase-1   # artifact/task state
openspec validate build-copperhead-phase-1          # validate change (positional arg, not --change)
openspec instructions <artifact> --change <name> --json  # rules/template for an artifact
```

## Architecture (per SPEC.md §2)

CLI (commander) → provider-agnostic agent loop → three tool families: file tools (read/edit/search, sandboxed to repo root), KiCad tools (`kicad-cli` ERC/DRC/SVG as subprocess), memory tools (docs + constraint registry). Layout: `src/cli.ts`, `src/commands/` (check, sync, create), `src/agent/` (loop, OpenAI/Anthropic/local-Codex providers, prompts, tools), `src/kicad/` (cli wrapper, read-only sexp parser, report normalizer), `src/memory/` (scaffold, drift), `test/fixtures/` (tiny known-good KiCad project). Build: tsc → `dist/`, bin `copperhead`; tests: vitest (LLM-touching integration tests run only when their provider is explicitly configured).

Two invariants shape everything (SPEC.md §1.3):

1. **Spec-gated in** — the agent's `edit_file`/`write_file` tools are structurally absent from the tool list until an OpenSpec proposal for the change validates. Not prompt-discouraged; absent.
2. **Verification-gated out** — no mutation is "done" until ERC (and DRC if the board changed) passes; repair up to `maxRepairCycles`, then rollback to the git snapshot.

Other load-bearing decisions (full rationale in `design.md`):

- KiCad files are never serialized from a parse tree (no round-tripping): the agent edits them by anchored exact-match text replace, and the deterministic writers (board populate, `move_footprint`, the sym-lib-table rewrite) splice the spans `src/kicad/spans.ts` locates, keeping every byte they do not change.
- `check` (alias `verify`) is contractually LLM-free and network-free — CI/pre-commit safe. `sync` = deterministic verify phase + LLM resolve phase; it never silently resolves a requirement violation (truth precedence: KiCad files = as-built facts, specs/budgets = requirements).
- The loop keeps a sync-obligations ledger fed by post-tool-call hooks; commit refuses while any obligation (drift check, constraint dual-write, DECISIONS/CHANGELOG entries) is open.
- User-visible memory: `docs/DECISIONS.md` (append-only decision log), `docs/CHANGELOG.md` (per-run design changelog), `.copperhead/runs/<ts>/summary.md` beside each JSONL transcript, `.copperhead/README.md` (self-describing config).

## Constraints to respect when implementing

- `.gitignore` must include `.env` and `.copperhead/runs/` from the very first commit (AC-4.3).
- Transcripts/summaries redact `sk-[A-Za-z0-9_-]+` at write time; keys live only in env vars (AC-4.1).
- Priority if time is short: AC-3.4 (budget refusal) > AC-3.2 (constraint-aware pin choice) > AC-3.1 (propagating rename) > AC-2.1 > AC-1.2.
- Phase 2 (live viewer) and Phase 3 (integrations) are documented in SPEC.md but out of scope for the current change.
