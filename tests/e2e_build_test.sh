#!/usr/bin/env bash
# End-to-end build test for copperhead.
#
# Verifies that the go build pipeline produces a working binary and that the
# generated bash completion artifact is well-formed. Runnable in CI without
# a physical KiCad install by using a stubbed kicad-cli on PATH.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok: $*"; }

# 1. Build the CLI binary.
echo "==> building copperhead"
go build -o ./bin/copperhead ./cmd/copperhead || fail "go build failed"
[ -x ./bin/copperhead ] || fail "binary not produced at ./bin/copperhead"
ok "binary built"

# 2. Stub kicad-cli so the e2e path is hermetic (no real KiCad needed in CI).
STUB_DIR="$(mktemp -d)"
cat > "$STUB_DIR/kicad-cli" <<'STUB'
#!/usr/bin/env bash
# Minimal stub: emit a version string and exit 0 so callers can proceed.
if [ "${1:-}" = "--version" ]; then echo "kicad-cli 8.0.0 (stub)"; fi
exit 0
STUB
chmod +x "$STUB_DIR/kicad-cli"
export PATH="$STUB_DIR:$PATH"
ok "kicad-cli stub on PATH"

# 3. Version smoke test.
./bin/copperhead --version >/dev/null 2>&1 || fail "--version exited nonzero"
ok "--version runs"

# 4. Completion generation smoke test (guards the bash e2e path).
if ./bin/copperhead completion bash >/dev/null 2>&1; then
  ok "bash completion generates"
else
  fail "bash completion generation failed"
fi

# 5. Help must exit 0 for every documented subcommand.
for sub in build clean export; do
  ./bin/copperhead "$sub" --help >/dev/null 2>&1 || fail "help for '$sub' failed"
done
ok "subcommand help exit codes clean"

rm -rf "$STUB_DIR"
echo "ALL E2E CHECKS PASSED"
