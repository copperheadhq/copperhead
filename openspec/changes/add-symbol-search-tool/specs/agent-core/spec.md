# agent-core — Delta Spec

## ADDED Requirements

### Requirement: `search_symbols` tool

The tool list SHALL include `search_symbols`, available in the same phase as `verify_symbols` and requiring no unlock, since it only reads installed libraries and mutates nothing. It SHALL take one required argument, `query`: a part or symbol name such as `TLV320AIC3204` or `AudioJack3`.

It SHALL search every `.kicad_sym` library found in the symbol search directories (the `KICAD*_SYMBOL_DIR` overrides exclusively when set, otherwise the standard install locations) and return matching identifiers as `Lib:Name` lib_ids, directly usable as a schematic `lib_id`. Matching SHALL be case-insensitive and separator-insensitive (`_`, `-`, `.` ignored), so `Rotary_Encoder` finds `RotaryEncoder_Switch`. Candidates from all libraries SHALL be ranked together — exact matches, then prefix, then substring, then single-edit family variants (`SHT40` finds `SHT4x`; a digit-for-digit substitution such as `TPS22860` vs `TPS22810` is never a match, since that names a different real part) — before any result cap applies, so a strong match in a late-scanned library is never displaced by weak matches from earlier ones. Sub-unit child symbols (`Name_<unit>_<style>`) are internal structure and SHALL NOT be returned.

When no library directory exists on the machine, and when no symbol matches, the tool SHALL say so plainly and state that the part is not capturable as named, rather than failing.

#### Scenario: Part filed under an underivable nickname

- **WHEN** the agent calls `search_symbols` with `TPS61165` and the part is installed in `Driver_LED`
- **THEN** the result lists `Driver_LED:TPS61165DBV`, so the agent can use the lib_id without having guessed the library

#### Scenario: Ranking beats scan order

- **WHEN** an early-scanned library holds only a weak match and a later library holds a stronger one
- **THEN** the stronger match is ordered first and survives a small result cap

#### Scenario: Genuinely absent part

- **WHEN** no installed library holds any match for the query
- **THEN** the result states that no installed symbol matches, names the directories searched, and says the part must be substituted

## MODIFIED Requirements

### Requirement: Stage recovery diagnosis

When a stage fails or ends without meeting its completion contract, the pipeline MAY ask the model whether another automated attempt is worthwhile. The diagnosis turn is tool-less, its result is parsed as JSON, and any error or ambiguity SHALL resolve to `abort`, so recovery fails safe toward reporting to a human rather than looping.

Before that turn runs, every lib_id named in the failure text and the transcript excerpt SHALL be deterministically re-probed against the installed libraries, and the results SHALL be supplied to the diagnosis as machine-verified facts that override the transcript's claims about symbol or library availability. The diagnosis SHALL be instructed that an agent's claim that a symbol or library is absent is not evidence: an agent dead-ended by wrong library nicknames routinely concludes whole libraries are missing, and a refusal whose premise the facts contradict is retryable, with the correct lib_ids in the guidance.

Identifier extraction SHALL accept the separators a `.kicad_sym` filename stem allows in a library nickname (`_`, `-`, `.`), since a truncated nickname is probed as the wrong lib_id and reported absent — the precise false negative the fact block exists to prevent. Probing SHALL be capped so a probe-heavy transcript stays cheap, and the block SHALL state its own coverage: lib_ids past the cap are named as not re-probed, and the diagnosis is told that an unprobed or unlisted identifier is unknown, never confirmed absent.

Probing SHALL NOT throw: an unreadable library, an absent search directory, or a probe error SHALL degrade to reporting whatever was established, up to and including an empty fact block, and SHALL NOT prevent the diagnosis from running.

#### Scenario: False absence claim is contradicted

- **WHEN** a stage refuses because it believes `Audio:TLV320AIC23BPW` does not exist, and that lib_id resolves on this machine
- **THEN** the diagnosis receives a fact line stating it RESOLVES, and the refusal's premise is contradicted before the verdict is formed

#### Scenario: Part installed under another library

- **WHEN** a refusal names a lib_id whose library nickname is wrong but whose part is installed elsewhere
- **THEN** the fact block reports where it is actually installed, so retry guidance can quote the correct lib_id

#### Scenario: Coverage is stated, not implied

- **WHEN** the failure text names more lib_ids than the probe cap allows
- **THEN** the fact block names the unprobed identifiers and states the limit, so the diagnosis cannot read absence of a line as absence of the symbol

#### Scenario: Non-lib_id tokens are not probed

- **WHEN** the text contains file:line references, timestamps, or engine-generated power symbols
- **THEN** they are excluded from probing and produce no fact lines
