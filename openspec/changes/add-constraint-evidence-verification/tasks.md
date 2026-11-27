# add-constraint-evidence-verification: Tasks

- [x] 1.1 Define `ConstraintEvidence` on `Constraint` and implement `verifyConstraintEvidence` in `src/memory/constraints.ts`.
- [x] 1.2 Accept and preserve `evidence` in `record_constraint` (`src/capabilities/handlers.ts`) and run `verifyConstraintEvidence` in `runCheck` (`src/commands/check.ts`).
- [x] 1.3 Document `evidence` in `openspec/specs/SPEC.md` §2.6 and cover hyphenated ranges, numeric string `value`s, non-numeric `numbers`, missing PDF sidecars, symlink escapes, `null` entries, and `record_constraint` preservation in `test/constraint-evidence.test.ts`.
