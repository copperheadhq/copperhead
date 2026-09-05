#!/usr/bin/env bash
# Regression-test the drafting engine against the committed reference boards:
# re-draft a copy, byte-compare to the reference, render for eyeballing.
# --update copies the fresh draft and render over reference/ (review the diff).
set -euo pipefail
cd "$(dirname "$0")/.."

UPDATE=0
for arg in "$@"; do
  [ "$arg" = "--update" ] && UPDATE=1
done

FAIL=0
for board_dir in manual-tests/reference-boards/*/; do
  board="$(basename "$board_dir")"
  run="manual-tests/runs/reference-boards/$board"
  rm -rf "$run"
  mkdir -p "$run"
  cp -r "$board_dir"/. "$run/"
  rm -rf "$run/reference"
  echo "[$board] drafting..."
  npx tsx src/cli.ts --repo "$run" draft schematic
  sch="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$run/.copperhead/config.json','utf8')).schematic)")"
  ref="$board_dir/reference/$(basename "$sch")"
  if [ "$UPDATE" = 1 ]; then
    cp "$run/$sch" "$ref"
    echo "[$board] reference schematic updated"
  elif cmp -s "$run/$sch" "$ref"; then
    echo "[$board] byte-identical to reference"
  else
    echo "[$board] DIFFERS from reference:"
    diff "$ref" "$run/$sch" | head -20 || true
    FAIL=1
  fi
  # visual loop (best effort: requires kicad-cli; convert for PNG)
  if command -v kicad-cli >/dev/null; then
    kicad-cli sch export svg --no-background-color -o "$run/render" "$run/$sch" >/dev/null
    svg="$run/render/$(basename "$sch" .kicad_sch).svg"
    # strip KiCad's invisible searchable-text layer: ImageMagick paints it
    node -e "const fs=require('fs');const p='$svg';fs.writeFileSync(p.replace(/\.svg$/,'.clean.svg'),fs.readFileSync(p,'utf8').replace(/<text[^>]*>[\s\S]*?<\/text>/g,''))"
    if command -v convert >/dev/null; then
      png="$run/render/$(basename "$sch" .kicad_sch).png"
      convert -density 150 -background white -flatten "${svg%.svg}.clean.svg" "$png"
      echo "[$board] rendered $png (reference: $board_dir/reference/)"
      if [ "$UPDATE" = 1 ]; then
        cp "$png" "$board_dir/reference/"
        echo "[$board] reference render updated"
      fi
    fi
  fi
done
exit $FAIL
