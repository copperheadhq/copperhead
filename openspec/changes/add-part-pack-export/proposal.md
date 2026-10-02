## Why

copperhead-tools now reviews regulators and decoupling against part packs (Copperhead RFC 4 Section
6.3): one YAML file per part number holding what its datasheet says, every entry cited by page and
verbatim quote, used only once a named person has confirmed it. Today a person types each pack from
the datasheet. The intake already reads datasheets and admits only readings whose value is on the
cited line; it can draft the facts of a pack, leaving the person to check, complete and confirm.

## What Changes

- Regulator field requests (`core/fields.ts` `PACK_FIELD_SPECS`): the supply range, quiescent current
  and absolute maximum input of the default set, plus feedback voltage, fixed output voltage, rated
  output current, current limit, switching frequency, dropout voltage, enable threshold and maximum
  junction temperature.
- `core/pack.ts` (pure): admitted, non-duplicate readings become pack facts, one per evidence unit
  and parameter with its MIN, TYP (or NOM) and MAX, the unit spelled as the tools parse it, the
  conditions, the page and the unit's text as the quote. A reading whose line names a sibling variant
  of a family datasheet and not this part (`AP63203` for an `AP63205`) is left out, and so is every
  held, rejected or unmapped reading; the draft's header comments count them and name the parameters
  not found. `verifyQuotes` checks that each quote is on its page after the intake's normalisation.
- `scripts/pack.ts`: drafts a pack from a PDF through the production intake (cached, or `--live`),
  with no `confirmedBy`, so the tools list it as a draft and never use it.
- `scripts/confirm-pack.ts`: re-reads the datasheet's text (the intake's cache, else the text layer),
  checks every quote in the pack (facts, typical circuit, layout guidance, the pin table) against its
  page, refuses a pack citing another document, and only then writes `confirmedBy`.
- Dependency: `yaml` (the format's library in copperhead-tools), for the scripts only.

## Capabilities

### New Capabilities

- `part-pack-export`: pack field requests, drafting, sibling-variant filtering, quote verification,
  and confirmation.

### Modified Capabilities

None.

## Impact

- `intake/core/fields.ts`, `intake/core/pack.ts`, `intake/scripts/pack.ts`,
  `intake/scripts/confirm-pack.ts`, `intake/test/pack.test.ts`, `intake/package.json`.
- First live run (AP63205, a four-variant family datasheet, Claude Code extractor): 27 extractions,
  24 admitted, 8 facts after leaving out the other variants; every fact agrees with a hand-written
  pack for the same part; confirmation passes, and fails when one quote is altered.
- Not in scope: extracting pin tables, typical-circuit requirements and layout guidance (the person
  adds them; `add-layout-guidance-intake` covers layout), thermal resistance (no unit family for
  degC/W yet), and publishing packs.
