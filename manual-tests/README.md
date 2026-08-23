# Manual testing

Sandboxes for exercising the CLI end to end, by hand, against a real git repository. The offline test suite (`npm test`) never calls an LLM, so the agent-loop paths (`do`, `create`, `sync` resolve) can only be observed here or in the gated integration tests.

## Prerequisites

- `kicad-cli` on your PATH (every command except `--help` checks for it)
- An API key in the environment for the LLM-backed commands: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, or a saved-login provider (`--model codex`, `--model cursor`, `--model claude-code`)
- `npm install` done at the repo root

## Control boards

`manual-tests/reference-boards/` holds committed reference projects for the deterministic drafting engine, with symbols vendored from the real KiCad libraries. `npm run refboards` re-drafts each board, byte-compares against its reference, and renders a PNG for visual comparison; `npm run refboards -- --update` regenerates the references after a deliberate engine change. The byte contract also runs in CI (`test/draft-reference-boards.test.ts`). See [reference-boards/README.md](reference-boards/README.md).

## Variants

Each variant materializes a self-contained git repository under `manual-tests/runs/` (gitignored). Run everything from the repo root.

### create: brief to full pipeline

An empty repository plus the USB-C breakout brief from `examples/simple/`. Tests Mode A: spec proposal, schematic, verification, output package.

```bash
./manual-tests/setup.sh create
npm run dev -- --repo manual-tests/runs/create create --brief examples/simple/usb-c-breakout.md
```

### edit: task on an existing project

A copy of the known-good `open-key` fixture project (U1, R1, R2, nets 3V3/GND/EN/GPIOx). Tests `init`, `check`, and the core `do` loop on real KiCad files.

```bash
./manual-tests/setup.sh edit
npm run dev -- --repo manual-tests/runs/edit init
git -C manual-tests/runs/edit add -A && git -C manual-tests/runs/edit commit -m "scaffold docs"
npm run dev -- --repo manual-tests/runs/edit check
npm run dev -- --repo manual-tests/runs/edit do "Rename the EN net to CHIP_EN and propagate the change everywhere"
```

Commit the scaffolded docs before `do`: it refuses a dirty tree, and a failed run rolls back with `git clean -fd`, which deletes untracked files.

Other things worth trying in the edit sandbox: `sync` after hand-editing a doc out from under the schematic, `do --dry-run`, `do --interactive`, and a task that violates a budget to see the refusal path (AC-3.4).

## Resetting

Pass `--fresh` to wipe and recreate a sandbox:

```bash
./manual-tests/setup.sh edit --fresh
```

Inspect what a run did via the sandbox itself: `git -C manual-tests/runs/edit log --stat`, `docs/DECISIONS.md`, `docs/CHANGELOG.md`, and the transcript under `.copperhead/runs/<ts>/`.
