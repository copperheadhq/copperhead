# Design: verify create stage evidence

## Explicit installed firmware toolchain follow-up

A fresh real create refused Stage7 because the supplied ESP-IDF toolchain was
available but the model catalog could not execute a build. The normal refusal
rolled back generated firmware; it is preserved in the original tool records,
not hand-restored as a successful design. An optional CLI-owned ESP-IDF adapter
closes that capability gap. It executes only the existing SDK's build in isolated
source copies, records real logs and source/binary hashes, and gates finish/resume
on current successful evidence. Explicit reproducibility compares two real
independent ELF/bin sets. Default catalogs, legacy source detection, recorded
fixtures, applicability rules and hardware verification gates remain unchanged.

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
5. **Use profile-bound package evidence.** Generic export is the default and retains prior command arguments, board-only and copper-zone support. Its manifest reports settings and fill as unverified. Explicit `outputProfile: jlcpcb-kicad9-2026-09-24` adds KiCad 9 settings, expected layer/drill metadata and copper-fill rejection, with no fallback. Both modes record current files/source hashes and ZIPs; full Stage 6 additionally requires schematic, ordering BOM and every mechanical/render export. Old projects or profile switches must re-export; probes do not synthesize evidence.
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

## Local compatibility follow-up

The recorded replay harness now explicitly selects the JLC profile because its
immutable replies inspect that manifest. No historical reply, cache key, source
hash or historical result is rewritten. Default behavior requires separate
coverage; historical 5/5 results do not validate this follow-up. See the local
compatibility review for current executed and blocked checks.

## Unexpected mutation probe failures

A focused follow-up closes the reproduced bookkeeping gap in edit_file and
move_footprint. After a write, an unexpected validation exception registers the
mutation before attempting restoration and clears the corresponding cached
check. Successful restoration still leaves fresh verification required; failed
restoration reports both errors and keeps the retained bytes tracked. Existing
normal rejection and incremental repair paths retain their behavior. This is a
local handler repair, not an exhaustive guarantee for every I/O failure or tool.
See reports/mutation-probe-fix.md for the executed scope and skipped checks.

### Ordering BOM table and reference compatibility

Generic ordering exports accept individual descriptive reference names such as
`U_MCU` and `R_GO_T5`, while rejecting grouped, duplicate or unsafe references.
The explicit JLC profile retains its canonical letter-plus-number reference check.
Every recognized parts table is parsed with its own column headers; supporting
budget tables, repeated headers and fenced examples are not exported as parts.
Missing MPNs remain completion failures; existing identities need no renaming.

### Populated reference clearance

Real medium-board population reproduced seven DRC findings before any layout
turn: underestimated descriptive-reference widths, reference-to-graphic overlap,
and reference-over-pad defaults. Opt-in `--populate-references clearance`
positions visible instance
references above intrinsic footprint bounds and packs their conservative rotated
stroke-font bounds. This changes text metadata only; pads, graphics and keepouts
remain original, hidden references remain unchanged, and all DRC findings still
block entry to layout. It does not pre-place a specific completed design.

The default library mode retains field metadata and packing bytes for existing
anchored edits and historical recordings. The CLI and runCreate input expose the
mode explicitly; printed resume commands retain it. No historical reply is edited.

### Part-selection field feedback

The fresh run selected 39 actual parts but obeyed ambiguous prompt wording by
prefixing every MPN with UNVERIFIED. It committed a successful agent run, then
failed the existing post-run selection contract. The prompt now specifies that
MPN holds only the selected identity and the qualification belongs in Rationale.
The same existing completion predicate is also checked during finish with
specific field feedback; no placeholder or prefix is newly accepted. Footprint
installation stops and post-run checks retain their existing scope.

### Earlier candidate development plans

The genuine medium firmware stage wrote DEVPLAN before Stage8; the old file-content
predicate then skipped final review. Resume now additionally checks the latest
DEVPLAN file-changing commit subject and exact current bytes. The final stage has
a finish gate comparing the plan with its entry bytes, so no-op or empty commits
cannot satisfy it. The normal agent reviews and improves the preserved candidate,
verifies and commits; no explicit rerun flag, history rewrite or full restart is
needed. The post-run gate requires the same normal stage commit evidence.

### Publication review follow-up

Ordering export excludes only identified non-purchased or explicit DNP rows,
reports them, and leaves other missing-MPN rows as actionable failures. Generated
power verification tolerates observed save defaults and exactly known historical
graphics, not arbitrary reserved-prefix bodies. Counterfeit pin/geometry tests
remain active. New normative deltas live only in this change; older proposals
carry a single cross-reference without duplicate archive requirements.
