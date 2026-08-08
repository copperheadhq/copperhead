# add-unresolvable-parts-checkpoint: Proposal

## Why

The stage-4 pin dossier resolves every BOM part against the installed libraries before the first agent turn, so at schematic-stage entry the pipeline already holds the complete list of parts with no installed symbol. Today that list has exactly one consumer — the agent — which then spends expensive turns negotiating functional substitutes: on the lemondrop brief (run-logs/2026-08-07T17-52-03, upstream #206), attempt-02 spent ~12 turns swapping the same three parts that attempt-05 later paid to re-derive, at hundreds of thousands of tokens per stage-attempt. Choosing a substitute from a candidate list is a decision a human makes in seconds; the expensive agent work worth keeping is the follow-through (pin map, datasheet consequences), not the deliberation.

Stage 3's `search_symbols` requirement already keeps fresh BOMs from reaching stage 4 with absences; this checkpoint is the cheap exit for legacy or resumed workspaces where the BOM predates that rule.

A prerequisite gap surfaces alongside: `create` never forwards a confirm callback, so `create --interactive`'s advertised spec-approval gate silently auto-approves (the loop defaults `confirm` to always-true). The checkpoint needs that plumbing, and fixing it makes the existing gate real.

## What Changes

- **Resolution split from rendering**: `bomSymbolDossier` becomes `renderDossier(await resolveBomSymbols(...))`, where `resolveBomSymbols` returns the structured result (per-part status: resolved / absent / unreadable, plus errored, not-searched, and overflow disclosure sets, and an explicit empty-with-reason degrade state). The rendered dossier block stays byte-identical; no consumer ever greps rendered text for absence.
- **Stage-4 parts checkpoint**: once per schematic-stage entry (after the resume check, before the first attempt), the pipeline resolves the BOM and computes the genuine absence set — but only when something consumes it (a prompt is available, or the policy is `'stop'`); the default `'agent'` path with no prompt skips the scan entirely, keeping default entry byte-identical to today. With `--interactive` on an attended terminal it pauses before any tokens are spent, showing each absent part with its refdes, query, and nearest installed candidates, and offers re-check (the human edits `docs/BOM.md`, the pipeline re-resolves) / continue / stop.
- **`unresolvableParts` config knob** (`'agent' | 'stop'`, default `'agent'`): `'agent'` preserves run-to-completion exactly as today; `'stop'` fails fast before the first schematic agent turn with a structured report — stdout block plus `.copperhead/runs/unresolved-parts.json` — naming each absent part, its candidates, and the resume command, so the human fixes the BOM and resumes at one stage-entry's cost.
- **Nearest-candidate search for absences**: a new looser search (`nearestInstalledSymbols`) qualifies suggestions by edit distance or shared prefix, including the digit-sibling variants the dossier's match ranking deliberately refuses — a valid *suggestion* for a human is not a *match* claim. Only the checkpoint pays for it; the advisory dossier path is untouched.
- **`create --interactive` confirm plumbing**: `create` (and `demo`) forward a real TTY confirm callback into the agent loop, making the existing spec-approval gate prompt instead of silently auto-approving, and the `--interactive` help text and docs name the gates accurately (spec approval, parts checkpoint, pre-export).

## Capabilities

### Modified Capabilities

- `create-pipeline`: stage-4 entry gains the opt-in unresolvable-parts checkpoint and the `unresolvableParts` policy; the dossier requirement's never-blocks clause is amended so the opt-in checkpoint is its only sanctioned gate; `create --interactive` forwards a real confirm callback.

## Impact

- **Code**: `src/kicad/dossier.ts` (resolution/render split); `src/kicad/symlib.ts` (new `nearestInstalledSymbols`); `src/config.ts` (`unresolvableParts` with validate-or-fallback); new `src/commands/parts-gate.ts` (`schematicPartsGate`); `src/commands/create.ts` (gate hook before the attempt loop, stop exit path, `confirm`/`onPartsCheckpoint` in `CreateOptions`); `src/cli.ts` and `src/commands/demo.ts` (TTY-gated checkpoint prompt via `selectMenu`, `confirm: confirmTty`, help text).
- **Tests**: `test/dossier.test.ts` gains resolution-classification and render-equivalence cases (existing render assertions unchanged — the regression net); new `test/parts-gate.test.ts`; `nearestInstalledSymbols`, config-knob, and `runCreate` integration cases (stop fires before the schematic loop, degraded resolution proceeds with a warning, `confirm` reaches the loop).
- **Unchanged contracts**: `check`/`verify` stay LLM-free and network-free; spec-gating of edit tools is unaffected; the advisory dossier block is byte-identical and still never blocks on its own failure; default configuration keeps run-to-completion byte-identical to today.
- **Not in scope**: enforcing dossier coverage as an unconditional stage gate (fuzzy matching in a gate would refuse valid BOMs — same reasoning as add-symbol-pin-dossier); the pre-export review gate (still unimplemented, tracked separately); reusing the checkpoint's resolution for the attempt-1 dossier render (follow-up optimization).
