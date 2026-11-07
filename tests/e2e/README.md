# End-to-end tests

`create_pipeline.e2e.test.ts` drives `copperhead create` through all eight
stages (spec-seed → architecture → part-selection → schematic → layout-draft →
outputs → firmware → dev-plan) from a natural-language brief to a committed
final stage.

## Requirements

- Node 20+
- A built CLI (`npm run build` → `dist/cli.js`)
- `git` on `PATH`
- `kicad-cli` on `PATH` (tests are skipped automatically when absent)

## Running
