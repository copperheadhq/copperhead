# add-explain-command: Proposal

## Why

The CLI surface lists `copperhead explain <refdes|net|pin>` as a stretch command, and discussion #97 asked for a first version that is a deterministic schematic lookup: which pins sit on a net, which net a pin is on, what value and footprint a part carries. Today that answer is a raw KiCad s-expression, or a tour through `/parts` and `/nets` in the REPL. A dedicated command makes the same read-only parse the `init` path already trusts available from the shell and from `--json`.

## What Changes

- **New command: `copperhead explain <query>`**, LLM-free and network-free:
  - A refdes (`U1`) prints value, footprint, library id, sheet, and every pin with its net.
  - A net (`GND`, `KEY_DAH`) prints the attached pins.
  - A pin (`U1.GPIO14` or `R2.1`) prints the connected net. A pin name that belongs to exactly one part (`GPIO14`) resolves without a refdes.
  - Matching rows from `BOM.md` / `PINOUT.md` and other doc mentions are included when those files exist.
  - Unknown queries exit 1 and suggest nearby refdes and net names.
  - `--json` emits `{ ok, hit }` or `{ ok: false, error, suggestions }`.
- **REPL: `/explain <query>`** runs the same lookup. Inspect-only: no LLM, no writes.
- No agent-loop, provider, or KiCad-write changes. The sexp reader stays read-only.

## Capabilities

### New Capabilities

- `explain-lookup`: query grammar (refdes / net / pin), resolution order, suggestion behavior, JSON hit shape, and the guarantee that the command is LLM-free and network-free.

### Modified Capabilities

- `cli-surface`: the CLI gains `explain`; the REPL gains `/explain`.

## Impact

- **Code**: new `src/commands/explain.ts`; CLI and REPL wiring; tests against the open-key fixture.
- **Specs**: SPEC.md CLI section (the stretch line becomes a real command) plus this change.
- **Tests**: offline fixture lookups (part, net, pin, unique pin name, miss-with-suggestion) and a CLI `--json` contract test. No API key, no `kicad-cli` required.
- **Unchanged contracts**: `check` / `do` / `create` behavior is untouched. The sexp parser still never serializes.
