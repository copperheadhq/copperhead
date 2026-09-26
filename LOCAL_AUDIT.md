# Local reliability fixes

This audit traces the implemented CLI, provider adapters, agent loop, create
pipeline, verification commands, and rollback behavior against the repository's
OpenSpec contracts. Changes are local and uncommitted.

## How the project works

Commander routes CLI commands to deterministic operations or a provider-neutral
agent loop. The loop reads design memory, validates a proposal, unlocks editing,
applies anchored KiCad edits, verifies ERC/DRC and documentation obligations,
then commits. Failure preserves recoverable work and restores a Git snapshot.
`create` runs this workflow across stages, using files and checks to resume.
`check` remains independent of model SDKs and network calls.

## Gaps fixed

1. **Completion could bypass gates.** Calls after an accepted `finish` could
   mutate already-verified work. Replacing or revalidating a proposal retained
   earlier approval, and changelog errors were only warnings. Completion now
   ends execution, requires current approval, and enforces the changelog and
   complete obligations ledger before committing.
2. **Filesystem containment was only lexical.** Symlinks and configuration paths
   could escape the repository or hide KiCad file extensions. File/config paths
   are now checked; search skips symlinks and non-regular files. The same
   containment checks cover prompt documents, proposal files, decisions,
   constraints, changelogs, ignore files, and transcript writes. Exclusive file
   creation prevents concurrent writes overwriting an existing file.
3. **Rollback could lose or expose user work.** Staging state, dangling symlinks,
   unusual filenames, and files protected by uncommitted ignore rules were not
   fully preserved. Snapshots now retain those distinctions. Originally ignored
   files remain excluded from commits and recovery stashes if ignore rules change.
   Staging and rollback exclusions also resolve correctly for a project inside
   a larger Git repository.
4. **Verification could report false success.** Missing configured design files
   now fail `check`; `sync` detects constraints with entirely missing docs and
   rechecks its result before reporting success.
5. **Create-stage checks contradicted their instructions or accepted partial
   work.** Named MPNs may retain the required `UNVERIFIED` flag. Layout resume
   requires DRC; pending KiCad work must pass checks before a resume commit.
   Output completion requires nonempty Gerber, drill, DXF, STEP, board render,
   schematic render, and ordering BOM artifacts. Empty firmware files do not
   count as a scaffold. DXF and PCB SVG exports explicitly select single-file
   mode on KiCad 9+, keeping KiCad 8's original file-output arguments. STEP
   export can replace its generated output when a pipeline resumes. The version
   distinction follows the official [KiCad 8 CLI reference](https://docs.kicad.org/8.0/en/cli/cli.html)
   and [KiCad 9 CLI reference](https://docs.kicad.org/9.0/en/cli/cli.html).
6. **Provider recovery could leak work or lose context.** Timed-out API requests
   are cancelled; abandoned saved-login responses cannot replace newer state.
   Independent nested-skill histories start fresh sessions. Failed SDK turns
   cannot dispatch partial tool calls. A single bounded retry policy handles
   transient provider errors without multiplying SDK retries.
7. **Cached responses could be stale or contain secrets.** Cache keys now include
   full tool contracts. Recognized secret-bearing responses bypass persistence
   without changing executable arguments; matching unsafe cache entries are
   discarded on read. Codex receives cached assistant turns before their tool
   results when its next live turn resumes, preserving the skipped context.
8. **REPL logs could still be buffered after exit.** Shutdown now waits for log
   writes and handles stream errors. Two tests now synchronize with request
   completion instead of racing fixed input timers.

The main specification and applicable Phase 1 delta specs describe these fixes.
Focused regression tests accompany the changes.

The known-good KiCad fixture also carries project-local copies of its exact
embedded symbols. ERC therefore checks the same library definitions on different
KiCad installations; production verification and rule severities are unchanged.

## Verification scope

`npm run typecheck`, `npm run build`, and
`openspec validate build-copperhead-phase-1` pass. CLI help and the demo tour
also run successfully. `git diff --check` is clean.

The last broad offline run (`npm test -- --maxWorkers=2`) recorded **1,114
passed, 3 failed, and 21 skipped**. That run overlapped the final edits: its
three failing cases were the newly added nested-project staging, symlinked
`.gitignore`, and Codex cached-turn regressions. All three pass in fresh runs
against the final code: **62/62 safety and terminal-gate tests**, plus **83
provider/cache tests passed with one existing optional SDK skip**. The complete
suite was not rerun again after those final edits; these are combined full-suite
and focused results, not a claim of one uninterrupted green full-suite run.

The first broad run also exposed host-dependent Windows binary-discovery tests
and incorrect native export modes. Those fixes pass in the last broad run:
all 18 binary-resolution tests, all 13 init/check/native-export tests, and all
7 export-argument tests pass. The native export test retains its 60-second
timeout and now checks more output files rather than weakening verification.

Native KiCad 10.0.5 ERC, DRC, and fabrication export checks pass on the fixture.
The export test checks that DXF, STEP, board SVG, and schematic SVG are regular,
nonempty files. KiCad 8/9 export argument compatibility is covered by mocked
tests and the official CLI documentation; those native versions were not run.

Live model acceptance and cross-provider parity were not run. Provider tests use
mock SDKs and local HTTP servers. Firmware compilation and a complete live
brief-to-board run remain unverified. Export checks establish required file
presence and nonempty content, not manufacturing approval or export freshness.

The host ran out of disk space during initial validation. The temporary backup
of the broken dependency installation was removed after `npm ci` restored the
locked dependencies. Scripted pipeline tests use a process-local
`COPPERHEAD_MIN_FREE_MB=0`; production disk-space guards are unchanged. No API
credentials were added. The pre-existing `live-audit-screenshot.png` is untouched.
Normal `create` runs require at least 2 GiB free; this host currently has less
than 1 GiB. Free additional space before a real pipeline run.
