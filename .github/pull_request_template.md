<!--
Fill in the sections that apply and delete the rest, including this comment.
Keep prose em-dash-free (use colons, commas, or parentheses).
Reference files as clickable relative links, e.g. [loop.ts](src/agent/loop.ts).
-->

## What

<!-- One or two sentences: what this PR changes, from the user's point of view. -->

## Why

<!-- The gap or problem this closes. Link the issue if there is one. -->

## Design

<!-- Only if the change is non-trivial. How it works and the load-bearing decisions.
     If it touches the agent loop, safety gates, providers, or the KiCad layer, say how the
     invariants below are preserved. Link to design.md decisions where relevant. -->

## Spec / OpenSpec

<!-- If this changes spec-level behavior, SPEC.md and the active change artifacts must move together.
     List the OpenSpec change, the affected acceptance criteria (AC-x.y), and any delta specs.
     Delete this section for a pure refactor or docs-only PR. -->

## Testing

<!-- Real results only, never assumed. Fill in the status table and the manual-test log below. -->

### Automated test status

<!-- Report what you actually ran. Use pass / fail / skip / n/a, with counts where it helps. -->

| Check | Command | Status |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | |
| Build | `npm run build` | |
| Unit + offline | `npm test` | |
| Live-LLM (opt-in) | keyed on `<ENV_VAR>` | |

<!-- New or changed tests, and known pre-existing failures unrelated to this PR: -->

### Manual test log (required)

<!-- Required for any change to CLI behavior, the agent loop, providers, or the KiCad layer.
     Exercise the CLI by hand against the manual-tests sandbox (see manual-tests/README.md),
     and paste the commands you ran with their outcome. Write "n/a" with a reason only for
     changes that cannot be exercised at runtime (e.g. docs-only or CI-config-only). -->

- Sandbox variant used (`create` / `edit`):
- Commands run and outcome:

```text
$ <command>
<result>
```

## Docs

<!-- README, configuration reference, .env.example, doc comments, or CHANGELOG/DECISIONS entries touched. -->

---

## Invariant checklist

<!-- These are hard requirements from SPEC.md. Check the boxes this PR is responsible for;
     mark N/A for the ones it does not touch. A reviewer will verify each. -->

- [ ] **Spec-gated in**: `edit_file`/`write_file` stay structurally absent from the agent tool list until an OpenSpec proposal validates (gated by omission, not prompt text).
- [ ] **Verification-gated out**: mutations still end in ERC (and DRC when the board changed) passing, with repair up to `maxRepairCycles` then rollback to the git snapshot.
- [ ] **`check`/`verify` stays LLM-free and network-free**: nothing reachable from `src/commands/check` touches a provider, an API key, or the network.
- [ ] **No sexp serialization**: the `src/kicad/` parser stays read-only; the agent edits KiCad files only via anchored exact-match text replace, and the deterministic writers (populate, `move_footprint`, the sym-lib-table rewrite) splice located spans and keep every byte they do not change (no round-tripping).
- [ ] **Sync-obligations ledger**: post-tool-call hooks keep feeding the ledger, and commit keeps refusing while obligations are open.
- [ ] **Secrets**: transcripts and summaries redact `sk-[A-Za-z0-9_-]+` at write time; keys live only in env vars; `.gitignore` keeps `.env` and `.copperhead/runs/`.
- [ ] **Spec coherence**: if spec-level behavior changed, SPEC.md and the change artifacts (`proposal.md`, `design.md`, delta specs, `tasks.md`) moved together and `openspec validate <change>` passes.
