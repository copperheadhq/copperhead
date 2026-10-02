## Why

copperhead-tools' block-map recognises most regulator blocks deterministically and misses the rest:
switching controllers, DC-DC modules whose pins read IN+ and OUT+, PMICs. A model reads those from
their netlist neighbourhood. RFC 17 Section 3.1 allows that only as a proposal a verifier decides on;
block-map is the verifier (it checks every proposed part against the nets its role needs) and emits
closed context bundles (`--context`). The proposer that turns bundles into a bindings file is missing.

## What Changes

- `proposals/bindings.ts` (pure): the prompt built from context bundles alone, with the role definitions
  the corpus labels use; and the reply parsed into proposed blocks keeping only parts asked about, known
  kinds and roles, and fitted parts listed in each part's bundle, counting everything dropped.
- `scripts/propose-bindings.ts`: one reasoning-only Claude call (tools disabled, one turn, the Claude
  Code saved login) for a block-map result's bundles, writing a bindings file v1 with `proposedBy` naming
  the model, the proposer version and the prompt hash. block-map then applies it only after checking
  each part.

## Capabilities

### New Capabilities

- `binding-proposals`: prompt construction, reply parsing and dropping, the bindings file.

### Modified Capabilities

None.

## Impact

- `intake/proposals/bindings.ts`, `intake/scripts/propose-bindings.ts`, `intake/test/proposals.test.ts`.
- Evaluated out of tree on the BoardRepo corpus: proposals for the parts the deterministic map missed or
  bound differently from the labels, applied through block-map's verifier.
- Not in scope: proposing for parts block-map was not asked about, trusting any proposal, datasheet
  facts (part packs).
