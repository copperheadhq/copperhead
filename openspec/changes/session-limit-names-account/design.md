## Context

`sessionLimit(err)` (`src/util/retry.ts`) recognizes a saved-login session/usage limit by the error's message and captures the clock text after "resets". `loop.ts` then writes a `session-limit` transcript event with `{ resetsAt, provider }` and fails the run with a message that says to wait for the reset. Neither knows which account hit the limit, and the clock text has no time zone.

The `claude-code` provider (`src/agent/providers/claude-code.ts`) iterates the Agent SDK's `query()` stream and handles `stream_event`, `assistant` and `result` messages. Two things the SDK offers go unused: the `Query` object's `accountInfo()` and the `rate_limit_event` message, whose `rate_limit_info` has `status`, `resetsAt` and `rateLimitType`.

## Goals / Non-Goals

**Goals:**
- The stop says whose limit it is and when it resets, in a stated time zone.
- A person who has switched accounts is told a re-run can go ahead now.
- A machine reader gets the same facts as fields.

**Non-Goals:**
- Retrying or waiting inside the process (`--resume-on-reset`).
- Choosing or rotating accounts. copperhead uses whatever login the provider holds.
- Changing how a limit is detected. Detection stays the message match, with a 429 excluded.
- The same facts for `codex`: its CLI reports no account on this path. It gets the new wording and the fallback.

## Decisions

### D1. The provider attaches the facts to the error it already throws

At the start of a turn the provider calls `accountInfo()` on the query, if the query has it, and does not await it. While iterating it keeps the last `rate_limit_event` whose status is `rejected`. In its `catch`, when the error is a session/usage limit by `sessionLimit(err)`, it sets `err.sessionLimit = { account, resetsAtMs, window }` and rethrows the same error, so the message, any status and the stack are untouched and every other error passes through as before.

`account` is the email, else the organization, else null. The account promise never rejects and is given 3 seconds to settle in the failure path, so a subprocess that died before answering cannot hang the turn. On a successful turn the promise is simply dropped.

`resetsAt` is seconds since the epoch in Agent SDK 0.3.220 (checked on a live event). The provider converts it to milliseconds and keeps a value that is already in milliseconds, so a unit change in the SDK does not put the reset in 1970.

`QueryLike` now returns the stream with an optional `accountInfo`, still declared structurally, so the SDK stays an optional dependency and existing test fakes (bare async generators) keep compiling.

Alternative considered: ask for the account only after the limit hits. Rejected: the subprocess may have exited by then.

### D2. `sessionLimit()` prefers the facts and falls back to the text

`SessionLimit` becomes `{ resetsAt, resetsAtIso, account, window }`. With an exact reset, `resetsAtIso` is the ISO timestamp and `resetsAt` is `YYYY-MM-DD HH:MM UTC`. Without one, `resetsAt` is the clock text as before and `resetsAtIso` is null, which tells a reader the time has no zone. Attached facts never make a non-limit error a limit.

### D3. The message says what is true

`sessionLimitMessage(provider, limit)` builds the outcome: the provider, the account when known, the window (`5-hour`, `weekly`) and the reset; "This is a schedulable pause, not a bug."; whose limit it is; and "If you have switched <provider> to another account, re-run the same command now; otherwise re-run it after the reset." A reset known only as clock text is followed by "as the provider stated it, with no time zone".

### D4. The same facts in the transcript and the JSON result

The `session-limit` event carries the `SessionLimit` fields and the provider. `RunResult` gains an optional `sessionLimit`, set only on this exit, so `--json do` prints it and a caller need not parse the summary.

## Risks / Trade-offs

- [An email in the transcript] → The transcript, `summary.md` and the JSON result are local files under `.copperhead/runs/`, which is gitignored (AC-4.3). Nothing is sent anywhere.
- [`accountInfo()` unsupported by a future SDK or mode] → The call is optional and guarded; the outcome then reads as it does without an account.
- [A limit that the SDK reports only as text, with no rejected event] → The clock text is used and the message says it has no time zone.
- [One control request per turn] → It rides the subprocess the turn already started, and is not awaited on the success path.
