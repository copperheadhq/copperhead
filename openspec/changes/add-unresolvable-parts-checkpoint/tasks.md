# add-unresolvable-parts-checkpoint: Tasks

## 1. Dossier resolution/render split

- [ ] 1.1 `src/kicad/dossier.ts`: `resolveBomSymbols(bomMd, dirs, opts): Promise<BomResolution>` — the existing classification loop returning structured per-part records (`status: 'resolved' | 'absent' | 'unreadable'`, refs, query, fallback, lib_id, units, alternatives, and the exact rendered body line) plus `errored` / `notSearched` / `overflow` sets and an explicit `{status: 'empty', reason}` degrade state; never throws
- [ ] 1.2 `renderDossier(resolution, opts): string` — body lines plus the existing trailer assembly, unchanged; `bomSymbolDossier` keeps its signature as `renderDossier(await resolveBomSymbols(...))`
- [ ] 1.3 Tests: classification per bucket (absent, errored, not-searched, overflow) and degrade reasons; render equivalence `renderDossier(await resolveBomSymbols(...)) === await bomSymbolDossier(...)` including under a tight `maxChars`; existing render assertions pass unmodified

## 2. Nearest-candidate suggestion search

- [ ] 2.1 `src/kicad/symlib.ts`: `nearestInstalledSymbols(query, dirs, cap = 5)` — loose pass over installed libraries on canonicalized names, qualifying by bounded edit distance or shared prefix, ordered deterministically, digit-sibling variants allowed (a suggestion is not a match claim)
- [ ] 2.2 Tests: digit-sibling suggestion found, distance-bounded hit, empty result for an alien query, cap respected

## 3. `unresolvableParts` config knob

- [ ] 3.1 `src/config.ts`: `unresolvableParts: 'agent' | 'stop'` non-optional, `DEFAULTS` `'agent'`, `loadConfig` membership test falling back to the default on any other value
- [ ] 3.2 Tests: `'stop'` maps, absent key defaults to `'agent'`, a typo falls back to `'agent'`

## 4. The parts gate

- [ ] 4.1 New `src/commands/parts-gate.ts`: `schematicPartsGate({repoRoot, docsDir, mode, onCheckpoint?, log})` → proceed/stop verdict with a `PartsCheckpointReport` (absent parts with candidates; never-checked buckets); degraded resolution proceeds with a warning in both modes; re-check loop re-reads BOM.md and re-resolves; no callback + `'stop'` → stop verdict; no callback + `'agent'` → proceed
- [ ] 4.2 Tests (`test/parts-gate.test.ts`): stop verdict on genuine absence with candidates populated; proceed + warning on an unreadable library dir; proceed when all resolve; re-check loop sees a fixed BOM shrink the report; cancel maps to stop

## 5. Pipeline wiring

- [ ] 5.1 `src/commands/create.ts`: call the gate once per schematic-stage entry (after the resume check, before the attempt loop); on stop, print the report block (absent parts + candidates, never-checked section, fix hint), write `.copperhead/runs/unresolved-parts.json` best-effort, then the canonical failure exit (resume point, cost table, run report, `ok: false`)
- [ ] 5.2 `CreateOptions` gains `confirm?` and `onPartsCheckpoint?`; `confirm` is forwarded into the stage `runAgentLoop` call so `--interactive`'s spec-approval gate actually prompts
- [ ] 5.3 Integration tests (mocked agent loop): `'stop'` + absent part → `ok: false` with no schematic agent call and the JSON report written; unreadable library dir → stage runs with the warning; a provided `confirm` reaches the schematic stage's loop options

## 6. CLI surface

- [ ] 6.1 `src/cli.ts` create action and `src/commands/demo.ts`: TTY-gated `partsCheckpointPrompt` (print report, three-way `selectMenu` re-check / continue / stop, cancel → stop) and `confirm: confirmTty`, both spread conditionally under `--interactive`
- [ ] 6.2 `--interactive` help text for create and demo names the gates accurately (spec approval, parts checkpoint, pre-export)

## 7. Docs

- [ ] 7.1 `openspec/specs/SPEC.md`: run-to-completion paragraph names the third human gate; §5 config table gains `unresolvableParts` with the `'stop'` opt-out noted
- [ ] 7.2 `docs/src/content/docs/reference/configuration.md` table row; `docs/src/content/docs/reference/cli.md` gate lists

## 8. Verification

- [ ] 8.1 Typecheck, full suite, build green
