# Placement boards

Committed projects for exercising the **placement** side of the layout framework (`copperhead pcb place`) against a board nobody hand-placed. They are to the placers what `../reference-boards/` is to the drafting engine — with one difference: there is no byte contract. A placement is judged by its numbers (HPWL, courtyard overlaps, congestion, routability) and by eye, not by equality with a stored file, so nothing here runs in CI.

## What a placement board holds

Inputs only:

- `schematic.intent.json`, `docs/BOM.md`, `docs/SUBSYSTEMS.md` — the design, as intent
- `<name>.kicad_sch` — the sheet `copperhead draft schematic` drew from that intent
- `<name>.kicad_pcb` — the board as `populateBoard` bootstraps it: every footprint present on a shelf-pack grid, pads carrying their nets, an outline sized to fit, nothing routed. **This is the starting state the placers are measured from**, so it is never overwritten by a run.
- `sym-lib-cache/` — symbols vendored from the machine's KiCad libraries, so a re-draft is hermetic
- `layout-intent.yaml` — the layout requirements (edges, attachments, groups) in the intent language of RFC 11 §7.3. Held *beside* the auto-discovered name on purpose: `run.sh --intent` copies it in as `intent.yaml`, so "what do the placers do on their own" and "what do they do when told" stay separate questions.
- `generations/<label>/` — one archived result per build, committed. See below.

## Running

```bash
manual-tests/placement-boards/run.sh                      # esp32-amp, no layout intent
manual-tests/placement-boards/run.sh --intent             # ... honouring layout-intent.yaml
manual-tests/placement-boards/run.sh --save               # ... and archive it as a generation
manual-tests/placement-boards/run.sh esp32-amp -- --mode ensemble --seed 3   # pass through to `pcb place`
```

Each run materializes a fresh copy of the project under `manual-tests/runs/placement/<board>/` (gitignored), places it there with `--apply`, and renders before/after. The committed grid board is never touched, so two runs are comparable by construction.

Prerequisites: `kicad-cli`, the vendored engines (`scripts/tools.sh`), and ImageMagick's `convert` for the PNGs. The script points `COPPERHEAD_PYTHON` at the kicad-tools venv, because pyplacer needs numpy and the system python usually has none.

## Generations

`--save` archives the result into `<board>/generations/<label>/` — by default `<date>-<git short sha>`, with `-intent` appended when the run honoured the intent file. Each directory holds the placed board, both renders, the ranking, the raw log, and a `README.md` with the one-table summary. That is the artifact a later generation gets compared against: same inputs, same command, different build.

## Boards

- `esp32-amp/`: ESP32-S3-WROOM-1 driving a MAX98357A I2S class-D amplifier from USB-C. 30 parts, 22 declared nets, five subsystems in a left-to-right signal flow (USB-C power in → 3V3 LDO → module → amplifier → speaker terminal). Exercises: a large module anchoring the board, three connectors that want three different edges, two supply rails (5V for the class-D stage, 3V3 for everything else), decoupling that belongs at named pins, a differential output pair through an EMI filter, and enough 0402 passives that the packers have somewhere to put them wrong.
