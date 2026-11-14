# agent-core — Delta Spec

## ADDED Requirements

### Requirement: `symbol_pins` tool

The tool list SHALL include `symbol_pins`, available in the same phase as `search_symbols` and requiring no unlock, since it only reads installed libraries and mutates nothing. It SHALL take one required argument, `lib_id`: a full library identifier such as `Device:R` or `Audio:TLV320AIC3100`.

When the lib_id resolves, the result SHALL list the real pins — number, name, and electrical type — read from the installed `.kicad_sym`, following `extends` links so derived symbols report their base's pins. The result SHALL state the symbol's unit count, and when the symbol defines more than one unit it SHALL warn that the drafting engine refuses multi-unit symbols, so the caller substitutes before the choice hardens into the BOM or the IR.

When the exact symbol is absent from the named library, the result SHALL offer the closest names within that library and the cross-library matches for the symbol name, so a wrong-nickname guess is answered with the correct lib_id rather than a dead end. When the library nickname itself is not installed, the result SHALL say so and offer cross-library matches. When no symbol-library directory exists on the machine at all, the result SHALL state that the lib_id cannot be verified — nothing was resolved and nothing was ruled out — and direct the caller to install the KiCad symbol libraries or choose a part verifiable another way. No outcome is an error: every miss names what was searched and what to do next.

#### Scenario: Resolved symbol reports its pins

- **WHEN** the agent calls `symbol_pins` with `Device:R`
- **THEN** the result lists pin 1 and pin 2 with their electrical type, and states the symbol is single-unit

#### Scenario: Derived symbol inherits base pins

- **WHEN** the agent calls `symbol_pins` with a lib_id whose symbol `extends` a base
- **THEN** the result lists the base's pins, since that is what the engine will draw

#### Scenario: Multi-unit symbol is warned about

- **WHEN** the lib_id resolves to a symbol defining more than one unit (a gate pack, a dual opamp)
- **THEN** the result names the unit count and warns that the drafting engine refuses multi-unit symbols

#### Scenario: Wrong library nickname is redirected

- **WHEN** the lib_id's library is installed but the symbol name is not in it, and the symbol exists in another installed library
- **THEN** the result offers the cross-library lib_ids where the symbol actually lives, plus the guessed library's closest names whenever it has any (a resolver that already ruled the guessed library out has none to offer)
