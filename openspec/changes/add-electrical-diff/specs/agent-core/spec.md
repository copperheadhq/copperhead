# Electrical dry-run preview

## ADDED Requirements

### Requirement: Verified electrical preview before dry-run rollback

A successful do dry run SHALL compare the actual pre-run electrical design with the proposed design after the existing spec and finish gates pass, then return the preview before restoring the Git snapshot. The preview SHALL appear in the run result and redacted transcript/summary. A preview failure SHALL use the failure/rollback path.

#### Scenario: Dirty user work

- **WHEN** an allowed dirty tree already contains a user net rename and the agent makes another rename
- **THEN** the preview compares from the user's pre-run name and rollback restores that exact pre-run design

#### Scenario: Premature finish

- **WHEN** the agent tries to finish before ERC and sync obligations pass
- **THEN** finish remains blocked and no electrical preview is emitted yet
