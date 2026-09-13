# add-part-research-tools: Proposal

> Phase 1 re-ratification: this change is intentionally sequenced after
> `formalize-tool-registry` (issue #246 Phase 0). Its research tools use the
> registry's versioned schemas, structured envelopes, and predicate gates.

## Why

The agent currently designs from trained knowledge alone: it cannot look up a datasheet, confirm a part exists, or check availability, so every new part is guesswork flagged `UNVERIFIED` and constraint sources cite datasheets nobody fetched. Grounding part selection and constraint discovery in real, current data removes the biggest credibility gap in `create`/`do` output, and pulls forward the "sourceable becomes a checked constraint" item from the Phase 3 roadmap (SPEC.md §8).

## What Changes

- **New tool family: research tools**, available to the agent loop in `do` and `create` alongside file/KiCad/memory tools:
  - `web_search`: search for reference designs, app notes, and errata
  - `search_parts`: structured part search (MPN, parametrics, availability, pricing) via a supplier API
  - `fetch_datasheet`: download a datasheet PDF and cache it in the repo under `.copperhead/datasheets/`, recorded with URL, retrieval date, and content hash so runs stay reproducible and auditable
- **BREAKING (spec-level): the "no network tools in Phase 1" safety rail (SPEC.md §7) is replaced** by a scoped network boundary: research tools are the only network surface, restricted to an allowlisted set of hosts, and every request is logged to the run transcript. `check` remains contractually LLM-free and network-free (AC-2.1 unchanged).
- **Sourceable becomes a checked constraint**: part search results (availability, lifecycle status) land in `.copperhead/constraints.json` as cached snapshots with `source` and `retrieved` fields; `check` validates against the cached snapshot without touching the network and reports staleness.
- **Live, model-free part audit**: `copperhead audit <file>` reads an explicit Markdown MPN table and performs a current supplier lookup through the same allowlisted egress boundary. It reports exact-MPN availability without selecting parts or mutating BOM/constraints; an optional report output is its only non-transcript write.
- **UNVERIFIED gains an upgrade path**: a part whose key parameters are confirmed against a cached datasheet is flagged `VERIFIED(datasheet)` with a pointer to the cached file and the confirming section; parts without fetched evidence stay `UNVERIFIED`. The agent still never invents MPNs.
- **Fetched facts are cited, not pasted**: any constraint discovered from a fetched document must cite the cached artifact (path + section) in its `source` field, making the registry verifiable by a human without a network connection.

## Capabilities

### New Capabilities

- `part-research`: the research tool family (web search, part search, datasheet fetch/cache), the datasheet cache format, how fetched facts enter `constraints.json` with verifiable sources, and the sourceable-constraint snapshot rules.

### Modified Capabilities

- `safety-rails`: the path-sandboxing requirement's "no network tools exist in Phase 1" clause is replaced with the scoped network boundary (allowlisted hosts, research tools only, per-request transcript logging, network-free `check` untouched); the "No invented part numbers" requirement gains the datasheet-evidence upgrade path from `UNVERIFIED` to `VERIFIED(datasheet)`.

## Impact

- **Code**: new `src/research/` (search client, supplier API client, datasheet fetcher/cache); `src/agent/tools.ts` gains the three tool schemas; transcript writer logs network requests; drift/`check` learns to read cached sourceability snapshots.
- **Config**: `.copperhead/config.json` gains a `research` block (enable flag, host allowlist, supplier API selection); supplier API keys join the env-var-only rule and the `sk-` redaction pattern family.
- **Repo layout**: `.copperhead/datasheets/` (committed cache) and its index; `.copperhead/runs/` transcripts gain a network-request log section.
- **Docs**: SPEC.md §7 safety rail rewritten, §8 roadmap item marked pulled-forward; BOM.md flag vocabulary extended with `VERIFIED(datasheet)`.
- **Dependencies**: `formalize-tool-registry` must be archived or its specs synced before this change is archived; the default supplier integration is the credential-free public JLCSearch API, with Nexar/Brave retained as optional providers; no new runtime beyond `fetch`.
- **Unchanged contracts**: `check`/`verify` stay LLM-free and network-free (AC-2.1); spec-gating of edit tools is unaffected; research tools are read-only and never mutate repo files outside the datasheet cache.
