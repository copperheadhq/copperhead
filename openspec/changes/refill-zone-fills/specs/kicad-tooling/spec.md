# kicad-tooling delta spec

## ADDED Requirements

### Requirement: Zone fill refresh

The system SHALL compute copper zone fills with KiCad's own zone filler on a scratch copy of the board, placed beside copies of the project's `.kicad_pro` and `.kicad_dru` under the board's name so net-class clearances and custom rules apply, and SHALL return the board text with only fill data changed: each zone's `filled_polygon`/`fill_segments` blocks are replaced by the refilled ones, matched by the zone's uuid (or tstamp), the zone is marked filled, and a zone written in a pre-KiCad 10 format without `(filled_areas_thickness no)` gains it so KiCad does not read the new fill as a legacy one. A zone with no uuid or tstamp, or one whose id repeats an earlier zone's, SHALL first receive a deterministic uuid derived from its own text, so KiCad keeps it and the splice can match it, and so SHALL a footprint that holds a zone and has no id or repeats an earlier footprint's; that is the only change allowed outside fill data. Every other byte of the board SHALL be unchanged, including its format version, generator and indentation style. The refresh SHALL NOT write the design file; callers decide whether to. Before returning a changed board, it SHALL have kicad-cli load and save the spliced text without refilling (`pcb upgrade --force`) and refuse, naming each zone, when any copper zone's fill flag or fill data as KiCad wrote it back differs from the refilled copy's. Where kicad-cli has no `pcb upgrade --force`, it SHALL instead run DRC on the spliced text beside the same project copies and refuse, naming the difference, when that DRC reports more violations of any type, or more unconnected items, than KiCad's DRC of the refilled copy. A copper zone the refilled copy no longer contains SHALL make the refresh fail naming that zone; a rule area, which holds no fill, needs no match. A board that stores teardrops as zones SHALL NOT be refilled: KiCad's refill regenerates teardrops while the board keeps its own, so the refresh SHALL fail as refill-unavailable, saying why, without running a refill. A board with no copper zones SHALL be returned unchanged without invoking kicad-cli.

#### Scenario: First fill of an unfilled pour (AC-22.1)

- **WHEN** the refresh runs on a KiCad 8-format board whose GND zones on F.Cu and B.Cu have outlines but no fill
- **THEN** the returned text has fill data in both zones and both are marked filled, the text outside those zones is byte-identical to the input (the `(version 20240108)` header included), and the board file on disk is unchanged

#### Scenario: Fills honor the project's rules (AC-22.2)

- **WHEN** the project's `.kicad_pro` sets a 0.8 mm default clearance and the refresh runs
- **THEN** a plain DRC of the refreshed board in place, beside that project file, reports no clearance violation involving a zone

#### Scenario: A hand-written zone is filled at its real thickness (AC-22.3)

- **WHEN** a KiCad 8-format zone written without `(filled_areas_thickness no)` is refreshed
- **THEN** the zone gains `(filled_areas_thickness no)` and a plain DRC in place reports no clearance violation involving it

#### Scenario: Refresh is stable (AC-22.4)

- **WHEN** the refresh runs on its own output with the same kicad-cli
- **THEN** it reports no change and returns byte-identical text

#### Scenario: A zone written without an id (AC-22.5)

- **WHEN** a zone with no uuid is refreshed twice
- **THEN** both refreshes give it the same uuid and fill data, and the second reports no change
- **WHEN** a pour sits inside a footprint that has no uuid
- **THEN** the footprint gets a deterministic uuid, the pour is refreshed, and a second refresh reports no change

#### Scenario: A splice KiCad reads back differently is refused (AC-22.6)

- **WHEN** KiCad, loading the spliced board, reads a zone's fill differently from the fill it computed, as it does for a KiCad 8-format zone left without `(filled_areas_thickness no)`
- **THEN** the refresh fails with a message naming that zone and returns no text
- **WHEN** the board stores teardrops as zones
- **THEN** the refresh fails as refill-unavailable, saying that the board stores its teardrops as zones, and runs no refill

#### Scenario: Older kicad-cli (AC-22.7)

- **WHEN** `kicad-cli pcb drc --help` does not list both `--refill-zones` and `--save-board`
- **THEN** the refresh reports that zone refill is unavailable with this kicad-cli, and no refill is attempted
