#!/usr/bin/env bash
# Run the placement framework against a committed placement board and record
# what it produced. The committed project holds the INPUTS only: the drafted
# schematic and the board as `populateBoard` bootstraps it (every footprint on
# a shelf-pack grid, pads netted, nothing routed). Each run materializes a
# fresh copy under manual-tests/runs/placement/<board>/ (gitignored), places it
# there, and renders before/after, so the committed grid board is never touched
# and two runs are comparable.
#
# Usage: manual-tests/placement-boards/run.sh [board] [--intent] [--save [label]] [-- <pcb place args>]
#
#   board     directory under manual-tests/placement-boards/ (default: esp32-amp)
#   --intent  copy the board's layout-intent.yaml in as intent.yaml, so the run
#             honours the attachment/edge/group requirements. Held out of the
#             default run because it is a separate question from "what do the
#             placers do on their own", and the two results are compared.
#   --save    archive the result into <board>/generations/<label>/ (committed):
#             the placed board, both renders, the ranking, the log, and a
#             summary. That directory is the thing a later generation is
#             compared against, so the label says which build produced it
#             (default: <date>-<git short sha>[-intent]).
#
# Default place args: --mode race --blocks --seed 0 --budget-seconds 600
set -euo pipefail
cd "$(dirname "$0")/../.."

BOARD=esp32-amp
INTENT=0
SAVE=0
LABEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --intent) INTENT=1; shift ;;
    --save) SAVE=1; shift; case "${1:-}" in ""|-*) ;; *) LABEL="$1"; shift ;; esac ;;
    --) shift; break ;;
    -*) echo "unknown flag $1" >&2; exit 1 ;;
    *) BOARD="$1"; shift ;;
  esac
done
PLACE_ARGS=("$@")
[ ${#PLACE_ARGS[@]} -eq 0 ] && PLACE_ARGS=(--mode race --blocks --seed 0 --budget-seconds 600)

SRC="manual-tests/placement-boards/$BOARD"
RUN="manual-tests/runs/placement/$BOARD"
[ -d "$SRC" ] || { echo "no placement board at $SRC" >&2; exit 1; }

# pyplacer needs a numpy-bearing interpreter; the kicad-tools venv has one.
KT_PY="$PWD/vendor/tools/kt-venv/bin/python"
[ -x "$KT_PY" ] && export COPPERHEAD_PYTHON="${COPPERHEAD_PYTHON:-$KT_PY}"

rm -rf "$RUN"
mkdir -p "$(dirname "$RUN")"
cp -r "$SRC" "$RUN"
mkdir -p "$RUN/render"
if [ "$INTENT" = 1 ]; then
  [ -f "$SRC/layout-intent.yaml" ] || { echo "$BOARD has no layout-intent.yaml" >&2; exit 1; }
  cp "$SRC/layout-intent.yaml" "$RUN/intent.yaml"
  echo "intent: honouring $SRC/layout-intent.yaml"
fi
PCB="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$RUN/.copperhead/config.json','utf8')).board)")"

render() { # render <board file> <name>
  kicad-cli pcb export svg --output "$RUN/render/$2.svg" --layers "F.Cu,B.Cu,Edge.Cuts,F.Fab" \
    --page-size-mode 2 --exclude-drawing-sheet "$1" >/dev/null
  command -v convert >/dev/null && convert -density 200 -background white -flatten "$RUN/render/$2.svg" "$RUN/render/$2.png"
}

cp "$RUN/$PCB" "$RUN/render/before.kicad_pcb"
render "$RUN/render/before.kicad_pcb" before

echo "== copperhead pcb place ${PLACE_ARGS[*]} =="
# the gate-failure list repeats one diagnostic per overlapping pair and runs to
# hundreds of entries; the full text stays in place.log, the console gets a count
npx tsx src/cli.ts --repo "$RUN" pcb place "${PLACE_ARGS[@]}" \
  --run-dir .copperhead/runs/place --apply 2>&1 | tee "$RUN/render/place.log" \
  | sed -E 's/((geom|drc)\.[a-z_-]+; ){3,}/(repeated diagnostics elided) /g' || true

render "$RUN/$PCB" after

# the comparable numbers, one row per engine
node -e '
const fs=require("fs");
const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const n=(v,d=1)=>v==null?"-":(+v).toFixed(d);
const rows=r.candidates.map(c=>({engine:c.id,rank:c.rank,eligible:c.eligible,
 hpwl_mm:n(c.metrics.hpwl_nm/1e6),courtyard_overlaps:c.metrics.courtyard_overlap_count,
 congestion:c.metrics.congestion_overflow,outside:c.metrics.outside_board_count,
 legalized:c.metrics.legalized_moves,
 routed:c.metrics.routability_completion==null?"-":(100*c.metrics.routability_completion).toFixed(1)+"%",
 runtime_s:n(c.metrics.runtime_s)}));
console.log("\nprofile "+r.profile+" | selected "+r.selected);
console.table(rows);
fs.writeFileSync(process.argv[2],JSON.stringify({profile:r.profile,selected:r.selected,rows},null,2));
' "$RUN/.copperhead/runs/place/ranking.json" "$RUN/render/summary.json"

if [ "$SAVE" = 1 ]; then
  SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
  SUFFIX=""
  if [ "$INTENT" = 1 ]; then SUFFIX="-intent"; fi
  AUTO=0
  if [ -z "$LABEL" ]; then LABEL="$(date +%Y-%m-%d)-$SHA$SUFFIX"; AUTO=1; fi
  GEN="$SRC/generations/$LABEL"
  # An auto label is date + commit, so two runs from the same dirty tree collide
  # — and silently overwriting is how you lose the baseline you meant to compare
  # against. Only an explicitly named generation may be replaced.
  if [ "$AUTO" = 1 ] && [ -d "$GEN" ]; then
    echo "generation $LABEL already exists; name this one: --save <label>" >&2
    exit 1
  fi
  rm -rf "$GEN"; mkdir -p "$GEN"
  # the placed board only exists when a candidate passed the gates and was applied
  if grep -q "^  applied " "$RUN/render/place.log"; then cp "$RUN/$PCB" "$GEN/placed.kicad_pcb"; fi
  cp "$RUN/render/before.png" "$RUN/render/after.png" "$GEN/" 2>/dev/null || true
  cp "$RUN/render/after.svg" "$GEN/after.svg"
  cp "$RUN/render/summary.json" "$RUN/render/place.log" "$GEN/"
  cp "$RUN/.copperhead/runs/place/ranking.json" "$RUN/.copperhead/runs/place/outcome.json" "$RUN/.copperhead/runs/place/plan.json" "$GEN/" 2>/dev/null || true
  if [ "$INTENT" = 1 ]; then cp "$RUN/intent.yaml" "$GEN/intent.yaml"; fi
  node -e '
  const fs=require("fs"), s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const o=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
  const [label,intent,args,sha]=process.argv.slice(3);
  const applied=fs.existsSync(process.argv[7].replace(/README\.md$/,"placed.kicad_pcb"));
  const cols=["engine","rank","eligible","hpwl_mm","courtyard_overlaps","congestion","outside","legalized","routed","runtime_s"];
  const md=[`# ${label}`,"",`- commit \`${sha}\``,`- \`copperhead pcb place ${args}\``,
    `- layout intent: ${intent==="1"?"honoured (intent.yaml)":"none"}`,
    `- profile \`${s.profile}\``,`- outcome **${o.status}** — ${o.summary}`,"",
    "| "+cols.join(" | ")+" |","|"+cols.map(()=>" --- ").join("|")+"|",
    ...s.rows.map(r=>"| "+cols.map(c=>String(r[c])).join(" | ")+" |"),
    "",applied?`Files: \`placed.kicad_pcb\` (the board that was applied), \`before.png\` / \`after.png\`, \`ranking.json\`, \`place.log\`.`
       :`No \`placed.kicad_pcb\`: no candidate passed the gates, so nothing was applied and \`after.png\` still shows the bootstrap grid. \`ranking.json\` and \`place.log\` hold why.`,""];
  fs.writeFileSync(process.argv[7],md.join("\n"));
  ' "$RUN/render/summary.json" "$RUN/.copperhead/runs/place/outcome.json" "$LABEL" "$INTENT" "${PLACE_ARGS[*]}" "$SHA" "$GEN/README.md"
  echo "saved:   $GEN"
fi

echo
echo "run:     $RUN/.copperhead/runs/place"
echo "renders: $RUN/render/{before,after}.png"
