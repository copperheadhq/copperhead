## ADDED Requirements

### Requirement: A session-limit stop names the account and the reset
A run that ends on a saved-login session/usage limit SHALL end with `exitPath: session-limit` and an outcome that names the account that hit the limit when the provider reports it, gives the reset time in UTC when the provider reports the exact moment, and otherwise gives the provider's clock text and says it has no time zone. The outcome SHALL say that the same command can be re-run now if the provider has been switched to another account, and otherwise after the reset, and SHALL NOT say to wait unconditionally. The `session-limit` transcript event and the JSON result SHALL carry `account`, `resetsAt`, `resetsAtIso` and `window`, each null when unknown.

#### Scenario: The provider reports the account and the exact reset
- **WHEN** a `claude-code` turn fails with "You've hit your session limit · resets 10:10am" after a rejected `five_hour` limit event resetting at 2026-11-11T10:10:00Z, logged in as `a@example.com`
- **THEN** the outcome reads `claude-code session/usage limit reached on a@example.com (5-hour limit, resets 2026-11-11 10:10 UTC)` and tells the person to re-run now if they have switched accounts, and the JSON result's `sessionLimit` is `{ account: "a@example.com", resetsAt: "2026-11-11 10:10 UTC", resetsAtIso: "2026-11-11T10:10:00.000Z", window: "five_hour" }`

#### Scenario: Only the message is known
- **WHEN** a provider's turn fails with "You've hit your session limit · resets 10:10am" and reports no account and no limit event
- **THEN** the outcome reads "(resets 10:10am as the provider stated it, with no time zone)", says the limit belongs to the account that was logged in when it hit, and `sessionLimit` is `{ account: null, resetsAt: "10:10am", resetsAtIso: null, window: null }`

#### Scenario: A rate limit is not a session limit
- **WHEN** a turn fails with status 429
- **THEN** the error carries no session-limit facts and is handled by backoff as before

### Requirement: The claude-code provider reports who hit the limit without reading the credential
The `claude-code` provider SHALL ask the Agent SDK query for the logged-in account and SHALL keep a rate-limit event whose status is `rejected`. When a turn fails on a session/usage limit it SHALL attach the account (its email, else its organization), the reset in milliseconds and the window to the error it throws, leaving the error's message and status unchanged. It SHALL NOT read the credential, SHALL NOT wait more than 3 seconds for the account, and SHALL attach nothing to any other error.

#### Scenario: The SDK cannot name the account
- **WHEN** the query has no `accountInfo`, or it fails, or it does not answer within 3 seconds
- **THEN** the limit error is thrown with `account: null` and the reset and window the limit event gave

#### Scenario: Another error
- **WHEN** a turn fails with "ECONNRESET"
- **THEN** the error is rethrown with no session-limit facts
