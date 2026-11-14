# Fix prompt reference

The review report ends with a **Fix prompt**: one self-contained block the PR author copies into the coding agent of their choice (Claude Code, Codex, Cursor, an IDE assistant) to resolve every finding in one pass. The reviewer writes it; the author pastes it; no summarizing in between.

Emit it whenever at least one finding survived verification, including a nits-only report. Skip it entirely on a clean report and say so in one line ("no findings, so no fix prompt").

## Rules for building the block

- **Self-contained.** The agent that receives it has never seen the review, the PR, or this repo. Restate the repo, the branch, and every finding in full. Never write "see the finding above", "as noted", or a bare finding number.
- **Fenced, and one block.** Wrap the whole prompt in a four-backtick fence so any fences inside it survive, and keep it to a single block: two blocks means two pastes and a lost half.
- **Copy-safe.** Plain text only inside the fence: no markdown links, no collapsible sections, no `@`-mentions or `#123` cross-references that turn into GitHub notifications when the comment is posted. Write paths as plain `src/agent/loop.ts:42`.
- **Ordered by severity**, high first, matching the findings list. Label each with its severity and mark low ones `(optional)` so the author can drop them without reading the whole block.
- **Faithful.** Only findings that survived step 6 verification go in. The failure scenario and fix carry over verbatim from the findings list: a fix prompt that quietly rewords a finding makes the two halves of the report disagree.
- **Bounded.** The fix prompt asks for the findings and nothing else. It must forbid opportunistic refactors, drive-by renames, and dependency bumps.
- **Honest about verification.** It ends with the repo's real commands, and it tells the agent to report failures rather than route around them (no deleted assertions, no `.skip`, no loosened thresholds to make a suite green).

## Template

Fill every placeholder. Drop the untested-surface paragraph when there is no untested-surface finding, and the spec paragraph when the PR does not touch spec-level behavior.

````text
You are fixing review findings on a pull request in the copperhead repo
(copperheadhq/copperhead): a TypeScript CLI agent that designs and edits real
KiCad projects. Node >= 20. The PR is #<N>, branch <headRefName>, based on <baseRefName>.

Check it out first:
  gh pr checkout <N>

Fix each finding below. Keep the change scoped to these findings: no unrelated
refactors, renames, reformatting, or dependency changes. If you disagree with a
finding, say so and leave it alone rather than doing a partial fix.

FINDING 1 [high] <one-sentence claim>
  Where: <path:line>
  Fails when: <the inputs or state that produce wrong behavior>
  Fix: <the concrete change, or the failing test to write first>

FINDING 2 [medium] <one-sentence claim>
  Where: <path:line>
  Fails when: <...>
  Fix: <...>

FINDING 3 [low] (optional) <one-sentence claim>
  Where: <path:line>
  Fails when: <...>
  Fix: <...>

For every confirmed correctness bug, add the regression test that fails before the
fix and passes after it; this repo pairs bug fixes with tests.

These lines in the diff are reached by no test: <file:line list>. Add tests for the
new exported symbols, branches, and error paths they contain.

This PR changes spec-level behavior, so openspec/specs/SPEC.md and the active change
artifacts (proposal.md, design.md, delta specs, tasks.md) have to move together, and
`openspec validate <change-name>` has to pass.

Do not break these repo invariants (they are hard requirements from SPEC.md):
  - Spec-gated in: the agent's edit_file/write_file tools stay structurally absent
    from the tool list until an OpenSpec proposal validates. Gated by omission, never
    by prompt text.
  - Verification-gated out: every mutation ends in ERC passing (and DRC when the board
    changed), repairing up to maxRepairCycles, then rolling back to the git snapshot.
  - check/verify stays LLM-free and network-free: nothing reachable from
    src/commands/check may touch a provider, an API key, or the network.
  - No sexp serialization: the src/kicad/ parser is read-only. KiCad files are edited
    only via anchored exact-match text replace, never round-tripped.
  - Sync-obligations ledger: post-tool-call hooks keep feeding it, and commit keeps
    refusing while any obligation is open.
  - Secrets: transcripts and summaries redact sk-[A-Za-z0-9_-]+ at write time, keys
    live only in env vars, and .gitignore keeps .env and .copperhead/runs/.
  - New tests are deterministic: no network, no Date.now(), no Math.random(), no
    dependence on execution order, and every test asserts something.

Then verify:
  npm run typecheck
  npm run build
  npm test

All three must pass. Do not silence a failure by deleting an assertion, skipping a
test, or loosening a threshold: if something fails and the fix is not obvious, stop
and report it.

Finally, summarize what you changed per finding, and note any you did not fix and why.
Keep prose em-dash-free (use colons, commas, or parentheses).
````
