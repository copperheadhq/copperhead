#!/usr/bin/env bash
# Materialize a sandbox repository for manual CLI testing.
# Usage: ./manual-tests/setup.sh <create|edit> [--fresh]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VARIANT="${1:-}"
FRESH="${2:-}"

if [[ "$VARIANT" != "create" && "$VARIANT" != "edit" ]]; then
  echo "usage: ./manual-tests/setup.sh <create|edit> [--fresh]" >&2
  exit 2
fi

DIR="$ROOT/manual-tests/runs/$VARIANT"
REL="manual-tests/runs/$VARIANT"

if [ -d "$DIR" ]; then
  if [ "$FRESH" = "--fresh" ]; then
    rm -rf "$DIR"
  else
    echo "sandbox already exists: $REL (pass --fresh to recreate it)" >&2
    exit 1
  fi
fi

mkdir -p "$DIR"
git -C "$DIR" init -q

# A sandbox needs its own identity: copperhead commits into it, and a failed
# run rolls back to the git snapshot.
if ! git -C "$DIR" config user.name >/dev/null; then
  git -C "$DIR" config user.name "copperhead manual test"
fi
if ! git -C "$DIR" config user.email >/dev/null; then
  git -C "$DIR" config user.email "manual-test@copperhead.local"
fi

printf '%s\n' ".copperhead/runs/" > "$DIR/.gitignore"

mkdir -p "$DIR/.copperhead"
if [ "$VARIANT" = "create" ]; then
  # A create stage seeds several constraints and each one opens an
  # affects-revisit obligation, so it needs a bigger turn budget than a
  # one-shot edit does.
  cat > "$DIR/.copperhead/config.json" <<'JSON'
{
  "docs": "docs/",
  "maxTurns": 100,
  "maxRepairCycles": 5
}
JSON
else
  cat > "$DIR/.copperhead/config.json" <<'JSON'
{
  "docs": "docs/"
}
JSON
  cp -r "$ROOT/test/fixtures/open-key/hardware" "$DIR/hardware"
fi

# Everything must be committed, not merely present: rollback runs
# `git clean -fd`, which would delete untracked files.
git -C "$DIR" add -A
git -C "$DIR" commit -q -m "manual-test: initialize $VARIANT sandbox"

echo "sandbox ready: $REL"
echo
if [ "$VARIANT" = "create" ]; then
  cat <<EOF
Next, from the repo root:

  npm run dev -- --repo $REL create --brief examples/simple/usb-c-breakout.md

Requires kicad-cli on PATH and an API key in the environment.
EOF
else
  cat <<EOF
Next, from the repo root:

  npm run dev -- --repo $REL init
  git -C $REL add -A && git -C $REL commit -m "scaffold docs"
  npm run dev -- --repo $REL check
  npm run dev -- --repo $REL do "Rename the EN net to CHIP_EN and propagate the change everywhere"

init and check need kicad-cli on PATH; do also needs an API key in the
environment. Commit the scaffolded docs before running do: it refuses a
dirty tree, and a failed run would otherwise clean untracked files away.
EOF
fi
