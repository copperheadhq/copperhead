## 1. Proposer

- [x] 1.1 `proposals/bindings.ts`: prompt and reply parsing (design D1, D2).
- [x] 1.2 `scripts/propose-bindings.ts`: the call and the bindings file (design D3).
- [x] 1.3 Tests in `test/proposals.test.ts`: a deterministic prompt; kept and dropped parts, kinds and roles; a reply without blocks.

## 2. Verification

- [x] 2.1 `npm run typecheck`, `npm test`; out of tree, proposals for the BoardRepo corpus applied through block-map and scored against the labels.
