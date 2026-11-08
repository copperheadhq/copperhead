# add-constraint-evidence-verification: Design

## Decisions

1. **Unified `Constraint.evidence` schema (`SPEC.md` §2.6)**: Stored inline on the existing `.copperhead/constraints.json` entry rather than in a parallel file, compatible with `.copperhead/datasheets/index.json` hashes and `<name>.pdf.txt` extracted text sidecars from `add-part-research-tools`.
2. **Sidecar trust and optional binding**: When `path` ends in `.pdf`, `verifyConstraintEvidence` requires `<path>.txt` to exist inside the allowed cache directories (reporting a clear missing-sidecar violation instead of reading binary PDF bytes as UTF-8), checks `sha256` (or `index.json`) against the PDF, and checks `sidecarSha256` against `<path>.txt` when provided.
3. **Preservation in `record_constraint` and enforcement in `check`**: `record_constraint` accepts `evidence` and retains prior `evidence` when updating a key without a new `evidence` payload; `runCheck` merges `verifyConstraintEvidence` results into `constraints.violations` with zero LLM or network calls.
