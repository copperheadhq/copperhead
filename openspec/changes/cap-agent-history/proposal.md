# Cap the conversation history each turn re-sends

## Why

Every provider re-sends the whole conversation on every turn - the claude-code provider flattens it with `renderConversation`, and the keyed providers post the full `messages` array - and nothing has ever trimmed it. Cost therefore grows roughly quadratically in turns, and the growth is dominated by content the model no longer needs: a `.kicad_sch` is tens of kB, the schematic stage re-reads it between anchored edits, and every stale copy is re-billed on every later turn along with every already-applied edit payload.

The measured create runs recorded in `pipeline-run-logs/` show the effect directly: part-selection spent 40.5k output tokens over 10 turns, the schematic stage 48k+ over 8, with one 44k-character turn. `PIPELINE-EFFICIENCY.md` named this the single highest-leverage fix and it is the one recommendation from that document still unimplemented.

It also gates the compat route in practice. Groq returned `413` on **turn one** against its 6000–8000 TPM caps, and small local Ollama models stall on context length - both are the first turn already being too large, before any history has accumulated.

## What Changes

- New `capHistory(messages, opts)` (`src/agent/history.ts`) builds the view of a conversation that is actually sent, leaving the caller's array untouched.
- Three trims, in order of how safe they are:
  - **Supersession** - a `read_file` result is replaced by a short stub when a later read of the same path *covering the same lines* exists in the same conversation. The replacement is itself in the history, so nothing is lost. Applies at any distance. Coverage matters because `read_file` honours `start_line`/`end_line`: a later twenty-line read does not reproduce an earlier whole-file read, so path alone is not enough to call one read redundant.
  - **Result truncation** - a settled tool result longer than `maxToolResultChars` is clipped head-and-tail with an explicit marker saying how much was cut and how to recover it.
  - **Argument truncation** - a settled tool-call argument string longer than `maxToolArgChars` (an already-applied anchored edit payload) is clipped the same way.
- Truncation is lossy, so it never touches the last `keepRecent` messages. Supersession is not lossy and deliberately ignores that window: protecting stale reads by recency would shield exactly the largest items, which is most of the cost.
- New `historyCap` config field, default on; set it false to reproduce a run's exact prompts.
- The run records `capCharsSaved` and emits a `history-capped` transcript event per turn that trims anything.

## Impact

- **The transcript and the ledger are unaffected.** Capping produces a request-time view only, so a postmortem still sees full fidelity.
- **Length, order, roles, and tool-call ids are preserved exactly.** The claude-code session-resume path slices by index (`renderDelta(messages, sentCount)`) and every provider pairs a tool result to its call by id; both break if messages are dropped or reordered, so capping never does either. Only `content` strings and oversized argument strings shrink.
- **Existing LLM cache entries are invalidated once.** `CachingProvider` hashes the messages it is handed, and those messages are now smaller. The new key is the correct one — the request genuinely changed but the first run after upgrade re-pays for turns it had cached. No eviction exists, so the orphaned entries stay on disk until the directory is cleared.
- Measured on a schematic-stage-shaped conversation (30kB schematic re-read across six edit rounds): rendered prompt falls 72.7%, ~47k tokens saved on a single turn, message count unchanged.
- No new dependencies. `check` stays LLM-free and network-free.
