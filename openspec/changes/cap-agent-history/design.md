# Design — capping the re-sent conversation

## D1. A request-time view, not a mutation of the run's history

Capping builds a new array and hands it to `provider.chat`; the loop's own `messages` stays whole.

The alternative trimming `messages` in place as it grows — is cheaper and wrong. The transcript is the postmortem artifact for a failed run, and the obligations ledger and finish gate reason over what actually happened. Shrinking the run's own record to save tokens would trade an auditable failure for a cheaper one. It also compounds: a lossy trim applied at push time can never be revisited, whereas a view is recomputed each turn from full data.

## D2. Length, order, roles, and ids are invariants, not preferences

Two mechanisms in the codebase index into the message array:

- `renderDelta(messages, sentCount)` with `sentCount = messages.length` (`claude-code.ts`) the session-resume path sends only messages after an index, so a dropped message silently desynchronises every later turn.
- Every provider pairs a `tool` message to its originating call by `toolCallId`.

So capping shrinks `content` strings and oversized argument strings and nothing else. It never drops, merges, reorders, or re-ids a message. This is what makes it safe to sit in front of any provider, including ones added later, and it is why "just drop old messages" the obvious implementation is not what this does.

A corollary, not a defect: the session-resume providers (`claude-code.ts`, `cursor.ts`) send `renderDelta(messages, sentCount)` with `sentCount` from the previous turn, so only the messages added since last turn go over the wire — precisely the ones inside `keepRecent`, which truncation never touches, and where supersession fires only if a re-read lands in that same delta. Those providers therefore see little direct benefit from capping. The fix is deliberately provider-agnostic (it caps the array every provider is handed, at the one `provider.chat` site) rather than special-cased per provider, so this is expected, not a wiring bug to fix.

## D3. Supersession ignores the recency window; truncation does not

The first implementation protected the last `keepRecent` messages from *all* trimming. A test on a realistic schematic-stage conversation showed capping barely fired: the protected window was shielding the largest items - the most recent 30kB re-reads which is precisely the cost being targeted.

The fix separates the two trims by how lossy they are:

- **Supersession is not lossy in isolation.** A read is superseded only when a *later* read of the same path covering the same lines exists in the same conversation, so the current contents are still in front of the model. Distance is irrelevant to that argument, so no recency protection is warranted.
- **Truncation is lossy.** A clipped result cannot be recovered from the conversation, only by re-running the tool. So it applies only outside the recent window, where the model has already acted on the content.

The newest read of a path is never superseded by construction, nothing is later than it.

The two trims compose, and the composition weakens supersession's "in front of the model" guarantee: when both the superseded read and the later read that replaced it sit outside `keepRecent`, the earlier one is stubbed *and* the later one is truncated, so the full contents are in front of the model in neither. This is not a correctness bug — both trims announce themselves in-band (D4) and name how to recover the content, and the newest read of the path is always the least likely to be truncated since it is the closest to the recency window — but the guarantee holds per-trim, not for the pass as a whole. The cheaper honest framing was chosen over exempting a surviving read from truncation, which would buy a strictly-true invariant at the cost of keeping a large read that the model may not touch again fully on the wire.

## D3a. Supersession compares line coverage, not just path

The first implementation treated any later read of the same path as a replacement. That is wrong: `read_file` takes optional `start_line`/`end_line` and returns only that span, so a later twenty-line read does not reproduce an earlier whole-file read. Superseding on path alone silently deleted content the model could still be relying on, which is the one thing supersession was supposed to never do.

A read is now recorded with the span it returned, an absent bound meaning "to the end of the file", so a whole-file read is `[1, Infinity]`. An earlier read is superseded only when some later read of the same path *contains* its span. Ordinary interval containment then covers every case without special-casing: two whole-file reads supersede (identical spans contain each other), a whole-file read supersedes any earlier ranged read, a ranged read never supersedes a whole-file read, and disjoint or partially overlapping ranges never supersede.

Containment is checked against *any* later read, not merely the most recent one, so a narrow read late in a conversation does not resurrect earlier copies that a wider intervening read had already made redundant.

One detail follows from mirroring the tool rather than its schema: `toolReadFile` returns the whole file whenever `start_line` is absent, ignoring `end_line`, so such a read is recorded as whole-file rather than as `[1, end_line]`; recording the narrower span would understate what the model actually received.

Mirroring the tool only stays sound if the tool and the recorder read the bound the same way. Tool args reach the loop straight from `JSON.parse` of model output with no schema coercion, so `start_line` can arrive as a stringified `"4"`. `toolReadFile` coerces that through `Math.max`/`Math.min` and does a real partial read, but a recorder that branched on `typeof start_line === 'number'` would see the string, fall through to the whole-file default, and record the partial read as `[1, Infinity]` — the exact inversion this design forbids, letting the partial read supersede an earlier whole-file one. The fix normalizes both bounds once, in the `read_file` handler, to a finite number or a dropped bound, and writes the normalized values back into the call's args so the conversation records what the tool actually did. `rangeOf` then sees only finite numbers or absent bounds. As a second line of defence for any read that reaches `rangeOf` without passing through the handler (a hand-built history, a future caller), a bound that is present but not a finite number yields an unknown span: that read supersedes nothing and is superseded by nothing, the same conservative treatment failed reads get.

Failed reads are excluded from the candidate set as well, since replacing real content with a pointer to a read that returned nothing is strictly worse than sending the content again. See D3c for why that status cannot be read off the text.

## D3b. The request view is structurally independent, not merely a fresh array

Returning a new array is not enough on its own: the message objects inside it would still be the run's own. A provider that mutated what it was handed would be writing directly into the history the transcript and the finish gate read from.

Every message in the view is therefore a fresh object, with fresh tool-call arrays and fresh argument objects. This is cheap in the way that matters: strings are immutable in JavaScript and shared by reference, so the copy allocates object shells, not the payload bytes that make the history expensive in the first place.

## D3c. Failure is carried as status, not inferred from the text

A tool's failure text is just text. `dispatchTool` turns a throwing handler into an ordinary `error: ...` result, and the tool message that reaches the conversation holds nothing but a string, so any caller wanting to know "did this call fail?" is tempted to sniff prefixes. That is wrong in a way that is easy to miss: a repository can legitimately contain a file whose contents begin `error:` (a build log, a pasted traceback), and reading it successfully would then be classified as a failure.

So `dispatchToolResult` returns `{ text, ok }` and the loop records `failed` on the tool message. Capping reads that flag and never inspects the text. The existing string-returning `dispatchTool` is kept as a thin wrapper, so the many call sites that only ever want what the model would see are unchanged.

The direction of the old bug matters less than its shape: misclassifying a real read as failed only cost savings, never correctness. But the fix removes a class of guess rather than narrowing one heuristic, and it puts the status where a future reader of the conversation can rely on it.

## D4. Trims are announced in-band

A model that cannot distinguish "this file is short" from "this file was clipped" will confidently reason about content it never saw. Every trim leaves a marker saying what happened, how much was removed, and how to get it back (`read_file` with a line range; re-run the tool). The superseded stub names the path, so the model can re-read precisely.

Head-and-tail clipping rather than head-only: the shape of a KiCad file matters as much as its start, and the tail is where a truncated s-expression's structure shows.

## D5. Defaults tuned to clip the blowup, not ordinary work

`maxToolResultChars: 4000` comfortably fits a normal file read and every report `kicad-cli` produces, while clipping multi-tens-of-kB schematic reads. `maxToolArgChars: 2000` targets anchored KiCad edits, whose `new_string` can carry a whole subsystem. `keepRecent: 12` keeps roughly the last few assistant/tool exchanges verbatim.

These are constants rather than config fields: `historyCap` is a boolean escape hatch for reproducing exact prompts, and three more tuning knobs in `.copperhead/config.json` would be surface area with no demonstrated need. They can be promoted to config if a real case wants them.

## D6. Accepted cost: one-time LLM-cache invalidation

`CachingProvider` hashes the messages it receives, and those messages are now smaller, so every existing entry is orphaned on the first run after upgrade.

This is not avoidable the way the earlier `baseURL` key-shape regression was. There, the fix was to keep the key byte-identical for runs whose behavior had not changed. Here the request genuinely did change - the model is being sent different bytes - so a different key is the *correct* outcome, and reusing the old one would replay a response generated from a different prompt. The cost is one re-paid run and some orphaned files, against a permanent per-turn saving.

## D7. The provider-side prompt cache needs a breakpoint below the rewrite

D6 covers the on-disk `llm-cache`. The Anthropic provider also keeps a *provider-side* prompt cache, and capping interacts with it in the opposite direction to the one this change is aiming for.

`anthropic.ts` places three ephemeral `cache_control` breakpoints: the system prompt, the last tool definition, and the last block of the final message. That caches the stable prefix plus the conversation up to the previous turn. Capping, though, rewrites messages at *any* index: supersession deliberately ignores `keepRecent`, and a result crosses out of the recent window as `truncateBefore` advances every turn. The first turn on which a given trim fires, the request diverges from the cached prefix at that old index, every breakpoint at or below it is invalidated, and the whole conversation is re-billed at 1x input plus a 1.25x cache write instead of a 0.1x cached read. That is a loss on exactly the turns capping exists to make cheaper.

Two facts bound the damage. The capped view is monotone *per trim kind*: `truncateBefore` only grows, a superseded read stays superseded, and `clip` is deterministic. And the divergence point is knowable before the request goes out. So `capHistory` reports the lowest index it rewrote (`HistoryCapStats.firstChanged`), the loop passes it as `ChatOpts.stablePrefixBefore`, and the provider puts a fourth breakpoint on the last block *below* that index. The head of the conversation keeps hitting the cache; only the tail from the rewrite down is re-read. Four breakpoints is the Anthropic maximum, which is exactly what this now uses.

The cost is therefore a partial cache miss per newly-firing trim, not permanent cache defeat. Note that "monotone per trim kind" is not "each message changes at most once": a result clipped when it crossed out of `keepRecent` is rewritten a second time, to a stub, once a later read of the same path supersedes it. `capHistory` recomputes the view from the untrimmed history every turn, so a message's *view* may change more than the stored history ever does. A re-read path therefore costs two partial misses, not one, and re-reading is precisely the workload this change targets.

This mitigation is Anthropic-only by necessity, not by preference. OpenAI's prefix caching is automatic and exposes no breakpoint control, so the same rewrites invalidate it and there is nothing to place; the session-resume providers send only the delta (D2) and are barely affected either way. The general problem — trimming an old message costs a cache prefix — is mitigated where the provider gives us a lever and simply accepted where it does not. Providers without a prompt cache ignore the hint, so this stays provider-agnostic in the sense D2 requires: the capped array itself is identical for everyone, and only an optional out-of-band index differs.

Honest limit: the mechanism is derived from the provider code and the monotonicity argument, not from a measured live Anthropic run. The 72.7% saving quoted elsewhere is a synthetic fixture (`tasks.md` 9.3), and the prompt-cache interaction has not been measured against a real run either.
