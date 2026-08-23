# Golden corpus provenance

- Tier A `legibility-clean`: authored in-repo for this suite (Apache-2.0, this repository); a minimal well-drafted two-group sheet.
- Tier A `open-key`: the repo's own hand-drawn open-key fixture project (Apache-2.0, this repository).
- Tier B `ugly`: authored in-repo; a deliberately illegible sheet exercising every check family, modeled on the failures reported in issue #136.
- Tier C `board`: drafted by the engine from `test/fixtures/draft/schematic.intent.json` against the in-repo fixture symbol libraries (`test/fixtures/symlib/`).

Regenerate pins with `COPPERHEAD_UPDATE_GOLDENS=1 npm test`; the resulting diff is the review artifact. Never edit goldens by hand.
