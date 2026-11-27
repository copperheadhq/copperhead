# add-hosted-run-seam: Proposal

## Why

A hosted run destroys its workspace when it ends. Everything the run produced goes with it: the gerbers, drill, DXF and STEP written to `outputs/` (`src/agent/tools.ts:616`), the supplier BOM at `outputs/<supplier>-bom.csv` (`src/commands/export.ts:29`), the SVG renders under `.copperhead/renders/` (`src/agent/tools.ts:601`), and the transcript, summary and per-run report under `.copperhead/runs/` (`src/agent/transcript.ts:77`, `src/commands/create.ts:736`). The `/artifacts` console surface is a shell because nothing durable exists behind it (#250).

Phase 0 of that stream is the part this repository owns: the contract the platform consumes. The platform cannot store, classify, or bound what a run emits until this repository states what it emits, how large an event may be, and which outputs survive in the repository versus which die with the workspace. Both streams compile against that contract, so a later change to it is a cross-stream break, which is why it lands before any storage or runner work.

Two of the three obligations are already defects rather than gaps:

**A transcript event has no size bound.** `Transcript.event()` (`src/agent/transcript.ts:87`) redacts and appends whatever it is handed, as one JSON line. A stage attempt has already died on this: `Prompt is too long, the request is ~1003121 tokens but this conversation is only ~403383 tokens`, because a single `transcript.jsonl` line carried an entire tool result inline. The existing clip at `src/agent/filetools.ts:95` bounds an individual search match, not an event, so it did not and could not prevent it. Measured across 1106 events from real `create` runs, the median event is 337 bytes, p99 is 18042, and the largest is 60981, so the pathological case is three orders of magnitude outside normal traffic rather than a tail of it.

**Redaction has no pattern for a storage credential.** `src/util/redact.ts` carries seven patterns: `sk-`, `Bearer`, `npm_`, `gh[pousr]_`, `github_pat_`, `AIza`, `gsk_`. A shared access signature is a query string whose secret is its `sig=` value and matches none of them. This is sharper than an ordinary redaction gap because the transcript is itself an artifact this stream uploads: an unredacted signature becomes a live download credential stored inside a downloadable object. The Git side is already covered, since a GitHub App installation token is `ghs_` and `gh[pousr]_[A-Za-z0-9]{36,}` matches it, including inside an `x-access-token:...@github.com` clone URL.

## What Changes

- **A per-event byte bound on the transcript, with a spill rule.** `Transcript.event()` gains a cap enforced at the same write that already applies redaction, so the size bound and AC-4.1 are enforced in one place and cannot diverge. An event over the bound is written with its payload replaced by a truncation marker recording the original size, which is the local form of the `ArtifactRef` spill the hosted activity log needs.
- **Redaction widens from model and forge credentials to storage credentials.** A shared-access-signature pattern joins the seven existing ones, tested in `test/safety.test.ts` beside them, so a future storage backend with a differently shaped credential fails a test rather than a transcript.
- **The `.copperhead/` layout becomes a stated contract**, naming which entries are runs and which are outputs. This is load-bearing beyond documentation: `src/agent/runmeta.ts:108` derives `priorRuns` by listing `.copperhead/runs` and filtering the current run id, so any entry added to or removed from that directory silently moves a number the agent reads.
- **An artifact classification rule, derived rather than invented.** Whether an output survives is already decided by version control: an output the run commits survives in the repository and needs only a reference, while an output excluded by `.gitignore` dies with the workspace and must be stored. The contract states the rule and the classification each producer falls under, so the platform is not left to guess per file.
- **The seam types are stated as this repository's obligations** (`Workspace`, `WritebackResult`, `ArtifactRef`), including the `location` discriminant and the writeback states, so both streams have one definition to build against.

## Capabilities

### Added Capabilities

- `hosted-run-seam`: the artifact classification rule, the `.copperhead/` on-disk layout contract, and the seam types a hosted runner consumes.

### Modified Capabilities

- `agent-core`: transcript events gain a byte bound and a truncation rule; write-time redaction widens to storage credentials.

## Impact

- **Code**: `src/agent/transcript.ts` (the event bound and truncation marker), `src/util/redact.ts` (the storage-credential pattern).
- **Tests**: `test/safety.test.ts` gains the storage-credential case beside the seven existing per-pattern cases, and a case asserting an over-bound event is truncated with its original size recorded rather than dropped.
- **Docs**: `.copperhead/README.md` states the layout contract.
- **Unchanged contracts**: nothing here is reachable from `src/commands/check`, so `check`/`verify` stays LLM-free and network-free (AC-2.1); the edit-tool gate and the verification gate are untouched, and artifact handling stays post-verification so it never becomes a route to "done" without ERC and DRC.
- **Not in scope**: blob storage, the artifact metadata table and its row-level security, signature minting, console download, and every runner-side concern (clone, `GIT_ASKPASS`, writeback). Those are Phases 1 and 2 and land in the platform repository against the contract this change fixes.
- **Deliberately excluded**: the board template shipping `.copperhead/config.json` with `docsDir` and `ecadDir` while `loadConfig` (`src/config.ts:113-115`) reads `docs`, `schematic` and `board`, so both keys are silently ignored. It is a live defect for template users today and independent of this stream, so it is filed separately rather than carried here.
