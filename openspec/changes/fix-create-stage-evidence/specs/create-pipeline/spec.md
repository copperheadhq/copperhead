# Create pipeline evidence

## Purpose

Require concrete, supported stage evidence before completion without inventing firmware or weakening existing verification obligations.

## ADDED Requirements

### Requirement: Requirements budget feedback before commit

The spec-seed prompt SHALL name the existing Budget or Budgets document requirement. Its finish gate SHALL use the same predicate as stage completion before committing and report the configured file and missing heading or content. The later completion probe and all other obligations SHALL remain enforced.

#### Scenario: Budget heading is absent

- **WHEN** a model calls finish after writing constraints without the required heading
- **THEN** the run reports the missing budget section and does not commit
- **AND** the model may repair it within the remaining turn budget

#### Scenario: Budget section contains evidence

- **WHEN** the required heading contains actual non-comment budget content
- **THEN** the unchanged document predicate permits normal completion if other obligations pass
- **AND** an empty or comment-only section remains incomplete

### Requirement: Evidence-backed firmware applicability

The firmware stage SHALL retain all eight pipeline stages and accept either nonempty supported source or a strict hardware-only declaration supported by a nonempty, ERC-clean, drift-clean schematic and populated BOM/PINOUT tables. Only reviewed exact non-programmable symbol identities SHALL qualify for N/A.

#### Scenario: Supported hardware-only declaration

- **WHEN** the design passes the hardware checks and firmware/README.md contains exactly the documented title, no-programmable-components field and concrete reason of at least 20 characters
- **THEN** the firmware stage may complete without dummy source or fabricated compilation

#### Scenario: Unsupported applicability evidence

- **WHEN** a declaration is missing, ambiguous or a placeholder, or the design has an MCU, unknown/custom symbol, empty schematic, drift or ERC errors
- **THEN** the N/A path remains incomplete
- **AND** another unreviewed Power_Management identity is not accepted because its name resembles a reviewed part

#### Scenario: Empty firmware source

- **WHEN** a firmware directory contains only empty or whitespace-only source files
- **THEN** the files do not satisfy the source-artifact path

### Requirement: Outputs evidence before finish and resume

Finish and resume SHALL use the same profile-bound package-integrity contract. Generic is the default; JLC is explicit opt-in. Stage 6 SHALL require complete Gerber/drill, mechanical/render, ordering BOM, archive and source/file evidence. Invalid evidence SHALL keep the stage incomplete with an actionable reason. Existing ERC, DRC, parity, drift, ledger and rollback behavior SHALL remain enforced.

#### Scenario: Board-only or incomplete exports

- **WHEN** a board-only export succeeds, or required evidence is missing, empty, stale, altered or incomplete
- **THEN** neither finish nor resume completes Stage 6
- **AND** the existing ERC, DRC, parity, drift, ledger and rollback obligations remain enforced

#### Scenario: A leftover Gerber is present

- **WHEN** outputs contains a Gerber but no complete current package evidence
- **THEN** neither finish nor resume marks the stage complete

#### Scenario: Package inputs change

- **WHEN** a recorded source or a required output changes after export
- **THEN** the completion probe reports the package as stale or altered and requires regeneration
