# Real designs

Drafting boards nobody wrote for us, and looking at the result next to the drawing a person made of the same circuit.

This is the counterpart to [reference-boards/](../reference-boards/), and the difference is what "correct" means. A reference board's golden is the engine's own pinned output, so a byte diff answers the question completely. Here the golden is a human's schematic, drawn by hand, and the engine places by its own rules. The two sheets never match byte for byte, and a diff of them says nothing at all.

So the comparison splits in two:

- **The netlist is checked by machine.** However differently the two sheets are drawn, they must join the same pins into the same nets. Every net that the source had and the draft lost, or that the draft invented, is reported.
- **The drawing is checked by eye.** Two PNGs, the person's and the engine's, of the same circuit. This is where you find out whether the output reads like a schematic or merely is one.

The designs are read from a local KiCad install at run time and the sweep's outputs land in `manual-tests/runs/` (gitignored). What IS committed lives in [examples/](examples/): the side-by-side output for boards that draft cleanly and whose licences permit redistribution, each with its licence file beside it. Boards whose licences do not permit it stay run-only; `stickhub`, for instance, is CC BY-NC-SA.

## Running it

```bash
npm run realdesigns                 # every project in the corpus
npm run realdesigns -- stickhub     # one project
COPPERHEAD_CORPUS_DIR=/path/to/projects npm run realdesigns
```

The corpus defaults to `/usr/share/kicad/demos`, which ships with KiCad and holds fifteen real projects ranging from a fifteen-part valve amplifier to a 1500-part VME board. Point `COPPERHEAD_CORPUS_DIR` at any directory of KiCad projects to use your own.

Requires `kicad-cli`. PNG rendering additionally needs ImageMagick `convert` and is best effort: some of the larger sheets defeat its default resource limits, and when that happens the schematic and netlists are still written, with a note in the output.

## What each project leaves behind

```
manual-tests/runs/real-designs/<project>/
  source.net                 netlist exported from the real project
  schematic.intent.json      the IR extracted from it
  drawn/board.kicad_sch      what the engine drafted
  back.net                   netlist exported back from the drafted sheet
  render/original*.png       the human's drawing, one PNG per sheet
  render/drawn.png           the engine's drawing
  REPORT.md                  outcome, net comparison, refusal reasons
```

Open `REPORT.md` first; it names which of the two outcomes you got and points at the renders. A refused board still gets its original render and the full finding list, so the boards the engine declines are inspectable too.

## Where the IR comes from

The input is `kicad-cli sch export netlist`, not the `.kicad_sch`. That makes KiCad flatten the hierarchy, resolve the buses, and name every net before we see it, including the ones the designer never named (`Net-(D15-1)`). Reading the schematic directly would mean re-deriving connectivity, and unnamed nets are the majority on a real board: `interf_u` has 303 of its 373 pins on nets carrying no label.

`libsource` supplies each part's lib_id and `sheetpath` supplies its group, so the extraction is deterministic with no LLM involved. The reader lives in [test/support/netlist.ts](../../test/support/netlist.ts), shared with the automated sweep so the two cannot drift.

## The automated half

`test/draft-real-corpus.test.ts` runs the same round trip as an assertion, gated on `COPPERHEAD_TEST_CORPUS=1` and skipped when no corpus is present:

```bash
COPPERHEAD_TEST_CORPUS=1 npx vitest run test/draft-real-corpus.test.ts
```

Its contract is deliberately not "every board drafts". Most real boards legitimately will not, because the engine refuses multi-unit symbols by design. The contract is the weaker and more important one: **draft faithfully or refuse legibly, never silently wrong.** A drafted sheet must partition pins exactly as the source did; a refusal must carry an attributable finding.

That test tells you whether anything broke. This directory is for looking at what the engine actually drew.

## What the corpus has found so far

Against KiCad 10.0.4's demos, eleven of fifteen boards draft with connectivity exact (the remaining four were still sweeping when this was written). Each class of refusal, once understood, became an engine or harness change:

- **Multi-unit symbols** blocked seven of fifteen projects (opamps, gate packs, multi-gang jumpers), and in all seven it was the *only* refusal (#218). The engine now places each unit as its own instance, which cleared the whole set.
- **Symbol resolution** blocked five, all boards drawn against private libraries that were never published. The harness now rebuilds those libraries from the copies every sheet embeds in its `lib_symbols` section ([test/support/embedded-libs.ts](../../test/support/embedded-libs.ts)), so they resolve without being installed; `royalblue54L_feather` and `cm5_minima` draft cleanly because of it.
- **Merged nets at routing** blocked two, `cm5_minima` (+5V shorted to GND) and `interf_u` (/PC-RD to /WR_REG), until #217. Both now draft with connectivity exact.

And the finding that only the renders could have surfaced: **the three boards that draft are correct and unreadable** (#219). All three score a composite of 40 against 85.6 to 92 for the committed reference boards, and `stickhub` carries 367 out-of-frame findings, meaning content placed outside the drawing frame. Its 94 parts come out as one horizontal ribbon on an A0 sheet that is roughly 85% empty, where the designer drew the same circuit densely on A3.

This is the reason the directory exists. The automated sweep passes all three, correctly: its contract is draft faithfully or refuse legibly, and faithfulness is not legibility. Only the side-by-side shows it.
