# Copperhead Pipeline Findings Report

## BLOCKER
**Where**: `src/commands/create.ts` (outputs and spec-seed stages)
**Symptom**: Uncommitted files. The `emitJlcpcbAfterOutputs` and `writeBriefHash` functions generate tracking artifacts (`BOM.csv` and `BRIEF.sha256`) outside of the `runAgentLoop`'s commit boundary. These files are grouped into the subsequent stage's commit, breaking the "independent stage commit" requirement.
**Suggested**: Check if the working tree `isDirty` after generating pipeline artifacts, and immediately `commitAll` the generated files.
**Status**: Fixed
**Priority**: P0

## DEFECT
**Where**: `src/commands/create.ts` (`layout-draft` stage `isComplete` check)
**Symptom**: DRC False-Green. The stage completion check does not execute the Design Rules Check (`runDrc`), even though the stage prompt strictly requires all routed nets to pass DRC.
**Suggested**: Invoke `runDrc(p)` during `isComplete` and ensure it returns an `ok` result before allowing the stage to pass.
**Status**: Fixed
**Priority**: P0

## DEFECT
**Where**: `src/commands/create.ts` (`layout-draft` stage `isComplete` check)
**Symptom**: Content False-Green. The stage is considered complete as long as the board contains a footprint and `LAYOUT.md` includes the heading `## Draft quality`. Since the `init` script scaffolds `LAYOUT.md` with this exact heading, the agent can bypass drafting the actual quality documentation by just adding a footprint.
**Suggested**: Use regex and string manipulation to isolate the content *beneath* the `## Draft quality` heading and verify it contains at least one non-empty line of text.
**Status**: Fixed
**Priority**: P1

## NOTE
**Where**: `test/create-e2e.test.ts`
**Symptom**: Missing end-to-end coverage for the complete pipeline.
**Suggested**: Added a deterministic end-to-end integration test mocking the agent loop to successfully produce passing artifacts for all 8 stages, asserting `res.ok` and all 8 stages run to completion.
**Status**: Fixed
**Priority**: P1
