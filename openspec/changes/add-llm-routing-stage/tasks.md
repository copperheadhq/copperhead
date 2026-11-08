# add-llm-routing-stage: Tasks

## 1. Board reading

- [ ] 1.1 `src/kicad/tracks.ts`: net table lookup (`netCode(boardText, name)`), pad absolute positions per footprint (reuse the transform in `footprintBounds`), `boardPads(boardText, refs?)`
- [ ] 1.2 `src/kicad/report.ts` / `cli.ts`: `unconnected_items` normalized with net name and both endpoints (refdes, pad, position) as `unrouted[]` beside the count
- [ ] 1.3 Tests: pad positions at 0/90/180/270 against DRC item coordinates on the populated fixture board; unrouted endpoints from a real DRC report

## 2. Track and via tools

- [ ] 2.1 `src/kicad/tracks.ts`: `trackText(net, layer, points, width)` and `viaText(net, at, drill, size)` with fresh uuids; `insertBeforeClose(boardText, text)` by span; refusals (unknown net or layer, width <= 0, drill under the project rule)
- [ ] 2.2 `src/capabilities/handlers.ts`: `add_track`, `add_via` (spec-gated like `edit_file`; probe-load in a temp copy; `markTouched`), `board_pads`, `list_unrouted` (read-only); tool descriptions in `src/agent/prompts.ts`
- [ ] 2.3 Tests against real `kicad-cli`: the board loads, DRC shows the connection routed, unrouted count falls, refusals leave the board byte-identical, tools absent before the proposal validates

## 3. The routing stage

- [ ] 3.1 `src/commands/create.ts`: generalize the layout-draft board keeping (pre-stage board, `preTouched`, `restoreVerifiedBoard`, retry from the last verified board, `stageGate`) to a `board` stage flag; populate stays layout-draft's step
- [ ] 3.2 `STAGES`: `routing` after `layout-draft` with `isComplete` (parity, DRC ok, unrouted 0, Draft quality present), the prompt (default widths, budgets, one-batch re-route, width table in Draft quality), and `contractGapDetail` naming the count and first connections
- [ ] 3.3 Tests (`test/create-routing.test.ts`): a routed board completes, ratsnest does not, resume skips a routed board, a failed stage leaves layout-draft's board, a retry keeps a committed attempt, `stageGate` names the gap

## 4. Spec and docs

- [ ] 4.1 SPEC.md: §2.5 pipeline diagram and a Routing bullet; AC-15.45 to AC-15.49 (stage completion, board keeping, resume, track/via tools, board reading tools); `stageMaxTurns` example
- [ ] 4.2 Docs: the pipeline page (nine stages), the tools reference, the configuration page (`stageMaxTurns.routing`)
- [ ] 4.3 `openspec validate add-llm-routing-stage` passes; `npm run typecheck`, `npm run build`, `npm test`

## 5. Live verification (opt-in)

- [ ] 5.1 `create` on `examples/simple/usb-c-breakout.md` with a saved-login provider reaches `outputs` with gerbers on disk; record turns, tokens and wall time per stage in the PR
