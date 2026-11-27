## MODIFIED Requirements

### Requirement: Fail-closed capability negotiation
An engine SHALL be eligible for a job only if it supports every hard constraint in scope, the layer count and via types, its license is permitted by runtime policy, its resource needs fit the job limits, and its adapter can losslessly represent the required geometry. An ineligible job SHALL return `UNSUPPORTED`, never a degraded attempt. The layer count SHALL be checked against the manifest's `minLayers` and `maxLayers`, the board's stack and layer count SHALL be handed to every router by the harness (never counted by the adapter), and a result carrying a via whose ends are not the outer layers SHALL be `INVALID_OUTPUT`.

#### Scenario: Unsupported constraint is refused, not approximated (AC-17.4)
- **WHEN** a routing job carries a hard differential-pair constraint and every eligible router's manifest declares `differentialPairs: false`
- **THEN** the run returns `UNSUPPORTED` naming the constraint and no router is invoked

#### Scenario: Layer count gates eligibility both ways
- **WHEN** a six-layer board is routed with `router-reference` (`maxLayers: 2`) and `router-orthoroute` (`minLayers: 4`) registered
- **THEN** the reference router is ineligible with "supports 2 copper layers, board has 6", OrthoRoute is eligible, and the reason is recorded in the run

#### Scenario: Engine via outside the through span is invalid output
- **WHEN** an engine returns a via spanning `In1.Cu` to `In2.Cu`
- **THEN** the invocation is `INVALID_OUTPUT` naming the via's net and no candidate is materialised from it
