#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_DIR="${COPPERHEAD_DEMO_DIR:-$ROOT/demo-runs/usb-c-breakout}"
BRIEF="$ROOT/examples/simple/usb-c-breakout.md"

mkdir -p "$DEMO_DIR"

if [ ! -d "$DEMO_DIR/.git" ]; then
  git -C "$DEMO_DIR" init -q
fi

if ! git -C "$DEMO_DIR" config user.name >/dev/null; then
  git -C "$DEMO_DIR" config user.name "copperhead demo"
fi

if ! git -C "$DEMO_DIR" config user.email >/dev/null; then
  git -C "$DEMO_DIR" config user.email "demo@copperhead.local"
fi

touch "$DEMO_DIR/.gitignore"
if ! grep -qxF ".copperhead/runs/" "$DEMO_DIR/.gitignore"; then
  printf '%s\n' ".copperhead/runs/" >> "$DEMO_DIR/.gitignore"
fi

# The default maxTurns (40) is tuned for a single `do` edit. A create stage
# seeds several constraints, and each one opens an affects-revisit obligation
# that must be resolved individually before finish is allowed, so the stage
# needs a bigger budget than a one-shot edit does.
mkdir -p "$DEMO_DIR/.copperhead"
if [ ! -f "$DEMO_DIR/.copperhead/config.json" ]; then
  cat > "$DEMO_DIR/.copperhead/config.json" <<'JSON'
{
  "docs": "docs/",
  "maxTurns": 100,
  "maxRepairCycles": 5
}
JSON
fi

# Both files must be committed, not merely present: a failed run rolls back with
# `git clean -fd`, which would delete them if they were untracked.
git -C "$DEMO_DIR" add .gitignore .copperhead/config.json
if ! git -C "$DEMO_DIR" rev-parse --verify HEAD >/dev/null 2>&1; then
  git -C "$DEMO_DIR" commit -q -m "demo: initialize repository"
elif ! git -C "$DEMO_DIR" diff --cached --quiet; then
  git -C "$DEMO_DIR" commit -q -m "demo: update demo scaffolding"
fi

DOCS_DIR="$(node -e 'const fs = require("node:fs"); const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(config.docs || "docs/")' "$DEMO_DIR/.copperhead/config.json")"
case "$DOCS_DIR" in
  ""|/*|..|../*|*/../*|*/..)
    printf 'refusing unsafe docs directory in %s\n' "$DEMO_DIR/.copperhead/config.json" >&2
    exit 1
    ;;
esac
DOCS_DIR="${DOCS_DIR%/}"
DEMO_ROOT="$(cd "$DEMO_DIR" && pwd -P)"
mkdir -p "$DEMO_ROOT/$DOCS_DIR"
DOCS_PATH="$(cd "$DEMO_ROOT/$DOCS_DIR" && pwd -P)"
EXPECTED_DOCS_PATH="$DEMO_ROOT/$DOCS_DIR"
case "$DOCS_PATH/" in
  "$DEMO_ROOT/"*) ;;
  *)
    printf 'refusing docs directory outside the demo repository: %s\n' "$DOCS_DIR" >&2
    exit 1
    ;;
esac
if [ "$DOCS_PATH" != "$EXPECTED_DOCS_PATH" ]; then
  printf 'refusing symlinked docs directory: %s\n' "$DOCS_DIR" >&2
  exit 1
fi
DEMO_BRIEF="$DEMO_ROOT/$DOCS_DIR/BRIEF.md"
if [ -L "$DEMO_BRIEF" ]; then
  printf 'refusing symlinked demo brief: %s\n' "$DOCS_DIR/BRIEF.md" >&2
  exit 1
elif [ -e "$DEMO_BRIEF" ]; then
  if ! cmp -s "$BRIEF" "$DEMO_BRIEF"; then
    printf 'refusing to overwrite %s with different brief content\n' "$DOCS_DIR/BRIEF.md" >&2
    exit 1
  fi
else
  cp "$BRIEF" "$DEMO_BRIEF"
  printf 'copied external brief to %s\n' "$DOCS_DIR/BRIEF.md"
fi
git -C "$DEMO_DIR" add -- "$DOCS_DIR/BRIEF.md"
if ! git -C "$DEMO_DIR" diff --cached --quiet -- "$DOCS_DIR/BRIEF.md"; then
  git -C "$DEMO_DIR" commit -q -m "demo: add product brief"
fi

# Short paths for the banner — absolute walls of text make the TTY feel noisy.
short_path() {
  local p="$1"
  if [[ "$p" == "$HOME"/* ]]; then
    printf '~/%s' "${p#"$HOME"/}"
  elif [[ "$p" == "$ROOT"/* ]]; then
    printf '%s' "${p#"$ROOT"/}"
  else
    printf '%s' "$p"
  fi
}

printf 'copperhead · simple demo\n'
printf 'repo:  %s\n' "$(short_path "$DEMO_DIR")"
printf 'brief: %s\n\n' "$(short_path "$DEMO_BRIEF")"

npm run dev -- --repo "$DEMO_DIR" create --brief "$DEMO_BRIEF" "$@"
