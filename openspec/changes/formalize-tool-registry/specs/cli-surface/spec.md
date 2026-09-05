# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: `skill` command
The CLI SHALL provide `copperhead skill list` and `copperhead skill run <name>`. `skill list` SHALL print registered skills and whether each would be present in `registry.list(ctx)` for the current repo, make zero LLM calls, make zero network calls, and create no transcript or run directory. `skill run <name>` SHALL invoke that skill's nested sub-run with the same definition the model catalog uses and print the resulting envelope. A missing API key on `skill run` SHALL exit non-zero with a message naming the missing env var and without a stack trace. An unknown skill name SHALL exit non-zero naming the name.

#### Scenario: Help lists skill
- **WHEN** `copperhead --help` is run
- **THEN** the output lists `skill` with a one-line description

#### Scenario: list is LLM-free
- **WHEN** `copperhead skill list` runs on the fixture repo with no API keys in the environment
- **THEN** it exits 0, prints `generate_report`, makes no network calls to any api.* host, and does not create `.copperhead/runs/`

#### Scenario: run generate-report
- **WHEN** `copperhead skill run generate-report` completes with a provider available
- **THEN** stdout contains the report summary and ERC/DRC/drift results, and no new repo file was created solely to hold that report

#### Scenario: run without a key fails clearly
- **WHEN** `copperhead skill run generate-report` is invoked with no model API key and no saved-login provider configured
- **THEN** the process exits non-zero, names the missing env var or login, and prints no stack trace

#### Scenario: unknown skill
- **WHEN** `copperhead skill run does-not-exist` is invoked
- **THEN** the process exits non-zero and the message contains `does-not-exist`
