# add-llm-routing-stage: Proposal

## Why

No stage of `create` finishes routing (#328). Stage 5 (`layout-draft`) completes, by contract, with ratsnest and draft-width power tracks (SPEC §2.5, AC-15.38, AC-15.39), and stage 6 (`outputs`) then correctly refuses to fabricate a board that violates the design's own requirements (unrouted nets, power copper below the SPEC.md budget). Every run that reaches stage 6 therefore stops for a human, against the run-to-completion guarantee. The placement and routing engine track is parked for now: the model does the routing, and the engines can replace it stage by stage later.

## What Changes

- **A `routing` stage between `layout-draft` and `outputs`.** The model routes every remaining connection and brings power copper to the SPEC.md budgets, on the board layout-draft left. The stage completes only when the board still matches the schematic (AC-15.38's parity), DRC is clean, DRC reports zero unrouted connections, and LAYOUT.md's `## Draft quality` section states what was routed and the widths used. `outputs` follows it unchanged.
- **Board-writing tools for tracks and vias.** `add_track` (net, layer, polyline, width) and `add_via` (net, position, drill, size) write KiCad track and via text into the board by anchored insertion, look the net code up from the board's own net table, probe-load the result with `kicad-cli` like `edit_file`, and open the DRC obligation. The model chooses geometry; it never hand-writes a `(segment …)`. Both are spec-gated like `edit_file`. Removing or re-routing a track stays an `edit_file` on the segment's own text.
- **Board-reading tools.** `board_pads` lists each part's pads with absolute position, layers, size and net, and `list_unrouted` lists each unrouted connection (net, both pad endpoints, positions) from the DRC report. Read-only, LLM-free, usable by `check` later.
- **Stage mechanics shared with layout-draft.** The routing stage keeps the pre-stage board, restores the last verified board on every exit that does not complete, starts each retry from the last verified board, counts the board as touched, and checks its own contract at `finish` (the `stageGate` from #310). The layout-draft prompt and contract do not change.
- **Resume.** A repository whose board is already fully routed and DRC-clean counts the stage complete without a model turn, so existing projects are unaffected until their board has ratsnest.
- **BREAKING (pipeline shape).** `create` has nine stages; `stageMaxTurns` accepts `routing`; the docs pipeline page and SPEC §2.5 diagram gain the stage. `--interactive`'s two human gates do not move.

## Capabilities

### Modified Capabilities

- `create-pipeline`: the routing stage, its completion contract, its prompt, resume and retry behaviour, and its place before `outputs`.
- `kicad-tooling`: the `add_track`, `add_via`, `board_pads` and `list_unrouted` tools; unrouted connections with endpoints from the DRC report.

## Impact

- **Code**: `src/commands/create.ts` (a ninth `STAGES` entry, the board-keeping and stage-gate mechanics generalized from layout-draft to any board stage), `src/capabilities/handlers.ts` (four tools), `src/kicad/populate.ts` or a new `src/kicad/tracks.ts` (net table lookup, pad absolute positions reusing the footprint transform, track and via text, anchored insertion before the board's closing paren), `src/kicad/report.ts` and `src/kicad/cli.ts` (unconnected items with their endpoints), `src/agent/prompts.ts` (tool descriptions), `src/config.ts` (no change: `stageMaxTurns` is keyed by stage name).
- **Tests**: `test/board-tracks.test.ts` (tools against real `kicad-cli`: the text loads, DRC sees the track on its net, refusals), `test/create-routing.test.ts` (stage completion, resume, retry, rollback, gate), `test/report.test.ts` (unrouted endpoints).
- **Invariants**: the s-expression parser stays read-only (tracks and vias are inserted as text at one anchor, never by re-serializing the board). The tools are absent until the proposal validates, as `edit_file` is. Every board mutation still ends in a passing DRC or is rolled back; the stage's contract adds "zero unrouted" on top of DRC-clean. `check` stays LLM-free. Nothing reaches the network.
- **SPEC.md**: §2.5 pipeline diagram and a "Routing" bullet under first-draft layout; new acceptance criteria AC-15.45 to AC-15.49; the `stageMaxTurns` example.
- **Not in scope**: a deterministic router or placer (parked), width budgets as a deterministic gate (the budgets stay free-form SPEC.md constraints the model honours and the outputs stage reviews), differential-pair or length-matching tools, and changing what layout-draft delivers.
