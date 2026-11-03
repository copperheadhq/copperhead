# Preserved 500 mA live-run evidence

Prepared on 2026-10-09 by read-only inspection of the original experiment files. This package contains filtered existing live CLI logs and native summaries, plus original raw DRC reports, plus explicitly labelled audit extractions. It does not contain a new model run, a rerun of Copperhead, or reconstructed execution results. Publication still requires the owning PR's review.

## Supported conclusion

The same protected USB-C 500 mA design has eight distinct stage commits and matching original transcript terminal events. Its final Git HEAD is `f3cee1a1ea6a10245633b6c355de16e3bd4b097e`; the observed worktree is clean. The final v21 CLI metadata records exit code 0 at 2026-10-09 00:11:58 UTC. Its report says eight stages, one ran and seven resumed.

This was segmented execution with the experimental-native adapter, locally patched source, supplied task research, and resumed sessions. It is not a fresh, uninterrupted run through an official supported provider. Local hash consistency is not independent provider attestation. Token and cost usage remain unknown; preserved zero counters are placeholders.

## Contents and provenance

- `live-cli/`: filtered derivatives of all 15 original v7–v21 CLI logs and their metadata. Only CLI structural, environment, verification and terminal lines remain; model narrative is removed. Original line numbers and hashes are recorded.
- `native-run-summaries/`: filtered derivatives of all 20 preserved summaries, including unsuccessful attempts. Only the preamble, Environment, Run stats and Verification sections remain; plans, narrative and decisions are excluded. The two interrupted transcripts at `2026-10-08T19-56-56-701Z` and `2026-10-08T22-14-53-162Z` have no original summary or terminal record; neither was invented.
- `native-gate-events/`: 22 clearly named filtered transcript derivatives. They retain lifecycle/commit/terminal events and verification tool results. Model messages, request/response bodies, file-read/write bodies, tool arguments and envelopes are excluded. These files are not complete transcripts.
- `native-final-report/`: the original final CLI stage report.
- `raw-kicad/`: original v15/v16 direct KiCad DRC JSON, stdout/stderr and invocation verification metadata. JSON byte identity is recorded in the file manifest.
- `design-git-proof-chain.json`: newly extracted commit/tree/parent relationships, successful original transcript exit paths, and final tracked-file SHA-256/Git blob hashes. Author identity is not included. The original Git objects are separately preserved privately.
- `adapter-record-binding-audit.json`: new static audit of 15 original run manifests and ledgers. All 49 accepted request/response records passed the original canonical request/message/tool/response hashes and identity bindings. There were 52 issued requests, with three cancelled. No model was called. Raw request/response and session content remain private.
- `historical-runtime-manifests/`, `runtime-manifest-current-comparison.json`, and `runtime-and-library-provenance.json`: retained historical hashes, present-day comparison and explicit recoverability limits.
- `file-provenance-and-redactions.json`: every source-derived publication file's original hash, published hash, byte counts and applied transformations. Newly authored audit documents are distinguished from original evidence. `SHA256SUMS` covers the completed package's files other than itself.

## Raw DRC and ERC limits

The v16 raw DRC invocation exited 5 and contains four error-severity `hole_clearance` findings: configured minimum 0.2500 mm versus actual 0.1944 mm. It records zero unconnected items. Its verification metadata identifies board SHA-256 `b07e3bfa0236ad11b54fbd4554b2cabb377a1cdee0bb4e1606a0f03e1e854470`, which exactly matches the final committed PCB. The report records KiCad 9.0.2. Schematic-parity verification was not explicitly requested in that invocation; an empty field is not evidence of a separately requested parity check.

The native final gate results say `ERC: clean` and classify the same four DRC findings as intrinsic to one library footprint. The original CLI may therefore say all checks green. This must not be shortened to zero raw DRC errors. No standalone original raw ERC JSON or final-audit raw DRC JSON was located in the scoped task files. The preserved v16 raw DRC remains useful evidence for the byte-identical final PCB; it is not relabelled as a later invocation.

## Runtime and environment limits

The recorded source commit `e26be947ed31a35fbbb52623174bb25017d6cd44` is the upstream base, not a clean immutable snapshot of the patched runtime used across every stage. Current source and compiled output differ from several early hashes. Exact early adapter files, selected source snapshots, incremental patches and a matching package lock survive, but no immutable complete per-stage source/build/dependency/binary/library snapshot was found. A newly preserved current worktree or newly generated full diff must not stand in for such a historical snapshot.

Preserved run summaries record Copperhead 0.11.0, KiCad CLI 9.0.2, Node v24.19.0 and linux-x64. The output manifest records profile `jlcpcb-kicad9-2026-09-24`; all four input hashes and all 18 output hashes and sizes still match. Five project-local symbol library caches survive. These records do not freeze every installed dependency, upstream footprint library or 3D model. Manufacturer acceptance remains `not-verified` and hardware/procurement/bench qualification remains open.

## Metadata contradictions kept intact

The final wrapper metadata retains `createComplete:false` alongside `exitCode:0`. The preserved supervisor initializes that field but does not update it. The original CLI, stage report and Git/transcript chain provide the completion evidence. Cancelled ledger state after the successful terminal result is recorded consumer cleanup. Original metadata was not repaired to make it agree.

## Privacy and exclusions

Local workspace/runtime/home paths and any email addresses are replaced by labelled placeholders, with counts recorded per file. Source-derived byte-identical files are explicitly identified. No raw provider/session requests, raw responses, private conversations, authentication files or credential values are part of this publication candidate. The earlier July pipeline logs and the later 29-turn recorded replay are separate experiments and are not substituted for missing original live evidence. A pattern scan is a review aid, not a guarantee; the PR owner should review the candidate before publication.
