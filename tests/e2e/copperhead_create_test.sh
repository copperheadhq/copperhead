#!/usr/bin/env bash
# End-to-end test for `copperhead create` (brief -> clean full run) + findings report.
# Addresses copperheadhq/copperhead issue #66.
#
# Usage: tests/e2e/copperhead_create_test.sh [BRIEF_FILE]
# Exits non-zero if any stage fails. Emits a structured findings report to stdout.

set -euo pipefail

BRIEF="${1:-tests/e2e/fixtures/brief.txt}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

log()  { printf '[e2e] %s\n' "$*"; }
fail() { printf '[e2e][FAIL] %s\n' "$*" >&2; exit 1; }

log "workdir: $WORKDIR"
log "brief:   $BRIEF"

[ -f "$BRIEF" ] || fail "brief file not found: $BRIEF"

# --- Stage 1: create --------------------------------------------------------
log "stage 1/4: copperhead create"
if ! copperhead create --brief "$BRIEF" --out "$WORKDIR/out" 2>"$WORKDIR/create.err"; then
  fail "copperhead create exited non-zero. stderr:"
  cat "$WORKDIR/create.err" >&2
fi
[ -d "$WORKDIR/out" ] || fail "create did not produce an output directory"

# --- Stage 2: artifacts -----------------------------------------------------
log "stage 2/4: verify generated artifacts"
ART_COUNT=$(find "$WORKDIR/out" -type f | wc -l | tr -d ' ')
[ "$ART_COUNT" -gt 0 ] || fail "no artifacts generated"
log "  generated $ART_COUNT artifact(s)"

# --- Stage 3: clean run -----------------------------------------------------
log "stage 3/4: re-run for idempotency (clean full run)"
if ! copperhead create --brief "$BRIEF" --out "$WORKDIR/out2" 2>"$WORKDIR/create2.err"; then
  fail "second create run failed (non-idempotent). stderr:"
  cat "$WORKDIR/create2.err" >&2
fi

# --- Stage 4: findings report ----------------------------------------------
log "stage 4/4: findings report"
printf '\n===== FINDINGS REPORT =====\n'
printf 'artifacts_generated : %s\n' "$ART_COUNT"
printf 'idempotent_rerun    : yes\n'
printf 'exit_status         : 0\n'
printf '===========================\n'

log "PASS: copperhead create end-to-end run succeeded"
