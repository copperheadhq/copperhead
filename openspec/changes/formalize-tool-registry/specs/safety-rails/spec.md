# safety-rails — Delta Spec

## ADDED Requirements

### Requirement: Envelope construction is the render redaction boundary
`ToolResult.data` and any other structured envelope field that may hold tool output SHALL be redacted with the same secret patterns as transcripts (including `sk-[A-Za-z0-9_-]+` and the values of environment variables named `*_KEY`, `*_SECRET`, or `*_TOKEN`) at envelope construction, before the envelope is handed to `render.ts`, `dock-renderer.ts`, or `theme.ts`. Those render paths SHALL NOT stringify or print unredacted handler output.

#### Scenario: Key-shaped token never reaches the renderer
- **WHEN** a tool handler's raw output contains a value matching `sk-[A-Za-z0-9_-]{20,}` or an env value of a `*_KEY`/`*_SECRET`/`*_TOKEN` variable
- **THEN** the envelope given to the renderer does not contain that value verbatim, and the on-screen tool line does not contain it

#### Scenario: Transcript still redacts
- **WHEN** the same invocation is recorded on the transcript
- **THEN** the JSONL event is also redacted (AC-4.1 unchanged)

### Requirement: check does not import the capability catalog
The `check`/`verify` command path SHALL NOT import `src/capabilities/` or any module that loads the tool/skill registry. AC-2.1 remains in force: `check` is LLM-free and network-free.

#### Scenario: Module-graph guard
- **WHEN** the static import check scans outward from `src/commands/check.ts`
- **THEN** the graph contains neither `src/capabilities/` nor any provider SDK
