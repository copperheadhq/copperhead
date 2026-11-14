# add-grounded-review: Proposal

## Why

A design review a model writes on its own cannot be trusted line by line. On a 90-part, four-layer
board, a model-only review found real defects the deterministic checks could not (a sensor strap
fighting an internal pull-up, a card socket rotated so no card fits, a part number that orders the
wrong resistor), and in the same document presented four paraphrases as datasheet quotations, cited
one part's guidance from another part's datasheet, and labelled its own findings "Verified". Nothing
in its record let a reader tell a quoted limit from a remembered one, or rerun it and get the same
claims. The deterministic tools, run alone on the same board, found none of those defects, and
skipped the Gerbers, BOM and placement files entirely because they were never given them.

RFC 17 sets the division of labour: the model proposes in forms a deterministic verifier can check,
the verifier decides, and the report presents only what was decided. copperhead-tools now carries the
deterministic half (`review`, `review-bundle`, `review-query`, `review-verify`). This change adds the
half that calls a model.

## What Changes

- **New command: `copperhead review [design]`**, experimental. It never writes the design.
  1. **Sweep**: copperhead-tools `review` over the design and, with `--fab`, its fabrication outputs
     (Gerber and drill sets, BOM and placement files; `--fab-profile` for the manufacturer's limits),
     so parts, netlist, placement, routing and Gerbers are all examined by every applicable
     deterministic check before a model runs.
  2. **Bundle**: copperhead-tools `review-bundle`, the closed context: design, board, sweep and every
     retained source (`--source`; the fabrication files are added) by hash.
  3. **Passes**: one model pass per domain (power, MCU, storage and I/O, firmware, physical, routing,
     fabrication outputs, BOM), run `--parallel` at a time. A pass reads the bundle only through
     read-only queries (parts, nets, pins, the sweep and what it did not examine, source search and
     pages, board, placement and routing, measurements, calculations), proposes facts, citations,
     measurements, calculations, findings and questions, and sees each proposal's verification
     outcome as it proposes. It ends on `submit`, or on its turn or time budget.
  4. **Verify**: copperhead-tools `review-verify` over every pass's proposals; the report is the one
     it renders from the verification record.
  5. **Record**: `--out` (new, outside the design) holds the sweep, the bundle, every pass's sample
     (saved after every turn, so a killed pass leaves its work), the merged proposals, the
     verifications, the report and a lockfile with the model, template hashes, bundle, proposals and
     report hashes.
- **`copperhead review --replay <record>`** re-verifies the stored proposals with no model and
  succeeds only when the report is byte-identical to the recorded one.
- **Text tool protocol**: a call whose arguments are written as `arguments`, `parameters`, `input`,
  or flat beside `tool` is read as written. Reading only `args` made such calls empty, and a model
  told an argument was missing from a call it believed complete concluded the tool was broken.

## Not in scope

- Catalogued inference rules, multiple samples per pass and stability, confirmation records and
  write-back (RFC 17 Sections 4.5, 6.2, 11): a finding is presented as INFERRED with confidence at
  most 0.6.
- A persistent query session, and parallel passes sharing one provider session.
- Running inside `create`, or gating anything on the review's result.
