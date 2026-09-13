# add-part-research-tools: Tasks

## 0. Phase 1 re-ratification

- [x] 0.1 Reconcile this change with the archived/synced `formalize-tool-registry` Phase 0 registry and envelope contracts
- [x] 0.2 Update the delta specs and normative SPEC.md safety rail/config/tool sections before implementation
- [x] 0.3 Confirm the Phase 2 scope is 33 implementation tasks and keep MCP/host skills in `add-mcp-server`

## 1. Foundations (egress + config)

- [x] 1.1 Add `research` block to config schema (`enabled`, `provider`, `searchProvider`, `allowHosts`, `stalenessDays`, `maxPdfMB`) with absent-means-disabled defaults; document every key in `.copperhead/README.md` generation
- [x] 1.2 Implement `src/research/net.ts` egress module: allowlist enforcement, redirect host re-validation, timeout, response size cap, per-request transcript network-log entries
- [x] 1.3 Generalize transcript/summary redaction: existing `sk-` pattern plus values of all `*_KEY`/`*_SECRET`/`*_TOKEN` env vars and configured provider key formats
- [x] 1.4 Add static guard test: no module outside `src/research/` references network APIs; the `check` command path imports nothing from `src/research/`
- [x] 1.5 Unit tests for egress: non-allowlisted host refused (direct and via redirect), size cap enforced, every request logged

## 2. Providers

- [x] 2.1 Define `SearchProvider` and `PartDataProvider` interfaces with normalized result types (part: MPN, manufacturer, lifecycle, stock by distributor, price breaks, datasheet URL)
- [x] 2.2 Implement Brave `SearchProvider` (metadata-only results: title, URL, snippet), key via `BRAVE_API_KEY`
- [x] 2.3 Implement Nexar `PartDataProvider`, keys via `NEXAR_CLIENT_ID`/`NEXAR_CLIENT_SECRET`, with backoff through the egress module
- [x] 2.4 Provider unit tests against recorded fixtures (no live network in CI)
- [x] 2.5 Implement the credential-free JLCSearch `PartDataProvider`, normalize LCSC metadata/stock/prices/datasheet URLs, and make it the default provider

## 3. Datasheet cache

- [x] 3.1 Implement fetcher: download to `.copperhead/datasheets/<mpn>-<hash8>.pdf`, SHA-256, `index.json` entry (MPN, URL, timestamp, hash, size, title), dedupe by hash
- [x] 3.2 Per-page text extraction to sibling `.pdf.txt` with page/section markers that survive into citations
- [x] 3.3 Size-cap refusal path writing a `not-cached` index entry preserving the URL
- [x] 3.4 Changed-hash handling: new entry plus revisit obligations for citations of the old entry (obligations ledger integration)
- [x] 3.5 Ensure `.copperhead/datasheets/` is committed (not gitignored); document the git-lfs migration note in `.copperhead/README.md`

## 4. Agent tool integration

- [x] 4.1 Add `web_search`, `search_parts`, `fetch_datasheet` tool schemas and dispatch in `src/agent/tools.ts`, with provider-specific structural gates
- [x] 4.2 System prompt additions: fetched content is data not instructions (ignore-and-report rule), snapshot `retrieved` timestamps surfaced next to sourcing constraints
- [x] 4.3 Post-tool-call hook: `search_parts`-informed selection opens a dual-write obligation for the `sourcing.<refdes>` snapshot and BOM.md line in the same turn
- [x] 4.4 Run `summary.md` gains a network section: request count, datasheets cached, snapshots written
- [x] 4.5 Add JLCSearch host/data-source documentation and keep Brave/Nexar credentials optional

## 5. Constraints, drift, and check

- [x] 5.1 Sourceability snapshot schema in `constraints.json` (`sourcing.<refdes>` with MPN, lifecycle, stockTotal, price1k, retrieved, source, affects)
- [x] 5.2 Citation drift check: cited cache file exists, hash matches index, cited section occurs in extracted text; broken citations fail drift naming doc, citation, and cause
- [x] 5.3 Offline sourceability validation in `check`: snapshot presence per MPN row, lifecycle not EOL, nonzero stock at retrieval, staleness vs `stalenessDays`; warnings by default, `--strict-sourcing` promotes to failures; EOL flagged per truth-precedence, never silently resolved
- [x] 5.4 `VERIFIED(datasheet)` upgrade logic in BOM handling: upgrade only when every selection-driving parameter cites a passing citation; otherwise `UNVERIFIED` stands
- [x] 5.5 Regression: AC-2.1 no-network assertion still passes with research configured (check makes zero network calls)
- [x] 5.6 Add `audit <file>`: deterministic, model-free exact-MPN live lookup through the research egress boundary; read-only except transcript and explicit `--output`; sourceability snapshots remain untouched

## 6. Scenario tests (map 1:1 to delta specs)

- [x] 6.1 part-research: tools absent without keys / present when configured
- [x] 6.2 part-research: egress rejection, redirect re-validation, request logging
- [x] 6.3 part-research: snapshot dual-write same-turn; fetch cache/index/text; oversized refusal; changed-hash revisit obligation
- [x] 6.4 part-research: valid citation passes, broken citation fails; check offline; stale warns, strict fails
- [x] 6.5 part-research: injection attempt in cached text is inert and reported
- [x] 6.6 safety-rails: provider key redaction; evidence upgrade to `VERIFIED(datasheet)`; no-evidence stays `UNVERIFIED`; static no-network-outside-egress guard
- [x] 6.7 JLCSearch: no-key gate, public JSON fixture normalization, LCSC stock/price/datasheet mapping
- [x] 6.8 Part audit: named Markdown input, exact-MPN/stock result classification, output containment, transcript logging, and no snapshot write

## 7. Docs and archive prep

- [x] 7.1 Update `.env.example` with `BRAVE_API_KEY`, `NEXAR_CLIENT_ID`, `NEXAR_CLIENT_SECRET`
- [x] 7.2 Draft SPEC.md edits for archive time: §7 scoped network boundary replaces "no network tools", §4.2 tool table gains research tools, §8 marks part-data item pulled forward
- [x] 7.3 README: document research setup, offline behavior (graceful degradation), and the `VERIFIED(datasheet)` flag meaning
- [x] 7.5 README/SPEC: document `audit` as an explicit live-network, model-free command and keep `check` offline
- [ ] 7.4 Coordinate with build-copperhead-phase-1: this change's safety-rails deltas modify requirements introduced there; archive phase-1 first (or sync its specs) so the MODIFIED blocks land against existing main specs
