# safety-rails — Delta Spec

## MODIFIED Requirements

### Requirement: Secret hygiene
API keys and credentials (LLM providers, cloud providers, part-data providers, and search providers) SHALL exist only in environment variables or the credential files their own tooling manages; `.env` and `.copperhead/runs/` SHALL be in `.gitignore` from the first commit; transcripts and summaries SHALL redact at write time anything matching `sk-[A-Za-z0-9_-]+`, the configured providers' key formats, Google OAuth access tokens (`ya29.…`) and PEM private-key blocks such as those in a GCP service-account JSON, and the values of any environment variable whose name ends in `_KEY`, `_SECRET`, or `_TOKEN`. Copperhead SHALL NOT read, copy, or log the contents of a credential file it did not create; on the Vertex route the Google credential is held and refreshed by the Google auth library, and copperhead handles only the project and region.

#### Scenario: No keys anywhere (AC-4.1)
- **WHEN** the full test suite has run
- **THEN** no file in the repo tree, transcripts, or any commit matches `sk-[A-Za-z0-9_-]{20,}`

#### Scenario: gitignore from first commit (AC-4.3)
- **WHEN** the repo's first commit is inspected
- **THEN** `.gitignore` already includes `.env` and `.copperhead/runs/`

#### Scenario: Provider keys redacted
- **WHEN** a transcript or summary is written during a run whose environment contains part-data or search API keys
- **THEN** no value of any `*_KEY`, `*_SECRET`, or `*_TOKEN` environment variable appears in the written files

#### Scenario: Google credentials redacted
- **WHEN** a transcript or summary is written during a run whose content includes a `ya29.`-prefixed access token or a PEM private-key block
- **THEN** each is replaced by the redaction marker in the written files

#### Scenario: The Vertex credential is never handled by copperhead
- **WHEN** a Vertex run executes and writes its transcript
- **THEN** no service-account file content or minted access token appears anywhere in the transcript, summary, or run metadata; only the project and region are recorded
