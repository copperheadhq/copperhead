#!/usr/bin/env bash
# Render the golden corpus and control references to SVG (task 9.5): every
# sheet the suite pins lands in one directory for CI to upload, so a reviewer
# can eyeball layout changes without checking the branch out. The pin
# violations themselves fail `npm test`; rendering is presentation only.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-golden-renders}"
mkdir -p "$OUT"
shopt -s nullglob
count=0
for sch in test/fixtures/golden/*.kicad_sch test/fixtures/legibility/*.kicad_sch \
  test/fixtures/open-key/hardware/*.kicad_sch manual-tests/reference-boards/*/reference/*.kicad_sch; do
  name="$(echo "${sch%.kicad_sch}" | tr '/' '_')"
  kicad-cli sch export svg --no-background-color -o "$OUT/$name" "$sch" >/dev/null
  count=$((count + 1))
done
echo "rendered $count schematic(s) to $OUT/ ($(find "$OUT" -name '*.svg' | wc -l) SVG page(s))"
