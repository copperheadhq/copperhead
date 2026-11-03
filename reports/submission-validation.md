# Combined local submission validation

Base: `e26be947ed31a35fbbb52623174bb25017d6cd44`. Local review branch: `fix/create-completion-evidence`. This combines the eight public fixes, the immutable recorded-response integration increment, and the coherent OpenSpec change `fix-create-stage-evidence`. It excludes the experimental runtime adapter.

## Actual final commands

| Command | Actual result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm run build` | Pass |
| `npm test` | 1296 passed, 0 failed, 23 skipped; 53.10 seconds |
| `node scripts/run-recorded-create-e2e.mjs` | 5 passed, exit 0, 73.45 seconds; no timeout |
| `npm run lint` | Pass; Markdown rules unchanged |
| `openspec validate fix-create-stage-evidence --type change --strict --no-interactive --json` | Official CLI 1.14.1: one valid change, zero issues |
| `git diff --check` | Pass |

These are separate invocations, not additive test counts. The replay job includes three checks also present in the default suite. The environment was Node 24.19.0 and KiCad 9.0.2 with the installed symbol/footprint libraries and a configured table. No model request, new credential or paid API was used by these checks. A remote GitHub CI result is not claimed.

## Exact default-suite skip categories

- 19 in `test/agent-integration.test.ts`: six configured live-provider families each have net-rename, budget-refusal and forced-rollback tests, plus one live-run secret-leak check. The required credentials or explicit saved-login/endpoint opt-ins were not supplied.
- 1 in `test/draft-real-corpus.test.ts`: the optional external corpus job was not enabled with an available corpus.
- 1 in `test/claude-code-provider.test.ts`: the SDK-absent error-message case is inapplicable because the optional Claude Code SDK is installed.
- 2 full replay cases in `test/create-recorded-e2e.test.ts`: intentionally gated in the default suite, both actually passed within the separate five-case recorded replay command.

A skip is not a failure, but the 19 skipped live-provider tests are not proved by replay. The new integration uses sequential recorded responses and newly executed tools/gates, not fresh inference or exact historical request/cache-key equality.

## Reviewable requirement evidence

- [OpenSpec validation scope and historical warnings](../openspec/changes/fix-create-stage-evidence/validation.md)
- [Actual manual edit-sandbox commands and limitations](manual-test-log.md)
- [Direct evidence for the seven invariants](invariant-evidence.md)
- [Prepared-environment recorded integration command and negative controls](create-recorded-e2e.md)
- [Recorded integration results](create-recorded-e2e-results.md)

The independent original 500 mA experiment reached eight stages across resumed live attempts and retained its raw DRC/physical qualification limitations. The new replay starts from blank initialization and verifies eight newly committed stages; it does not change what the live experiment or hardware evidence establishes.

## Validation limits

The documented KiCad 9 job has been run locally; KiCad 10 remote CI and live-provider parity remain unverified. Historical OpenSpec strict warnings and absent canonical capability targets remain disclosed, not silently repaired or archived.

The manual sandbox was exercised and logged; the optional model-backed do command was not rerun. No claim of that command, factory acceptance, zero-error raw DRC, physical qualification or manufacturer acceptance is made.
