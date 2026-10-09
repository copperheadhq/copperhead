# Design: verify create stage evidence

## Context

This change groups eight separately reviewable patches around evidence for the existing create pipeline. The public runtime and regression suite are independent of the experimental provider used during exploration. The resulting independent 500 mA design completed eight resumed stages, but that result is separate from software tests and does not certify hardware or manufacturer acceptance.

CONTRIBUTING requires a focused change, coherent OpenSpec artifacts, actual automated results, a manual sandbox log, and evidence-based invariant attestations. This directory supplies the OpenSpec change package. It does not mark unperformed validation complete.

## Goals / Non-Goals

Goals:

- Fail a stage at an actionable point when required evidence is absent, stale, altered or unsupported.
- Accept genuine generated symbols and hardware-only applicability without fabricating artifacts.
- Preserve explicit source/format/freshness limits and existing ERC/DRC, ledger and rollback gates.
- Keep every public patch independently reviewable and make verification reproducible.

Non-goals:

- No general fabrication-release claim, factory upload, order, or physical qualification.
- No new provider, model credentials, response queue, hidden completed-design fixture, or claimed provider parity.
- No broad canonical-spec migration or archive of existing OpenSpec changes.
- No assertion that prior recorded runs automatically satisfy the required manual sandbox workflow.

## Decisions

1. **Use the same spec-seed predicate at finish and completion.** It prevents committing an incomplete Budget section while retaining the later completion check.
2. **Treat firmware N/A as stage evidence.** The exact three-field declaration must be supported by populated, drift-clean, ERC-clean hardware using reviewed exact symbol identities. Unknown/custom/programmable symbols remain unsupported. Empty source does not qualify.
3. **Verify generated power definitions structurally and completely.** Reuse the engine templates and compare parsed definitions. Preserve distinct net names and ordinary installed-library checks.
4. **Separate artifact labels from real paths.** Each export job runs in a fresh temporary directory. Inventory nonempty regular files and validate the expected extension before publication. Check all known destination conflicts before copying. Publication is not a transaction against arbitrary disk failure.
5. **Use bounded package evidence.** Explicit KiCad 9 settings, expected layer/drill metadata, ordering BOM, deterministic bounded ZIP and source/file hashes are required. Copper-fill zones and unsupported major versions fail; unrelated stale outputs are excluded.
6. **Keep support fixes separate.** Compatibility fixture edits preserve nondefault semantics; the launcher uses the supported Node import route; the lint alias retains the existing Markdown rules.

## Specification mapping

| Patch concern | Authoritative location | Related active change |
| --- | --- | --- |
| Budget feedback before commit | SPEC content-aware completion and this create-pipeline delta | turn-budget-continue-and-loop-efficiency |
| Firmware source/N/A evidence | SPEC section 2.5 and this create-pipeline delta | build-copperhead-phase-1; add-supplier-bom-export |
| Generated power definition checks | SPEC symbol verification and this agent-core delta | add-symbol-pin-dossier |
| Fresh export inventory | SPEC outputs and this agent-core delta | build-copperhead-phase-1 |
| Explicit manufacturing package | SPEC stage-6 integrity and this manufacturing-package delta | build-copperhead-phase-1 |
| Test compatibility and lint entrypoint | Existing test and development contracts | No new product capability |

The official CLI discovers no specs from the flat `openspec/specs/SPEC.md`. Passing this change validation therefore does not validate that monolithic document or prove that every legacy change is archive-ready. Existing MODIFIED deltas whose canonical target does not exist remain a repository-level migration concern.

## Risks / Trade-offs

- The verified profile initially supports KiCad 9 without copper-fill zones. A future extension needs its own version/fill evidence; silently widening support would overstate verification.
- Source freshness covers board, schematic hierarchy, BOM and present project settings, not every external model/library or `.kicad_dru` dependency.
- The current design still has four raw J1 hole-clearance errors. Passing the project's normalized gates is not zero-error raw DRC or fabrication release.
- The firmware identity list is conservative and requires reviewed extensions. “Programmable current limit” alone is not evidence of a programmable processor.
- The changes remain independently reviewable; the combined results do not remove version, provenance or physical-validation limits.

## Validation and handoff

The previously verified public combination passed 1293 tests with 21 skipped, plus typecheck, build and Markdown lint. The authentic recorded-response replay has now been integrated: the combined default suite passed 1296 tests with 23 skipped, and the separate explicitly gated replay job passed all five cases. Its prepared KiCad 9 command and negative controls are documented in reports/create-recorded-e2e.md; no remote CI run is claimed. Final branch checks and official OpenSpec validation are recorded in validation.md when run.

The documented edit sandbox and evidence-based invariant mapping are recorded in reports/manual-test-log.md and reports/invariant-evidence.md. The optional live model-backed do command was not rerun; official-provider, remote-CI and physical testing limits remain disclosed. No stage marker or real design was manually supplied to satisfy these documentation tasks.
