# safety-rails delta spec

## ADDED Requirements

### Requirement: Refused work is preserved before rollback

Any run that ends without committing while it has touched files, whether it failed (turn budget, repair cycles, provider error, stall, commit failure) or refused, SHALL preserve the touched work as a git stash entry named `copperhead failed run <run-id>` before restoring the pre-run snapshot, and SHALL print the stash ref beside the transcript path. The restored tree SHALL be byte-identical to the pre-run snapshot. A run that touched nothing SHALL leave no stash entry.

#### Scenario: Refusal with touched files is preserved (AC-18.3)

- **WHEN** a run writes `docs/BOM.md` and then calls `finish` with outcome `refuse`
- **THEN** the working tree is restored byte-identical, a stash entry `copperhead failed run <run-id>` holds the written BOM, and the refusal output names the stash ref

#### Scenario: Clean refusal leaves no stash (AC-15.17 unchanged)

- **WHEN** a run refuses without having touched any file
- **THEN** no stash entry is created and the tree is unchanged
