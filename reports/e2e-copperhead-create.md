# End-to-End Test Report: `copperhead create` (brief → clean full run)

## Summary
This report documents an end-to-end test of the `copperhead create` command flow, from an initial brief through a clean full run, plus reproducible findings.

## Test Environment
- OS: Linux (x86_64)
- Go: 1.22+
- Bash: 5.x
- Runner: clean container, no prior state

## Test Procedure
```bash
# 1. Build from source
git clone https://github.com/copperheadhq/copperhead.git
cd copperhead
go build -o ./bin/copperhead ./cmd/copperhead

# 2. Verify binary
./bin/copperhead --version

# 3. Provide a brief and run create end-to-end
cat > brief.md <<'EOF'
# Brief
Build a minimal HTTP service that exposes GET /health returning {"status":"ok"}.
EOF

./bin/copperhead create --brief brief.md --out ./out --verbose 2>&1 | tee run.log

# 4. Assert clean exit + expected artifacts
test -d ./out && echo "ARTIFACTS_OK" || echo "ARTIFACTS_MISSING"
grep -qi "error\|panic\|traceback" run.log && echo "ERRORS_FOUND" || echo "CLEAN_RUN"
```

## Results
- Build: **success** (no warnings on a clean checkout).
- `create` exited **0** on the happy path with a valid brief.
- Artifacts were written to `./out` as expected.
- Full run completed without panic/traceback.

## Findings

### F1 — Missing brief file produces an unclear error (medium)
Running `copperhead create --brief does-not-exist.md` fails with a generic I/O error rather than a targeted message such as `brief file not found: does-not-exist.md`. **Recommendation:** validate the `--brief` path up front and emit a specific, actionable error.

### F2 — `--out` directory is created implicitly with no confirmation (low)
When `--out` does not exist, it is created silently. **Recommendation:** log `created output directory: <path>` at info level for observability.

### F3 — Verbose output interleaves with progress on non-TTY (low)
Piping to a file (`| tee run.log`) mixes progress indicators with logs. **Recommendation:** detect non-TTY and suppress spinner/progress, keeping only structured log lines.

### F4 — No `--dry-run` for `create` (enhancement)
A dry-run that validates the brief and prints the planned steps without side effects would speed up iteration.

## Clean Full Run Checklist
- [x] Builds from a clean checkout
- [x] `--version` works
- [x] Happy-path `create` exits 0
- [x] Artifacts produced in `--out`
- [x] No panics/tracebacks in logs
- [ ] Edge cases (F1–F3) to be hardened

## Reproduction
All steps above are copy-pasteable. `run.log` plus `./out` capture the full run for maintainer review.
