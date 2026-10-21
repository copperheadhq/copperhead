# electrical-diff — Delta Spec

## ADDED Requirements

### Requirement: Normalized electrical comparison ignores layout-only edits

`diffSnapshots` SHALL compare components, pin connections on surviving components, nets (renames, merges, additions, removals), and affected constraints while ignoring symbol coordinate, rotation, and UUID changes.

#### Scenario: Coordinate-only schematic edit reports no electrical changes

- **WHEN** a symbol's xy coordinates, rotation, or UUID change without altering component values, footprints, or pin-to-net connectivity
- **THEN** `diffSnapshots` returns `hasChanges: false`

#### Scenario: Surviving-component pin rewiring and net rename detection

- **WHEN** a net is renamed and a new component is simultaneously attached to the renamed net
- **THEN** `diffSnapshots` reports the net under `nets.renamed`, lists the new component's nets under `components.added`, and does not duplicate the added component's pins under `connections.changes`
