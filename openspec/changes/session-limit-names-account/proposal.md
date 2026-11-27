## Why

A `do` run that stops on a Claude Code usage limit says "Wait for the reset, then re-run the same command" and gives the provider's clock text ("resets 10:10am") with no account and no time zone (copperhead-cloud issue #212). The limit belongs to the account that was logged in when it hit. A person who has since switched Claude Code to another account can re-run at once, and the same command then replays its completed turns from the cache and finishes; following the message instead, an assisting agent scheduled the re-run 3.5 hours later and read the clock text as UTC.

The Agent SDK already reports both missing facts: `accountInfo()` on the query names the logged-in account, and a `rate_limit_event` with `status: 'rejected'` carries the reset as an exact time and the limit's window.

## What Changes

- The `claude-code` provider asks the live query who is logged in and keeps a rejected rate-limit event. When the turn fails on a session/usage limit it attaches the account, the exact reset time and the window to the error it throws.
- `sessionLimit()` prefers those facts and falls back to the message's clock text when they are absent, as today for `codex` and for an SDK that reports nothing.
- The `session-limit` outcome names the account, gives the reset in UTC (or says the clock text has no time zone), and says that a re-run can go ahead now if the provider has been switched to another account, otherwise after the reset. It no longer says to wait unconditionally.
- The `session-limit` transcript event and the JSON result carry `account`, `resetsAt`, `resetsAtIso` and `window`.

Not in this change: a `--resume-on-reset` mode that keeps the process alive and retries. copperhead never rotates accounts on its own.

## Capabilities

### New Capabilities
- `session-limit`: what a run that stops on a saved-login session/usage limit records and tells the person.

### Modified Capabilities

None.

## Impact

- `src/agent/providers/claude-code.ts` (the account, the rejected limit event, the facts on the error), `src/util/retry.ts` (`SessionLimit`, `sessionLimit`, `sessionLimitMessage`), `src/agent/loop.ts` (the outcome, the transcript event, `RunResult.sessionLimit`), and their tests.
- The account's email is written to the local transcript, `summary.md` and the JSON result only. The credential is still never read (add-claude-code-provider D2): `accountInfo()` returns the account's name, not its token.
- `RunResult` gains an optional field and the `session-limit` event gains fields; nothing is removed or renamed. The exit path, the rollback and the cache replay are unchanged.
- No new dependency. `accountInfo()` and `rate_limit_event` were checked against Agent SDK 0.3.220 on a string-prompt query, where `resetsAt` is in seconds.
