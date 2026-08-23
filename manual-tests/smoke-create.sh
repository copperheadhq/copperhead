#!/usr/bin/env bash
# smoke-create.sh — smoke test for `copperhead create` pipeline
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

BRIEF="examples/simple/usb-c-breakout.md"
MODEL="${COPPERHEAD_MODEL:-claude-code}"

echo "═══ smoke: copperhead create ($MODEL) ═══"

# 1. Build the CLI
npm run build 2>&1 | tail -1

# 2. Verify kicad-cli >= 8 is installed
KICAD_VER=$(kicad-cli version 2>&1 | head -1)
echo "kicad-cli: $KICAD_VER"
KICAD_MAJOR=$(echo "$KICAD_VER" | grep -oE '^[0-9]+' || echo "0")
if [ "$KICAD_MAJOR" -lt 8 ] 2>/dev/null; then
  echo "ERROR: kicad-cli version >= 8 required (found $KICAD_MAJOR)"
  exit 1
fi

# 3. Create a temp repo with the brief
TMPDIR=$(mktemp -d /tmp/copperhead-smoke-XXXX)
cp "$BRIEF" "$TMPDIR/brief.md"
cd "$TMPDIR"
git init -q
git config user.email smoke@copperhead.local
git config user.name smoke
git add brief.md && git commit -q -m "brief"

# 4. Run the pipeline via node (not global copperhead)
echo "--- running create pipeline ---"
CACHE_SRC="$ROOT/.copperhead/llm-cache"
if [ -d "$CACHE_SRC" ]; then
  mkdir -p .copperhead
  cp -r "$CACHE_SRC" .copperhead/llm-cache
  echo "  (using llm-cache from $CACHE_SRC)"
fi
node "$ROOT/dist/cli.js" create --brief brief.md --model "$MODEL" --plain 2>&1 | tee run.log

# 5. Check results (recursive search for KiCad artifacts under hardware/)
echo "--- checking stage artifacts ---"
FAIL=0
for f in docs/SPEC.md docs/SUBSYSTEMS.md docs/BOM.md docs/PINOUT.md docs/LAYOUT.md docs/DEVPLAN.md outputs firmware; do
  if [ -e "$f" ]; then
    echo "  ✓ $f"
  else
    echo "  ✗ $f MISSING"
    FAIL=1
  fi
done
KICAD_SCH=$(find . -maxdepth 3 -name "*.kicad_sch" -print -quit 2>/dev/null)
KICAD_PCB=$(find . -maxdepth 3 -name "*.kicad_pcb" -print -quit 2>/dev/null)
if [ -n "$KICAD_SCH" ] && [ -s "$KICAD_SCH" ]; then
  echo "  ✓ $KICAD_SCH (non-empty)"
else
  echo "  ✗ .kicad_sch MISSING or empty"
  FAIL=1
fi
if [ -n "$KICAD_PCB" ] && [ -s "$KICAD_PCB" ]; then
  echo "  ✓ $KICAD_PCB (non-empty)"
else
  echo "  ✗ .kicad_pcb MISSING or empty"
  FAIL=1
fi

if [ "$FAIL" = 1 ]; then
  echo "═══ SMOKE FAILED ═══"
  exit 1
fi
echo "═══ SMOKE PASSED ═══"
exit 0
