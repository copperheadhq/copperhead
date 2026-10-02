# Provenance of the knowledge core

The modules under `intake/core/knowledge/`, the evaluation harness under `intake/eval/`, and the tests under
`intake/test/knowledge/` were copied from copperhead-cortex
(`git@github.com:chouhanindustries/copperhead-cortex.git`) at commit **b4a45e8** on 2026-10-02, when cortex was frozen
and the intake became the one datasheet extraction path (OpenSpec change `ground-intake-extraction`, design D1).
cortex is licensed under the Apache License 2.0, as this repository is; the repository NOTICE carries the attribution.

From the copy onward the intake owns this code. Nothing is synchronised back to cortex.

## Copied files

Line counts are of the copied file.

| cortex path | intake path | lines |
|---|---|---|
| `packages/core-types/src/model.ts` | `intake/core/knowledge/types/model.ts` | 162 |
| `packages/core-types/src/reason-codes.ts` | `intake/core/knowledge/types/reason-codes.ts` | 64 |
| `packages/core-types/src/query-contract.ts` | `intake/core/knowledge/types/query-contract.ts` | 66 |
| `packages/core-types/src/index.ts` | `intake/core/knowledge/types/index.ts` | 3 |
| `packages/core-types/src/reason-codes.test.ts` | `intake/test/knowledge/types/reason-codes.test.ts` | 29 |
| `packages/decimal/src/exact.test.ts` | `intake/test/knowledge/decimal/exact.test.ts` | 68 |
| `packages/decimal/src/exact.ts` | `intake/core/knowledge/decimal/exact.ts` | 85 |
| `packages/decimal/src/index.ts` | `intake/core/knowledge/decimal/index.ts` | 2 |
| `packages/decimal/src/units.test.ts` | `intake/test/knowledge/decimal/units.test.ts` | 74 |
| `packages/decimal/src/units.ts` | `intake/core/knowledge/decimal/units.ts` | 184 |
| `packages/parsers/src/conditions.ts` | `intake/core/knowledge/parsers/conditions.ts` | 121 |
| `packages/parsers/src/index.ts` | `intake/core/knowledge/parsers/index.ts` | 3 |
| `packages/parsers/src/numeric.ts` | `intake/core/knowledge/parsers/numeric.ts` | 76 |
| `packages/parsers/src/parsers.test.ts` | `intake/test/knowledge/parsers/parsers.test.ts` | 96 |
| `packages/parsers/src/qualifier.ts` | `intake/core/knowledge/parsers/qualifier.ts` | 27 |
| `packages/validators/src/candidate.ts` | `intake/core/knowledge/validators/candidate.ts` | 79 |
| `packages/validators/src/group.ts` | `intake/core/knowledge/validators/group.ts` | 97 |
| `packages/validators/src/index.ts` | `intake/core/knowledge/validators/index.ts` | 5 |
| `packages/validators/src/pipeline.test.ts` | `intake/test/knowledge/validators/pipeline.test.ts` | 253 |
| `packages/validators/src/pipeline.ts` | `intake/core/knowledge/validators/pipeline.ts` | 234 |
| `packages/validators/src/routing.ts` | `intake/core/knowledge/validators/routing.ts` | 40 |
| `packages/validators/src/versioning.ts` | `intake/core/knowledge/validators/versioning.ts` | 60 |
| `packages/ladder/src/index.ts` | `intake/core/knowledge/ladder/index.ts` | 1 |
| `packages/ladder/src/ladder.test.ts` | `intake/test/knowledge/ladder/ladder.test.ts` | 139 |
| `packages/ladder/src/ladder.ts` | `intake/core/knowledge/ladder/ladder.ts` | 170 |
| `packages/verdict-engine/src/coverage.ts` | `intake/core/knowledge/verdict/coverage.ts` | 84 |
| `packages/verdict-engine/src/engine.test.ts` | `intake/test/knowledge/verdict/engine.test.ts` | 297 |
| `packages/verdict-engine/src/engine.ts` | `intake/core/knowledge/verdict/engine.ts` | 299 |
| `packages/verdict-engine/src/index.ts` | `intake/core/knowledge/verdict/index.ts` | 3 |
| `packages/verdict-engine/src/types.ts` | `intake/core/knowledge/verdict/types.ts` | 61 |
| `packages/conformance-kit/src/fixtures.ts` | `intake/core/knowledge/conformance/fixtures.ts` | 152 |
| `packages/conformance-kit/src/index.ts` | `intake/core/knowledge/conformance/index.ts` | 2 |
| `packages/conformance-kit/src/suite.ts` | `intake/core/knowledge/conformance/suite.ts` | 209 |
| `packages/provider-registry/src/kinds.ts` | `intake/core/knowledge/provider/kinds.ts` | 183 |
| `packages/ingestion/src/segmenter.ts` | `intake/core/knowledge/segment/segmenter.ts` | 95 |
| `packages/eval-harness/src/baseline.test.ts` | `intake/test/knowledge/eval/baseline.test.ts` | 256 |
| `packages/eval-harness/src/baseline.ts` | `intake/eval/baseline.ts` | 766 |
| `packages/eval-harness/src/corpus.ts` | `intake/eval/corpus.ts` | 242 |
| `packages/eval-harness/src/harness.test.ts` | `intake/test/knowledge/eval/harness.test.ts` | 406 |
| `packages/eval-harness/src/index.ts` | `intake/eval/index.ts` | 4 |
| `packages/eval-harness/src/metrics.ts` | `intake/eval/metrics.ts` | 154 |
| `packages/eval-harness/src/run.ts` | `intake/eval/run.ts` | 487 |
| `packages/providers/stub/src/stub-extraction.ts` | `intake/test/knowledge/stub/stub-extraction.ts` | 164 |
| `packages/providers/stub/src/index.ts` | `intake/test/knowledge/stub/index.ts` | 1 |
| `packages/eval-harness/corpus-demo/` | `intake/eval/corpus-demo/` | (data) |

Not copied: cortex's ingestion pipeline (filesystem checkpoints and the world graph), world graph, query service, index
store, API, CLI, MCP server, KiCad resolver, provider registry beyond `kinds.ts`, the cloud providers, and
`core-types/src/schemas.test.ts` (it needs `ts-json-schema-generator`).

## Changes made in the copy

Every change after the copy is listed here, newest last.

1. Imports of `@copperhead/<package>` rewritten as relative imports; `.js` extensions on relative imports dropped, as
   the intake's bundler resolution expects.
2. The literal NUL byte used as a key separator in `ladder/ladder.ts` written as the escape `\u0000`; the string is
   unchanged.
3. `parsePages` (cortex `packages/ingestion/src/pipeline.ts:398-404`) added to `segment/segmenter.ts`, because the
   pipeline that held it was not copied.
4. The evaluation harness placed under `intake/eval/` rather than `intake/core/knowledge/eval/`, because it reads the
   corpus from disk and `intake/core/` holds no I/O.
5. The test suites' path to the demo corpus updated to `intake/eval/corpus-demo/`.
6. Verdict engine 1.0.0 → 1.1.0 (ground-intake-extraction D7):
   - an unknown constraint kind, a missing-condition policy other than `HOLD`, and `stressFrom` on a non-`max`
     constraint hold with `UNSUPPORTED_OPERATOR`
   - a `UnitError` raised while summing or comparing holds with its code (`DIMENSION_MISMATCH` or `UNIT_UNKNOWN`)
     instead of escaping `evaluate`
   - `CheckRequest.applied`: values a change applies, summed in a `budget_sum` and compared in a `max`, `min` or
     `equality`; a non-budget check compares exactly one value
   - `Constraint.stressFrom`: a `max` check that bounds one applied value by the part's ABS_MAX reading and the
     rule's limit, citing the lower; the only use of an ABS_MAX reading
   Tests: `test/knowledge/verdict/intake-extensions.test.ts`.
7. Reason codes: an `intake` category added for the intake's validators (`FIELD_UNKNOWN`, `VALUE_NOT_IN_UNIT`,
   `UNIT_NOT_CONTAINED`, `QUALIFIER_COLUMN_MISMATCH`, `QUALIFIER_COLUMN_AMBIGUOUS`, `BOUND_WORDING_MISMATCH`,
   `FOOTNOTE_QUALIFIED`, `LOW_CONFIDENCE`); the catalog test expects the ninth category.
8. Evaluation harness (`intake/eval/run.ts`, `corpus.ts`): `runEvaluationWith` takes any document ingester (the
   intake's own pipeline) and `runEvaluation` wraps it with cortex's text path; a document that cannot be ingested is
   listed in `notEvaluated` rather than scored; `DocumentResult.reasonCounts` counts each validator's rejections and
   reviews; a corpus document may name its `pages` and its reference `url`. cortex's harness tests pass unchanged.
