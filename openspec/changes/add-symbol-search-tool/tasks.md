# add-symbol-search-tool: Tasks

## 1. Cross-library symbol search

- [x] 1.1 Extract the candidate ranking into `rankSymbolNames` (name + rank), shared by `closestSymbolNames` and the cross-library search; separator- and case-insensitive, sub-unit children excluded, 3-significant-char floor on the name-inside-query direction
- [x] 1.2 Add `listInstalledLibraries`: every `<lib>.kicad_sym` across the search dirs, first dir claims a nickname (matching `findLibraryFile` precedence)
- [x] 1.3 Add `searchInstalledSymbols`: rank candidates from all libraries together, then apply the result cap, so a late library's stronger match is never displaced by earlier weak ones
- [x] 1.4 Tests: part found under an underivable nickname, genuinely absent part returns nothing, global rank ordering survives a cap of 1

## 2. `search_symbols` agent tool

- [x] 2.1 Add the tool schema and handler to `src/agent/tools.ts`, `requiresUnlock: false`, with a description naming the underivable-nickname failure mode
- [x] 2.2 Graceful messages when no symbol directory exists and when nothing matches, each stating the part is not capturable as named

## 3. Stage 3 availability requirement

- [x] 3.1 Extend the stage-3 prompt to require `search_symbols` for every active part before the BOM commits, preserving the existing per-refdes and value-column constraints
- [x] 3.2 Leave stage 3's completion gate unchanged, and record why in the delta spec (fuzzy MPN-to-symbol matching would refuse valid BOMs)

## 4. Fact-checked recovery diagnosis

- [x] 4.1 Add `symbolAvailabilityFacts`: extract lib_ids from failure text and transcript excerpt, re-probe each against the installed libraries, report resolution or where the part actually lives
- [x] 4.2 Accept `-` and `.` in library nicknames (interior only), keeping the letters-on-both-sides filter that drops file:line refs and timestamps
- [x] 4.3 Report probe coverage: name the lib_ids past the cap as not re-probed instead of omitting them silently
- [x] 4.4 Inject the block into the diagnosis prompt as ground truth, instructing that an agent's absence claim is not evidence and that an unprobed or unlisted identifier is unknown, not absent
- [x] 4.5 Never throw: probe errors, unreadable libraries and absent search dirs degrade to a partial or empty block
- [x] 4.6 Tests: false absence contradicted, part located in another library, separator-bearing nickname probed, cap disclosure, non-lib_id tokens excluded
