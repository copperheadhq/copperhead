## 1. Provider

- [x] 1.1 `QueryLike` returns the stream with an optional `accountInfo`, and `QueryMessage` carries `rate_limit_info` (D1)
- [x] 1.2 `ClaudeCodeProvider.chat` asks the query for the account without awaiting it, keeps a `rejected` limit event, and on a session/usage limit attaches `{ account, resetsAtMs, window }` to the error it rethrows, waiting at most 3 seconds for the account (D1); verified by 4.2

## 2. Detection and message

- [x] 2.1 `SessionLimit` gains `resetsAtIso`, `account` and `window`; `sessionLimit()` prefers attached facts and falls back to the clock text (D2); verified by 4.1
- [x] 2.2 `sessionLimitMessage` names the account, the window and the reset with its time zone, and says a switched account can re-run now (D3); verified by 4.1

## 3. Outcome

- [x] 3.1 `loop.ts` writes the `session-limit` event with the limit's fields, fails with `sessionLimitMessage`, and returns `RunResult.sessionLimit` (D4); verified by 4.3

## 4. Tests

- [x] 4.1 `test/session-limit-account.test.ts`: facts preferred over the clock text; the fallback; facts never make another error a limit; the message with and without an account, with clock text only and with no time; the window words
- [x] 4.2 The same file: the provider attaches the email, or the organization; null when the query has no `accountInfo`, when it rejects, when it throws and when it never answers; no reset when no event rejected; nothing attached to another error or to a 429; a reset already in milliseconds is kept
- [x] 4.3 The same file: `runAgentLoop` with the real `ClaudeCodeProvider` over a fake query ends `session-limit` with the account in the summary, the JSON result and the transcript event
- [x] 4.4 The existing `test/session-limit-disk.test.ts` and `test/claude-code-provider.test.ts` pass unchanged

## 5. Verify

- [x] 5.1 `npm run typecheck`, `npm run build`, the full `vitest` suite (on Windows without KiCad it fails in the same KiCad and path suites as `main`), `openspec validate session-limit-names-account --strict`
- [x] 5.2 Live check of the SDK surface (2026-11-11, Agent SDK 0.3.220, one string-prompt turn on a Claude Max login): `accountInfo()` answered with the account's email, and a `rate_limit_event` arrived with `resetsAt` in seconds
- [ ] 5.3 After release: in a workspace, a `do --model claude-code` run that hits a limit names the account, and a re-run under another login resumes from the cache
