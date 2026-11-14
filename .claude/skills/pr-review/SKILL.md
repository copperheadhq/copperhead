---
name: pr-review
description: Review a copperhead pull request against the repo's invariants and spec workflow. Use when the user asks to review a PR, e.g. /pr-review 28 or /pr-review <url>.
allowed-tools: AskUserQuestion, Bash(gh:*), Bash(git:*), Bash(node:*), Bash(openspec:*), Bash(npm:*), Bash(npx:*)
compatibility: Requires the gh CLI, authenticated against copperheadhq/copperhead.
metadata:
  author: copperhead
  version: "2.2"
---

Review a pull request for this repository. Present the findings report to the user, and also post it to the PR automatically as a comment (`gh pr comment <n>`) so the review is recorded on GitHub. Do NOT submit a formal review (`gh pr review --approve` / `--request-changes`) unless the user explicitly asks: those affect merge gating, whereas a plain comment does not.

**Input**: a PR number or URL. If omitted, run `gh pr list --json number,title,author,headRefName` and either auto-select the single open PR or use the AskUserQuestion tool to let the user pick. Always announce which PR is being reviewed. If the PR is a draft, still review it, but present the report in-session only and do not post the comment unless the user explicitly asked for a draft to be reviewed (draft comments go stale immediately).

**Working-tree isolation (non-negotiable)**: the review runs in a throwaway `git worktree`, never in the user's checkout. Never run `gh pr checkout`, `git checkout`, `git switch`, `git stash`, `git reset`, or any other command that moves HEAD, the index, or a tracked file in the main checkout: the user may be mid-edit on an unrelated branch, and a review is read-only work. Everything the review needs (the PR's files, the suite, coverage) happens under the worktree path from step 0, and every file path in the report is written repo-relative (`src/agent/loop.ts:42`), never as a worktree path. If the worktree cannot be created, say so and fall back to a diff-only review with tests and coverage reported as "not measured"; do not fall back to checking the PR out in place.

**Steps**

0. **Set up the review worktree**: `node .claude/skills/pr-review/scripts/worktree.mjs setup <n>`. It fetches `refs/pull/<n>/head` into a private ref (so fork PRs work and no branch moves), parks it detached under the OS temp dir, and symlinks `node_modules` from the main checkout so the suite can run without an install. Its last line is `worktree: <path>`: that path is `<WT>` below. If the script reports that the PR changes `package-lock.json`, re-run it with `--install` before trusting any suite result. Announce that the main checkout stays on its current branch. Details and failure modes: `references/worktree.md`.

1. **Gather the change**
   - `gh pr view <n> --json title,body,author,baseRefName,headRefName,files,additions,deletions,mergeable,isDraft,comments`, plus `gh pr checks <n>` for CI state. A `mergeable` that is not `MERGEABLE` and a red or pending CI run each go in the metrics block, and a failing required check is at least a medium finding.
   - `gh pr diff <n>` for the full diff; for large PRs, read it per file. Skip generated and vendored files (`package-lock.json`, `dist/`, `*.snap`, build output): note that they changed, but do not read them line by line or raise findings inside them.
   - Read the PR's code under `<WT>` (that is the checkout that actually contains it). Read the skill's own files, and run its scripts, from the main checkout: a PR that edits `.claude/skills/` must not get to review itself with its own version of the tooling.
   - **Prior passes and authorship**: check the fetched comments for an earlier automated pr-review pass. If one exists, reference it and report only what changed since (new commits, findings now resolved or still open), not a duplicate full report. If you (the reviewer) authored any commit under review, disclose it up front and treat those findings as self-review, which warrants more skepticism, not less.

2. **Metrics, scripted**: start `node .claude/skills/pr-review/scripts/metrics.mjs <n> --dir <WT>` in the background now and collect it before writing the report. `--dir` is what keeps the suite, coverage, and every git read inside the worktree; without it the script measures whatever is checked out in the main tree and reports the head as not checked out. It computes the entire metrics block deterministically: area-split change size, new-vs-net surface, suite pass/skip/fail, diff coverage with the uncovered `file:line` list, dependency changes, and the CI check state (pass/fail/pending counts plus failing required checks, via `gh pr checks`), each with its method stated. Add `--base-tests` only when the base suite result matters and base CI does not already report it; never check out the base branch in the working tree. If the script fails, fall back to the manual method in `references/metrics.md`. Never emit a number you did not derive; report unmeasured metrics as "not measured" with the reason.

3. **General review**: follow `references/review-checklist.md` (adversarial inputs for parser and protocol code, mock-only runtime code, test determinism and assertions, scope creep, description accuracy).

4. **Repo invariant checks** (each is a hard requirement from SPEC.md; violations are high severity):
   - **Spec-gated in**: `edit_file`/`write_file` must remain structurally absent from the agent tool list until an OpenSpec proposal validates. Reject any change that exposes mutation tools unconditionally or gates them by prompt text instead of by omission.
   - **Verification-gated out**: mutations must still end in ERC (and DRC when the board changed) passing, with repair up to `maxRepairCycles` then rollback to the git snapshot. Watch for paths that skip verification or mark a run done early.
   - **`check`/`verify` stays LLM-free and network-free**: no change may make `src/commands/check` (or anything it imports) touch a provider, an API key, or the network.
   - **No sexp serialization**: the parser in `src/kicad/` is read-only; KiCad files are edited only via anchored exact-match text replace. Reject any round-tripping.
   - **Sync-obligations ledger**: post-tool-call hooks must keep feeding the ledger, and commit must keep refusing while obligations are open.
   - **Secrets**: transcripts and summaries redact `sk-[A-Za-z0-9_-]+` at write time; keys live only in env vars; `.gitignore` keeps `.env` and `.copperhead/runs/`.

   **Scaling**: when the diff exceeds ~400 changed src lines (the script prints this as "fan-out threshold input"), run steps 3 and 4 as two parallel subagents instead of inline. Give each the PR number and the worktree path `<WT>`, tell it to read the diff and surrounding code there and that it may not check anything out, point the general-review agent at `references/review-checklist.md` and give the invariants agent the bullet list above verbatim, and require findings in the checklist's finding format. Their findings feed step 6 like any other candidate.

5. **Spec coherence**: if the PR changes spec-level behavior, `openspec/specs/SPEC.md` and the active change artifacts (`proposal.md`, `design.md`, delta specs, `tasks.md`) must move together. Run `openspec validate build-copperhead-phase-1` in `<WT>` when planning artifacts changed. A code-only PR that silently diverges from SPEC.md is a finding.

6. **Verify before reporting**: for each candidate finding, read the surrounding code in the review worktree and try to refute it; this is the stage where hunk context gets read in depth, so on large PRs spend the context reads here, on candidates, rather than on every hunk up front. Drop anything speculative or already handled elsewhere. Then work the script's uncovered-lines list, using the full per-file list printed in its detail output (the metrics block line truncates at 40 files): an uncovered new branch or error path is exactly where a real defect hides, so trace each one by hand before concluding it is fine, and enumerate the new exported symbols, branches, and error paths no test reaches as findings (the untested-surface list). The suite result comes from the script's actual run, never from assumption.

7. **Tear the worktree down**: once the report is written and posted, run `node .claude/skills/pr-review/scripts/worktree.mjs cleanup <n>` and confirm `git status` in the main checkout is exactly as it was. Keep the worktree only if the user asked to keep poking at the PR, and then say where it is. `cleanup --all` sweeps every leftover review worktree for this clone.

**Output**

A short verdict first (approve / approve with nits / request changes), then the **metrics block** pasted from the script's output (template and metric definitions in `references/metrics.md`), then findings ranked by severity in the checklist's finding format, then the **fix prompt** (below). For a confirmed correctness bug prefer the repro test, mirroring the repo's regression-test habit. Note explicitly which invariant checks were performed and passed, so a clean report is distinguishable from an unexamined one, and state in one line that the review ran in an isolated worktree and which commit it measured (the script prints both). State the method for each metric and report unmeasured ones explicitly (a silent omission reads as "clean"); the uncovered-lines entry must reconcile with the untested-surface findings below it.

**Fix prompt** (last section of the report, in-session and in the posted comment): a single copy-pasteable block, headed `## Fix prompt` with the line "Paste this into your coding agent to resolve the findings above." It restates every surviving finding in full so the author's agent needs nothing but the block, and it carries the repo invariants and the verification commands with it. Build it from the template and rules in `references/fix-prompt.md`. Emit it whenever at least one finding survived, including a nits-only report; on a clean report write one line saying there are no findings and therefore no fix prompt. Never let it disagree with the findings list above it: same findings, same severities, same order, wording carried over rather than re-summarized.

**Severity rubric** (apply it consistently so a level means the same thing across runs):

- **high**: a repo-invariant violation (step 4), data loss or an unrecoverable run, a secret leak, or a correctness bug on the default path.
- **medium**: a correctness bug on a reachable non-default path, a skipped or weakened verification, or a failing required CI check.
- **low**: an edge case, a coverage gap, a doc or naming issue, or style.

After presenting the report to the user, post the same report to the PR automatically with `gh pr comment <n> --body <report>`, opening it with a line that marks it as an automated pr-review pass (so a human review is not implied). Announce that you posted it and link the comment. Only if the user then explicitly asks to submit a formal review, use `gh pr review <n>` with the appropriate `--approve` / `--request-changes` / `--comment` flag and the findings as body.

If the host exposes a `ReportFindings` structured-output tool, also emit the verified findings through it (most severe first, empty when none survived), in addition to the GitHub comment, so a host UI can render them.
