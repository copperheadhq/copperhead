## Context

The pack format belongs to copperhead-tools and RFC 4 Section 6.3; the intake never imports the tools.
It writes YAML the tools validate, and a person confirms before any tool uses it.

## Decisions

### D1. Admitted readings only

A pack fact comes only from a reading the validators admitted: its value is on the cited line, its unit
present, its qualifier placed. Held and rejected readings are counted, never drafted.

Alternative considered: drafting held readings for the person to check. A draft is already checked by
a person, but a held value invites being confirmed by habit.

### D2. One fact per row

The MIN, TYP and MAX an extractor took from one line become one fact quoting that line, so a person
checks one quote per fact and the tools see one bounded parameter.

### D3. Family datasheets

A line that names part numbers sharing the part's stem (letters and first three digits) and none that
the part number or an alias begins with belongs to another variant and is left out, with a note.

Alternative considered: asking the extractor for the variant. A filter on the verified line text is
deterministic and checkable; the extractor's answer is not.

### D4. Confirmation re-verifies every quote

`confirm-pack` checks every quote in the pack, including those a person added or edited, against the
document's text before writing a name. A typo in a quote stops confirmation as surely as a model's
invention would.

## Risks / Trade-offs

- Evidence units are lines: a quote may be a value fragment ("- 22 — uA") whose parameter name sits on
  the line above. The person sees the page and checks the meaning.
