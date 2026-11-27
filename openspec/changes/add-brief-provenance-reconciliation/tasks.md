# add-brief-provenance-reconciliation: Tasks

- [x] 1.1 Snapshot external briefs to `<docs>/BRIEF.md` in `writeBriefHash` while preserving `wx` write-once behavior on `BRIEF.sha256`.
- [x] 1.2 Enforce `resolveInRepo` sandboxing, case-insensitive hex matching, and missing-file detection in `checkBriefProvenance` and `reconcileBriefHash`.
- [x] 1.3 Expose stable `brief: BriefProvenanceStatus | null` on `CheckResult` and wire `sync` / `sync --brief` (including `--dry-run` and `DECISIONS.md`/`CHANGELOG.md` logging).
- [x] 1.4 Document `--brief` in `docs/src/content/docs/reference/cli.md` and `openspec/specs/SPEC.md`, and add unit tests in `test/create-provenance.test.ts`.
