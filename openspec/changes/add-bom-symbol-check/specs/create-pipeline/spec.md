# create-pipeline — Delta Spec

## MODIFIED Requirements

### Requirement: Stage 3 availability probing

The part-selection prompt SHALL require the agent to probe availability with `search_symbols` for every active part (IC, module, connector) before the BOM commits, to confirm drawability with `symbol_pins` on the chosen symbol (substituting when it reports more than one unit), and to run `check_bom_symbols` across `docs/BOM.md` before finishing stage 3 so any remaining missing or incomplete symbol row is caught in one pass alongside `check_footprints`.

#### Scenario: Batch BOM symbol check before stage-3 completion

- **WHEN** stage 3 has populated `docs/BOM.md`
- **THEN** the stage-3 prompt directs the agent to run `check_bom_symbols` before calling `finish`, substituting any part flagged with `NO INSTALLED SYMBOL` or `MULTI-UNIT`
