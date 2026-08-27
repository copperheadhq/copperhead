# add-fab-release-gate: Design

## Context

`check` is the LLM-free, network-free verification surface (AC-2.x): ERC + DRC + drift + constraint checks, safe for CI and the pre-commit hook. The `create` pipeline's stage 6 already exports gerbers/drill/BOM.csv via `kicad-cli`, but nothing verifies that a repo is actually ready to send to a fab. The gate must reuse the two load-bearing pieces we already trust: the read-only s-expression parser (`src/kicad/sexp.ts`) and the normalized DRC report (`src/kicad/report.ts`).

## Goals / Non-Goals

**Goals:**

- A single opt-in flag (`check --fab`) that answers "can I order this board today?" deterministically.
- Every failure names the artifact, the claim, and the actual state, in the same voice as drift reporting.
- Zero new runtime dependencies; zero network or LLM calls.

**Non-Goals:**

- No fab-house API integration (upload, quoting): that is Phase 3+ territory and would break the network-free contract.
- No autorouting or fixing: the gate reports, the agent loop (or the human) repairs.
- No panelization, stackup, or impedance checks in this change.

## Decisions

- **D1: Gate lives inside `check`, not a new command.** `check --fab` keeps one verification entry point, inherits the network guard and `--json` plumbing, and means the pre-commit hook can adopt it with one config line. Alternative: `copperhead fab-check` as a sibling command — rejected because it would duplicate the contract ("which command is CI supposed to run?") and dilute the `check`-is-the-gate story.
- **D2: Routing completeness comes from the existing DRC report.** `kicad-cli pcb drc` already reports `unconnected_items`; the gate reads the normalized report and fails when the unconnected count is nonzero, listing each net. Alternative: parse `.kicad_pcb` for missing track segments ourselves — rejected; KiCad's own engine is the authority and we never reimplement its checks.
- **D3: Schematic-to-PCB match via the sexp reader on both files.** `list_symbols` on the schematic vs footprint enumeration on the board, joined on refdes; footprint IDs must also agree. This is a read-only diff in the drift style, not a netlist regeneration. Alternative: `kicad-cli sch export netlist` + compare — deferred; refdes/footprint parity catches the ordering-relevant divergence without adding an export step to `check`'s <60 s budget.
- **D4: Output freshness by recorded content hash, not mtime.** At export time (create stage 6, or a future `export` command) the SHA-256 of the source `.kicad_pcb` is written to `.copperhead/config.json` next to the output paths. `check --fab` recomputes and compares. mtime is untrustworthy across clones and CI checkouts; hashes survive `git clone`. Missing hash record with outputs present is reported as "unverifiable freshness" (failure, with the regeneration hint).
- **D5: `UNVERIFIED` BOM rows are a warning by default, a failure with `--strict`.** Ordering prototypes with unverified parts is a legitimate, human-approved act; blocking it by default would make the gate get bypassed. `--strict` exists for release CI. Missing MPN or missing footprint is always a failure: those rows cannot be ordered at all.
- **D6: JSON shape mirrors the existing report.** `fab: { routing, bom, schPcbMatch, outputs, docs }`, each `{ status: "pass" | "warn" | "fail", violations: [{claim, actual, location?}] }`. Stable keys per AC-2.4.

## Risks / Trade-offs

- [DRC report schema drift across KiCad versions] → the normalizer already pins tested `kicad-cli` versions; fab-gate tests run against captured fixture reports, and version detection warns on untested majors.
- [Hash-freshness false positives after innocuous reformatting] → acceptable: a changed board file means outputs must be re-exported to be provably current; the failure message includes the one-line fix.
- [Gate inflates `check` runtime past the 60 s budget] → all checks are local parsing over files already read; the DRC run is shared with plain `check`, not repeated. Budget asserted in tests.
- [BOM readiness depends on BOM.md discipline] → drift checking already guarantees BOM.md matches the schematic; the fab gate only adds column-completeness checks on top.

## Migration Plan

Purely additive flag; no behavior change without `--fab`. Rollback is removing the flag. On archive, SPEC.md's `check` section and AC-2 gain the fab-gate criteria.

## Open Questions

- Whether stage 6 should start writing the export hash record immediately (task here) or wait for a dedicated `copperhead export` command (Phase 3 idea); this change writes it in stage 6 and any future export path inherits the contract.

## Issue #252 follow-on (placement/routing engine boundary)

The routing-completeness gate (task 1.1) and the `--fab`/`--strict` CLI wiring (tasks 3.1–3.3) were delivered under issue #252; the remaining checks (BOM readiness, schematic-to-PCB match, output freshness — tasks 1.2–1.4) are unchanged and out of #252's scope. Issue #252 also landed the board half of `create` end to end: board population from the exported netlist (`src/kicad/board.ts`, `netlist.ts`, `fplib.ts`), a deterministic grid placer (`PlacementEngine`), a TypeScript Specctra DSN/SES bridge plus a local Freerouting adapter (`RoutingEngine`), and the `layout_board` agent tool driving populate → place → route → DRC → rollback. The routing-completeness gate is wired into the export step (`export_outputs`) so an unrouted board cannot silently reach fabrication without an explicit override. Connectivity-aware placement remains a deferred follow-up (#141), not part of #252.
