# agent-core — Delta Spec

## MODIFIED Requirements

### Requirement: Transcript events are bounded at write time

`Transcript.event()` SHALL enforce a maximum serialized size on every event it writes, at the same call that applies write-time redaction, so the size bound and AC-4.1 are enforced in one place and cannot diverge as callers are added.

The bound SHALL be 131072 bytes (128 KiB), expressed as a named constant rather than a literal, since the hosted activity log's inline payload limit has to agree with it. Redaction SHALL be applied before the bound is evaluated, so a truncation boundary can never split a secret into an unmatchable fragment.

An event exceeding the bound SHALL be written with its payload replaced by a truncation marker recording the original byte count. It SHALL NOT be dropped: the transcript is an audit trail and a resume input, so an absent event is a silent hole in both. The marker is the local form of the hosted `ArtifactRef` spill, so the hosted path adds a location to the same shape rather than introducing a second one.

#### Scenario: An oversized event is truncated, not dropped

- **WHEN** a tool result large enough to exceed the bound is passed to `event()`
- **THEN** the transcript gains one line for that event, its payload replaced by a marker naming the original byte count, and the run continues

#### Scenario: Ordinary events are untouched

- **WHEN** an event of typical size is written (measured traffic: median 337 bytes, p99 18042, maximum observed 60981)
- **THEN** it is written whole, since the bound sits at roughly twice the largest event observed in real runs

#### Scenario: A secret spanning the boundary is still redacted

- **WHEN** an event carries a credential positioned so that truncation would fall inside it
- **THEN** redaction has already replaced the credential before the bound is evaluated, so no fragment of it reaches the transcript

### Requirement: Write-time redaction covers storage credentials

The redaction patterns applied at transcript and summary write time (AC-4.1) SHALL include a shared access signature alongside the existing model, registry and forge credential patterns.

This is load-bearing rather than defensive: the transcript is itself an artifact the hosted path uploads, so an unredacted signature becomes a live download credential stored inside a downloadable object. A signature is a query string whose secret is its `sig=` value and matches none of the seven existing patterns.

Git credentials are already covered and SHALL remain so: a GitHub App installation token is `ghs_`, which the existing `gh[pousr]_` pattern matches, including when embedded in an `x-access-token:...@github.com` clone URL.

Each credential shape SHALL be covered by its own test case, so a future storage backend with a differently shaped credential fails a test rather than a transcript.

#### Scenario: A signature in a transcript is redacted

- **WHEN** an event or summary contains a URL carrying a shared access signature
- **THEN** the signature is replaced before the line is written, and the artifact that transcript becomes carries no usable credential

#### Scenario: An installation token in a clone URL is redacted

- **WHEN** writeback output quoting `https://x-access-token:<token>@github.com/...` reaches a transcript
- **THEN** the token is replaced by the existing forge pattern, with no new pattern required
