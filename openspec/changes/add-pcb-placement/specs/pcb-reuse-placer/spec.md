# pcb-reuse-placer — Delta Spec

## ADDED Requirements

### Requirement: A reuse run writes RFC 11 records
A reuse run SHALL import the board it places into an RFC 11 layout input
before anything is applied, and SHALL write, beside each option's board, the
placement diff of that option against the layout input (RFC 11 Section 6.11)
as JSON and as the text view of Section 14.4. It SHALL write placement.md
(RFC 11 Section 12.6) once the plan is validated, saying that nothing has
been measured yet, and again when the run ends, replacing the first.
placement.md SHALL be a function of the run's records.

#### Scenario: An option's changes are a placement diff
- **WHEN** `pcb reuse` runs on a board and a reference
- **THEN** each option's directory holds `placement-diff.json` and
  `placement-diff.txt`, and every part the option moved is a row that needs
  approval, since the import owns it

#### Scenario: placement.md before and after
- **WHEN** the plan has been validated
- **THEN** placement.md exists and says nothing has been measured yet
- **AND WHEN** the run ends
- **THEN** placement.md has the six sections of RFC 11 Section 12.6, the
  candidates offered with their ranks, and the selected candidate's diff

### Requirement: One ranking decides
When critical routing re-ranks the candidates, the run's outcome,
`ranking.json`, `outcome.json`, `options.md`, and `--apply` SHALL all follow
the final ranking. The ranking it replaced SHALL be kept as
`ranking-before-critical.json`. By default the critical nets of the top five
candidates SHALL be routed (RFC 15 Section 5.1).

#### Scenario: The selected option is the one applied
- **WHEN** critical routing changes which candidate leads
- **THEN** the printed outcome names the new leader, and `--apply` writes it

### Requirement: Ranking by RFC 15's tiers
Placement candidates SHALL be ranked by the tiers of RFC 15 Section 11.1 in
its order, each metric compared in its own direction and within its own
tolerance, relative for loop area, overflow, and length. A metric a candidate
was not measured on SHALL tie. The weighted score SHALL break final ties, and
each candidate's reason SHALL name what put it ahead of the next.

#### Scenario: Critical routing before loop area
- **WHEN** one candidate routes every critical net and another has a smaller
  loop but routes fewer
- **THEN** the first ranks higher, and its reason names T4 critical routing

#### Scenario: Decoupling before critical routing
- **WHEN** one candidate keeps its decoupling capacitors within their limits
  and another does not but routes more critical nets
- **THEN** the first ranks higher
