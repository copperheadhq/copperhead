# Proposal: Allow Part-Selection to Reference Named Circuit Patterns in BOM.md

## Problem

During Stage 3 (part-selection) of the `copperhead create` pipeline, the model currently enumerates every component by hand, writing each row into `docs/BOM.md`. For common standard circuit blocks (e.g. 3.3V linear regulator with decoupling capacitors, USB Type-C power sink with CC pull-downs, or crystal oscillator with load capacitors), this manual enumeration is repetitive and prone to minor inconsistencies in values, footprints, or missing passives.

With the introduction of the static pattern library in `src/kicad/patterns/*.json` (#274), proven circuit templates are available as reference definitions. However, Stage 3 currently lacks the capability to reference a pattern by name and have it automatically expand into standard BOM rows.

## Proposed Solution

1. Add a pure helper module `src/kicad/patterns/expandToBom.ts` that expands a named circuit pattern from `src/kicad/patterns/<name>.json` into standard `BOM.md` table rows (`| Refdes | Value | Footprint | MPN | Rationale |`).
2. Mark all expanded rows with `from pattern: <pattern-name>` in the `Rationale` column for clear auditability and provenance.
3. Include an informational header row (`| Pattern: <name> | source: src/kicad/patterns/<name>.json |`) describing the origin of the expanded block.
4. Update the Stage 3 (`part-selection`) prompt in `src/commands/create.ts` to allow the model to specify `use pattern: <pattern-name>` when a design requirement matches an available pattern.
5. In Stage 3 execution, resolve pattern references and splice expanded rows into `docs/BOM.md`.
6. Output a user-facing CLI log: `Resolved pattern "<name>" -> N parts added to BOM.md`.

## Scope and Invariants

### In Scope
- Pure expansion helper `expandPatternToBomRows` in `src/kicad/patterns/expandToBom.ts`.
- Stage 3 prompt and pattern resolution in `src/commands/create.ts`.
- Traceability via `from pattern: <name>` tag in `BOM.md` `Rationale` column.
- Documentation in `docs/patterns.md`.
- Unit tests in `test/pattern-bom-expansion.test.ts`.

### Out of Scope
- Direct modifications to `src/kicad/draft/ir.ts` or `SchematicIntent` schema.
- Changes to `src/kicad/draft/engine.ts` or layout engine.
- Modifications to Stage 4 or later pipeline steps.
- Modifications to ERC/DRC validators or pattern JSON files.

### Effect on Invariants
- **Spec-gated in**: This change alters the Stage 3 prompt and authoring behavior, so it is gated through this OpenSpec proposal.
- **Verification-gated out**: This change operates strictly prior to Stage 4 and schematic capture. Downstream tools (Stage 4 drafting, ERC, DRC) consume standard BOM rows unchanged. Verification invariants remain unaffected.

## Alternatives Considered

1. **Expanding patterns inside `ir.ts` / `schematic.intent.json` directly**:
   Deferred to separate follow-up issues. Expanding at Stage 3 into `BOM.md` ensures that downstream stages (Stage 4 schematic drafting, Stage 5 layout) receive standard, explicit component rows without altering downstream schemas.
2. **Human-only `--use-pattern <name>` CLI flag**:
   Deferred. The primary consumer during autonomous create runs is the agent model during part-selection. Adding CLI flags can be evaluated later if interactive manual scaffolding warrants it.
