# add-llm-routing-stage: Design

## Context

`create` stops at stage 6 on every board because stage 5 delivers a draft with ratsnest by contract and stage 6 will not export one (#328). The engine work (RFC 11 wrapped routers, the RFC 14 placer) is parked, so for now the model routes. The model already places by moving footprints and routes power with `edit_file` on the `.kicad_pcb`; what it lacks is a stage whose contract is "fully routed", tools that write track and via text without hand-authoring s-expressions, and a view of what is left to route. The invariants hold as for layout-draft: anchored text edits only, DRC before done, rollback to the last verified board.

## Goals / Non-Goals

**Goals:**

- A `create` run on a small board (the USB-C breakout, a dozen parts) reaches the outputs package without a human, routed by the model alone.
- Track and via writing is a text operation the model cannot get syntactically wrong; geometry stays the model's decision.
- The stage is as verified and reversible as layout-draft: DRC-clean, parity-clean, zero unrouted, or the last verified board comes back.

**Non-Goals:**

- Routing quality beyond DRC-clean and budget-respecting copper; no autorouter, no placer, no length matching.
- A deterministic width gate. The SPEC.md budgets stay the model's to honour and the outputs stage's to review, as today.
- Multilayer beyond the two-layer scaffold, and changing layout-draft's own contract.

## Decisions

**D1. A separate stage, not a stricter layout-draft.** Placement and routing have different turn budgets, different repair patterns and different failure modes; a single stage that must end fully routed would roll back a good placement when routing runs out of turns. A stage boundary also commits the placement (the layout-draft commit) so the routing stage's rollback never reaches it. Alternative rejected: keep one stage and raise its budget, which makes every retry redo placement.

**D2. Tools write text at one anchor; the parser stays read-only.** `add_track` emits one `(segment …)` per polyline edge and `add_via` one `(via …)`, each with a fresh uuid and the net code looked up by net name from the board's `(net N "name")` table, inserted before the board's closing parenthesis by the same span logic populate uses. The result is probe-loaded in a temp copy with `kicad-cli` before the board is written (AC-15.20 semantics), and the write marks the board touched so `finish` needs `run_drc`. Alternative rejected: letting the model write segments with `edit_file`, which it can do today and which produced malformed nets and missing uuids in live runs.

**D3. Read tools give the model coordinates, not advice.** `board_pads` derives each pad's absolute position from the footprint's `(at x y rot)` and the pad's own offset, reusing the transform `footprintBounds` already applies, with layers, size and net. `list_unrouted` reads the DRC report's `unconnected_items` and reports each connection's net and both endpoints with positions. Neither tool suggests a path: that is the model's job now and an engine's later.

**D4. Completion is deterministic and stricter than layout-draft by exactly one term.** `isComplete`: board matches schematic (parity, reused from layout-draft), DRC ok, DRC's unrouted count is 0, and `## Draft quality` is present (the stage rewrites its content). The contract-gap message names the unrouted count and the first connections. `finish` consults it through `stageGate`.

**D5. Board keeping is generalized, not duplicated.** The layout-draft mechanics (pre-stage board, `preTouched`, `restoreVerifiedBoard`, retry from the last verified board, populate idempotent re-check) become "board stage" behaviour selected by a `board: true` flag on the stage, with populate remaining layout-draft's step only. The routing stage's retry starts from the board the previous attempt committed when it matches the schematic, else the pre-stage board (the layout-draft commit).

**D6. The unrouted guard stays the ceiling, and the stage sets the target.** `run_drc`'s `unrouted_increase` check (AC-15.39) still fails a run that breaks a connection. A re-route (remove a track, add another) must happen within one batch before `run_drc`; the prompt says so. Zero is a completion term, not a `run_drc` failure, so mid-stage checks report progress instead of failing.

**D7. Widths come from the prompt, budgets from the system prompt.** The stage prompt lists default widths (signal 0.25 mm, power per the SPEC.md budget, else 0.5 mm) and requires the widths used per net class in `## Draft quality`; the `budgets` config and SPEC.md constraints already reach every run's system prompt. No new plumbing.

## Risks / Trade-offs

- [The model routes badly or slowly: a dozen parts may take an hour and hundreds of thousands of output tokens] → A stage of its own with its own `stageMaxTurns`; the live smoke records the cost; engines replace the model later behind the same contract.
- [Two-layer routing with vias needs the scaffold's `.kicad_dru` 0.3 mm drill rule honoured] → `add_via` defaults to a 0.3 mm drill and 0.6 mm size and refuses smaller drills, naming the rule.
- [A re-route that removes a track and runs DRC before the replacement fails on `unrouted_increase` and spends a repair cycle] → The prompt requires remove and add in one batch; the gap message says which connection the count rose on.
- [Existing projects with a partially routed board start the routing stage on resume and spend turns] → Only boards with ratsnest do; a routed board is complete without a turn.
- [The outputs stage still refuses on a budget the model missed] → It should: that is the last line of defence. The routing prompt carries the budgets and the Draft quality width table makes the miss visible.

## Migration Plan

Additive: a ninth stage with state-based completion. Repositories mid-pipeline resume normally; a repository at `outputs` with a routed board passes the new stage without a turn. Rollback is removing the stage entry; the tools stay useful.

## Open Questions

- Whether `list_unrouted` should also be exposed in `check --json` now (cheap, LLM-free) or wait for the fab gate change.
- Default `stageMaxTurns` for `routing` (proposal: the global default, with the docs recommending a higher per-stage value for boards over twenty parts).
