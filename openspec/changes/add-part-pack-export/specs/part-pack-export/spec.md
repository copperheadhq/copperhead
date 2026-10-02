## ADDED Requirements

### Requirement: Drafting a pack

The intake SHALL draft a part pack (part-packs v1) from a datasheet's extraction records: version 1;
the part number, manufacturer, aliases and topology; the source document's title, revision and
sha256; the extractor and date; and one fact per parameter and evidence unit from admitted,
non-duplicate readings, with the MIN, TYP (or NOM) and MAX values as quantities with units the tools
parse, the conditions, the page, and the unit's normalised text as the quote. The draft SHALL carry no
`confirmedBy`. Its header comments SHALL say it is unconfirmed and count held, rejected and unmapped
extractions and the parameters not found.

#### Scenario: A feedback-voltage row

- **WHEN** the extractor admits 0.588, 0.6 and 0.612 V as MIN, TYP and MAX from one line on page 5
- **THEN** the draft holds one feedback-voltage fact with those bounds, page 5 and that line as quote

#### Scenario: A value not on its line

- **WHEN** an extraction's value is not on the line it cites
- **THEN** it is not in the draft and the header counts it as held or rejected

### Requirement: Sibling variants

A reading whose line names part numbers sharing the part's stem and none matching the part number or an
alias SHALL be left out of the draft, and the draft's header SHALL name those variants.

#### Scenario: A four-variant family datasheet

- **WHEN** an AP63205 pack is drafted from the AP63200/01/03/05 datasheet
- **THEN** the AP63203's output voltage and the AP63200/01's feedback voltage are left out

### Requirement: Confirming a pack

Confirmation SHALL refuse a pack whose source sha256 differs from the given document, SHALL check every
quote of the pack's facts, typical circuit, layout guidance and pin table against the document's text
of its page after normalisation, SHALL refuse with every failing quote listed when any is not found,
and only otherwise SHALL write `confirmedBy` with the given name.

#### Scenario: An altered quote

- **WHEN** one quote of a draft is changed from what the page prints
- **THEN** confirmation refuses and names that entry and page
