# claude-code-provider delta spec

## ADDED Requirements

### Requirement: Cached input tokens are reported

The `claude-code` provider SHALL report input usage as the sum of uncached input tokens, cache-read tokens and cache-creation tokens from the SDK's result usage, so the run's token totals and the create cost table reflect the context actually processed. A result that reports no cache fields SHALL be counted from its uncached input tokens alone.

#### Scenario: Cache reads counted (AC-18.4)

- **WHEN** a turn's result usage reports `input_tokens: 2`, `cache_read_input_tokens: 41000` and `cache_creation_input_tokens: 1500`
- **THEN** the turn's reported input tokens are 42502

#### Scenario: No cache fields (AC-18.5)

- **WHEN** a turn's result usage reports only `input_tokens: 900`
- **THEN** the turn's reported input tokens are 900
