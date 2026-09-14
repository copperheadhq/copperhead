# add-pattern-expansion-helper: Proposal

## Why

When authoring hardware designs or generating netlists, recurring standard subcircuits (such as LDO voltage regulators, USB-C power inputs, and crystal oscillator load networks) require repeating component declarations and pin-by-pin net connections in `schematic.intent.json`. Writing these boilerplate blocks manually is verbose and prone to transcription errors (such as swapped pin numbers or missed decoupling capacitors).

GitHub Issue #277 proposes adding pattern expansion capabilities. Per the issue's recommendation and Phase 0 descope decision, this change implements the **expansion-only variant**: a pure TypeScript helper function (`expandPatternRef`) that loads a named static pattern from `src/kicad/patterns/*.json`, renumbers reference designators, rewrites net endpoint pin references, and returns `{ parts, nets }` ready for composition into an intent document.

## What Changes

- **New pure helper function**: `src/kicad/draft/patternExpand.ts` exporting `expandPatternRef(patternName, options)`.
- **Purely additive & decoupled**:
  - `SchematicIntent` in `src/kicad/draft/ir.ts` is **not modified** (no `patternRefs` field is added).
  - `validateIntent()`'s required shape and behavior remain **100% unchanged**.
  - `src/kicad/draft/engine.ts` layout and grouping algorithms are **not modified** (pattern-aware layout is deferred to Issue #278).
  - `src/commands/create.ts` pipeline stage prompts remain **not modified** (automatic pipeline integration is out of scope for this MVP helper).
- **Out of Scope**:
  - Metadata tracking in the IR schema (`patternRefs` field).
  - Schema-level structural cross-checks in `validateIntent()`.
  - Layout-level pattern awareness and sub-box rendering in `engine.ts`.
  - These metadata and layout features are distinct follow-ups to be considered after this expansion-only helper is used in practice.

## Capabilities

### New Capabilities

- `pattern-expansion`: Pure mechanical expansion of static circuit pattern definitions into renumbered `IntentPart[]` and `IntentNet[]` arrays compatible with `SchematicIntent`.

### Modified Capabilities

- None (existing capabilities remain untouched and backward compatible).

## Impact

- **Code**: Adds `src/kicad/draft/patternExpand.ts` and unit tests in `test/pattern-expand.test.ts`.
- **Dependencies**: Zero new runtime or dev dependencies.
- **Unchanged invariants**: `ir.ts`, `engine.ts`, `check`, `doctor`, and the drafting engine pipeline contracts are untouched.
