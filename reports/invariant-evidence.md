# Invariant evidence for the reviewed source

The following mapping was checked against source and passing tests on the final combined public branch. This is evidence for the requested contribution checklist, not a claim that aggregate test totals prove every possible behavior. The production loop, ledger, check command, s-expression parser, transcript writer, redactor and .gitignore are unchanged from the upstream base; the test-only replay substitutes only the existing model boundary.

| Required invariant | Direct evidence and scope |
| --- | --- |
| Spec-gated in | `test/gating-sync.test.ts` asserts edit_file/write_file absent from both tool views before proposal validation and denies dispatch; validation then unlocks them. The real-tool replay also uses proposal/validation gates. |
| Verification-gated out | `test/gating-sync.test.ts` blocks finish on open obligations and unverified ERC; `test/repair-cycles.test.ts` covers the repair limit; `test/safety.test.ts` verifies byte-identical snapshot restoration. The real replay's missing-final-response case fails after seven stages and commits no devplan. Existing normalized DRC treatment of intrinsic footprint findings is retained, not claimed zero-error raw DRC. |
| check/verify remains LLM-free and network-free | `test/init-check.test.ts` traverses the check module graph and rejects provider/SDK imports. `src/commands/check.ts` is unchanged; manual check ran without a model credential. |
| No s-expression round-trip serialization | The parser source is unchanged. Generated-power tests compare complete templates and preserve schematic bytes; existing reference-board/footprint byte contracts passed. The new package profile reads parsed data and hashes inputs rather than rewriting them. |
| Sync-obligations ledger | `test/ledger.test.ts` checks mutation hooks and scoped clearing; `test/gating-sync.test.ts` proves finish refuses open obligations. Ledger and production loop code are unchanged, and the eight-stage replay executes them. |
| Secrets | `test/safety.test.ts` writes synthetic key-shaped values through the actual transcript/summary and asserts redaction. The redactor, writer and .gitignore are unchanged; .env and .copperhead/runs remain ignored. The replay forbids live providers and its runner removes model-key variables. No actual credential value is a fixture. |
| Spec coherence | SPEC and the related active artifacts link to `fix-create-stage-evidence`; its proposal/design/deltas/tasks are present. Official OpenSpec 1.14.1 strict validation passes with zero issues. Legacy default validation passes separately, while original strict warnings and flat SPEC discovery limitations remain disclosed. |

All named regression files passed in the 1296-pass default suite or five-pass gated job. No live official-provider parity, remote CI, physical board test or fabrication release is inferred from this matrix.

A separate bounded read-only review confirmed this mapping on 2026-10-09. It found no remaining invariant blocker, while retaining the disclosed local/test scope and the unperformed validation limits.
