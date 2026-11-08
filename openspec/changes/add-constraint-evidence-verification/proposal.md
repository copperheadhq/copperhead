# add-constraint-evidence-verification: Proposal

## Why

Constraints in `.copperhead/constraints.json` cite datasheets and specs, but previously nothing checked offline whether a cited quote or numeric bound actually matched the cached evidence file, and `record_constraint` stripped hand-added `evidence` blocks on re-record.

## What Changes

- **Optional `evidence` field on `Constraint` (`SPEC.md` §2.6)**: `{ path, sha256?, sidecarSha256?, section?, quote, numbers? }` confined to `.copperhead/datasheets/` and `docs/datasheets/`.
- **Offline verification in `copperhead check`**: `runCheck` calls `verifyConstraintEvidence`, checking realpath confinement, regular-file existence, `sha256` (explicit or from `.copperhead/datasheets/index.json`), `.pdf.txt` sidecar presence (and optional `sidecarSha256`), verbatim quote presence, and numeric bound coverage (including hyphenated datasheet ranges like `1.8-3.6 V` and numeric string `value`s).
- **`record_constraint` preservation**: `record_constraint` accepts optional `evidence` and preserves any existing `evidence` on that constraint key when omitted.

## Capabilities

### Modified Capabilities

- `constraint-memory`: offline verification of `evidence`-backed constraints in `check` and preservation in `record_constraint`.

## Impact

- **Code**: `src/memory/constraints.ts`, `src/capabilities/handlers.ts`, `src/commands/check.ts`.
- **Docs**: `openspec/specs/SPEC.md` (§2.6).
- **Tests**: `test/constraint-evidence.test.ts`.
