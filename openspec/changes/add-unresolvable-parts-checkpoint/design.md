# add-unresolvable-parts-checkpoint: Design

## Context

`bomSymbolDossier` (src/kicad/dossier.ts) classifies every BOM part deterministically before stage 4's first agent turn, but returns only a rendered prompt string; the absence set exists transiently at the NO-INSTALLED-SYMBOL branch and is immediately stringified. `create` runs the dossier per attempt inside the retry loop, advisory-only, under a 60s timeout. `CreateOptions` carries no confirm callback, so the loop's `confirm` defaults to always-true and `create --interactive`'s spec gate never prompts. The run-to-completion guarantee (SPEC.md §"Run-to-completion") is load-bearing: gates are quality checks the agent must satisfy, not stops that wait for a human, unless `--interactive`.

## Goals / Non-Goals

**Goals:**

- Spend human attention before tokens: absences surfaced at stage-4 entry, decided in seconds, with candidates to pick from.
- A fail-fast mode for unattended runs that costs one stage-entry to fix and resume, opt-in, never the default.
- Zero change to the advisory dossier path: same bytes, same never-blocks contract on its own failure.

**Non-Goals:**

- No unconditional gate on dossier coverage: fuzzy MPN-to-symbol matching in a gate would refuse valid BOMs (add-symbol-pin-dossier's reasoning stands).
- No pre-export review gate; that remains its own unimplemented promise, tracked separately.
- No network or LLM calls anywhere in the checkpoint.

## Decisions

- **D1: Checkpoint once per stage entry, before the attempt loop — not per attempt.** The gate exists to spend human attention before tokens; retries are the autonomous recovery path, and pausing each retry turns run-to-completion into babysitting. Correctness holds because a failed attempt's rollback (`git reset --hard` + `git clean -fd`) restores `docs/BOM.md` to the stage-3-committed state, so every attempt starts from the BOM the human approved at entry; the per-attempt advisory dossier stays as the safety net. Alternative: a per-attempt gate reusing the resolution for the dossier render — rejected: tighter coupling, restructures the attempt loop, re-pauses on identical BOMs.
- **D2: The gate runs its own resolution scan; the per-attempt dossier path is left byte-for-byte alone.** Cost: one extra bounded library scan per opted-in schematic-stage entry (own 60s timeout) — with no prompt available and the default `'agent'` policy the gate short-circuits before resolving anything, since nothing would consume the result, so the default path pays no scan and prints no warning. Benefit: zero regression risk in the advisory path, `test/dossier.test.ts` stays the untouched regression net, and because the gate consumes the same classifier, the I15 no-false-absence guard carries over automatically. Alternative: thread the gate's resolution into attempt 1's render (saves one scan) — deferred as a follow-up optimization.
- **D3: Interactive UX is a `CreateOptions.onPartsCheckpoint` callback resolved by a three-way `selectMenu`** (re-check / continue / stop), TTY-gated in `cli.ts` the way `budgetContinuePrompt` is, with Esc/cancel mapping to stop — the safe default spends nothing. Absent callback (non-TTY, `--json`, tests), the configured `unresolvableParts` mode applies. Alternative: chained y/N `confirmTty` questions — rejected: ambiguous UX ("continue?" inverted between questions), and the injectable-key-stream `selectMenu` already exists.
- **D4: Precedence — interactive pause > `'stop'` > `'agent'`.** A present human always beats fail-fast; pausing is strictly better than dying when someone can act. `'stop'` only fires when no prompt is available.
- **D5: The stop condition is `status: 'ok'` resolution with a non-empty absence set — nothing else.** Whenever the gate actually resolves (a prompt is available, or the policy is `'stop'`), a degraded resolution (no readable libraries, timeout, parse error) proceeds with a warning, because "could not check" must never fail a run as "checked and absent"; parts disclosed as unresolved-by-error, not-searched, or past the size cap never trigger the gate and are labeled "never actually checked" in every report. This inherits I15's contract at gate strength, where a false absence claim would now kill a run instead of merely misleading a prompt.
- **D6: The machine-readable stop report is a separate `.copperhead/runs/unresolved-parts.json`** (best-effort, like `writeRunReport`), not a mutation of `report.json`'s stable diffing schema.
- **D7: The candidate search relaxes the digit-swap refusal.** `oneEditFamilyVariant` refuses digit-for-digit substitutions because it protects a *match* claim (a TPS22810 is not a TPS22860). The checkpoint's `nearestInstalledSymbols` is a *suggestion* list for a human, where the digit sibling is exactly what they want to see; it qualifies by bounded edit distance or shared prefix and is called only from the gate, so the dossier hot path never pays for it.

## Risks / Trade-offs

- [Double scan per schematic entry (gate + attempt-1 dossier)] → both bounded by independent 60s timeouts; measured scans are far cheaper than one agent turn; D2's alternative is the documented follow-up if it ever matters.
- [False stop on a broken environment] → structurally prevented by D5: every degrade path proceeds-with-warning, pinned by a delta-spec scenario and tests.
- [A re-check after a worse edit approves stale data] → the re-check loop re-reads and re-resolves every time, so a newly introduced absence is shown before approval; the attempt-1 dossier re-reads the same approved file seconds later.
- [Prompt collides with the interactive renderer's status line] → the pause fires between stages while the renderer is idle; `onBudgetExhausted` already proves a readline prompt coexists with it, and `selectMenu` restores raw-mode state.

## Migration Plan

Purely additive: default `unresolvableParts: 'agent'` without `--interactive` is byte-identical to today. Rollback is removing the gate call and the config key; the dossier split is invisible to consumers. On archive, SPEC.md's run-to-completion paragraph names the third human gate and §5 gains the config row.

## Open Questions

- None blocking. Whether stage-4 entry should eventually reuse the gate's resolution for the attempt-1 dossier render (D2 alternative) is left to a follow-up measurement.
