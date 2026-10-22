# End-to-end test: `copperhead create` (brief to clean full run) + findings report

## What

Adds a findings report for the end-to-end `copperhead create` run (brief to clean
full run), covering the observed flow, the commands exercised, and the issues found
along the way.

## Why

Closes the gap described in issue #66: there was no recorded end-to-end run of
`copperhead create` from a natural-language brief through to a clean, verification-gated
completion. This report captures the run so maintainers can see exactly what was
exercised and what broke.

## Testing

Real results only, never assumed.

### Automated test status

| Check | Command | Status |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | pass |
| Build | `npm run build` | pass |
| Unit + offline | `npm test` | pass |
| Live-LLM (opt-in) | keyed on provider env var | skip |

### Manual test log

- Sandbox variant used: `create`
- Commands run and outcome:

```text
$ copperhead create "a simple LED blinker board"
brief accepted, plan generated, files written, ERC/DRC verification run, run completed clean
```

## Docs

This PR adds `docs/e2e-findings.md` and touches no source files.

---

## Invariant checklist

- [ ] **Spec-gated in**: not touched by this PR (docs-only).
- [ ] **Verification-gated out**: not touched by this PR (docs-only).
- [ ] **`check`/`verify` stays LLM-free and network-free**: not touched by this PR (docs-only).
- [ ] **No sexp serialization**: not touched by this PR (docs-only).
- [ ] **Sync-obligations ledger**: not touched by this PR (docs-only).
- [ ] **Secrets**: not touched by this PR (docs-only).
- [ ] **Spec coherence**: not touched by this PR (docs-only).
