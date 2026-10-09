# Proposal: verify create stage evidence

## Why

Observed `create` runs could commit before discovering missing stage evidence, reject their own generated power symbols, or report exported filenames that did not exist. Issue [#66](https://github.com/copperheadhq/copperhead/issues/66) needs reviewable execution and regression evidence, so completion must mean that the relevant artifacts and unchanged verification obligations actually pass.

## What Changes

- Check the existing requirements/Budgets predicate before the spec-seed commit, with actionable feedback.
- Complete the firmware stage with strictly checked non-programmable applicability evidence, while rejecting empty source and unsupported identities.
- Compare generated power symbols with complete canonical engine definitions, without changing rails or accepting a prefix alone.
- Inventory fresh, nonempty export files, including directory DXF and multiple SVG pages.
- **BREAKING**: require current, verified stage-6 package evidence instead of treating a lone Gerber as completion. The explicit initial profile supports KiCad 9 without copper-fill zones and fails honestly elsewhere.
- Keep compatibility fixtures, portable test launcher, exact fixed-function identity extension and Markdown-lint alias separately reviewable.
- Add explicitly gated immutable recorded-response integration coverage with actual tools, checks and commits, plus timeout, empty-schematic and missing-final-stage controls.

## Capabilities

### New Capabilities

- `create-pipeline`: structured delta registration for the refined existing stage completion contracts.
- `agent-core`: structured delta registration for generated-symbol and export-tool result verification.
- `manufacturing-package`: explicit local export settings, package integrity, and freshness evidence.

The repository currently has no CLI-discoverable canonical capability specs: its authoritative technical document is `openspec/specs/SPEC.md`. The first two paths reuse names already present in existing change directories. These ADDED deltas document actual behavior changes; they do not claim that the entire pipeline or agent is newly introduced. No archive or canonical-spec migration is performed here.

### Modified Capabilities

None in the CLI-discovered canonical inventory. Existing monolithic requirements and relevant active delta specs remain synchronized; see design.md for the mapping.

## Impact

- Runtime: stage finish/completion checks, firmware applicability, symbol verification, export inventory, package manifest and ZIP helpers.
- Tests: focused negative controls and real KiCad fixtures, plus compatibility prerequisites. No new runtime dependency.
- Related contracts: SPEC section 2.5, AC-15.23/24, AC-15.38/39/41 and the documented output-package integrity extension.
- No experimental runtime provider, hardware alteration, factory order or manufacturer acceptance is introduced by this change.
