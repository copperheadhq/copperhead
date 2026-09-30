# add-hosted-run-seam: Tasks

## 1. Transcript event bound

- [ ] 1.1 Add a named `MAX_EVENT_BYTES` constant (131072) to `src/agent/transcript.ts`, chosen against measured traffic (1106 real events: median 337, p99 18042, max 60981) so no observed event truncates
- [ ] 1.2 Enforce the bound inside `Transcript.event()`, after `redactSecrets` and before the append, so redaction cannot be split at the truncation boundary and both write-time invariants sit on one line
- [ ] 1.3 Replace an over-bound payload with a truncation marker recording the original byte count; never drop the event, since the transcript is both an audit trail and a resume input
- [ ] 1.4 Tests in `test/safety.test.ts`: an oversized event yields one line carrying the original size, an ordinary event is written whole, and a credential positioned across the boundary is still fully redacted

## 2. Storage-credential redaction

- [ ] 2.1 Add a shared-access-signature pattern to `src/util/redact.ts` beside the seven existing patterns
- [ ] 2.2 Test it in `test/safety.test.ts`'s `secret redaction (AC-4.1)` block, one case per shape as the existing seven are, so a future storage backend with a different credential shape fails a test rather than a transcript
- [ ] 2.3 Regression case asserting a GitHub App installation token inside an `x-access-token:...@github.com` clone URL is redacted by the existing `gh[pousr]_` pattern, so the Git side is covered by assertion rather than by assumption

## 3. The `.copperhead/` layout contract

- [ ] 3.1 State the layout in `.copperhead/README.md`: which entries are runs, which are not, and which are artifact sources
- [ ] 3.2 State the classification rule (committed means reference, ignored means stored) with the current producer table, so a producer added later classifies itself
- [ ] 3.3 State that retention is run-state aware: an artifact belonging to a resumable run is not eligible for deletion regardless of age

## 4. Seam types

- [ ] 4.1 Define `Workspace`, `WritebackResult` and `ArtifactRef`, versioned from the first definition
- [ ] 4.2 Give `ArtifactRef.location` its own `kind: 'repo' | 'blob'` discriminant, kept distinct from the top-level role `kind`
- [ ] 4.3 Include `WritebackResult`'s policy-skip state, marked provisional pending a platform answer on whether hosted runs can disable writeback

## 5. Follow-ups raised, not resolved here

- [ ] 5.1 Open a separate issue for the board template shipping `docsDir`/`ecadDir` while `loadConfig` (`src/config.ts:113-115`) reads `docs`/`schematic`/`board`, so both keys are silently ignored. Independent of this stream and live for template users today
- [ ] 5.2 Raise the template's fabrication-output ignore mismatch: it ignores `build/`, `fab/` and `gerbers/` under the comment "build and fabrication output, which is regenerated from the design", but the fab tool writes to `outputs/`, which none of those cover. Gerbers are therefore committed today, and classified as references by the rule above, which may not be the intent
- [ ] 5.3 Do not fix the `priorRuns` miscount here. `src/commands/create.ts:736` is already touched by #155, #149 and #251's planned change; this change states the contract that fix must satisfy and leaves the edit to whichever lands

## 6. Verification

- [ ] 6.1 `npm run typecheck` and `npm test` clean, compared against a stashed baseline rather than a remembered count
- [ ] 6.2 Extend the module-graph guard in `test/init-check.test.ts` to cover any module added here, so `check` staying LLM-free and network-free (AC-2.1) is asserted rather than assumed
- [ ] 6.3 Confirm `test/gating-sync.test.ts` stays green and is extended, never relaxed
