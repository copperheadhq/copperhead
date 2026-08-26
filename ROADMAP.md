# copperhead roadmap

This roadmap is grounded in the state of `main` as of July 2026 (v0.3.0). It is sequenced by dependency: Phase 1 unblocks everything after it, because every borrowed feature and every launch post rests on the agent loop demonstrably working.

Ordering within a phase is by value. Items reference the acceptance criteria in [SPEC.md](openspec/specs/SPEC.md) where they exist.

Implementable items are planned as OpenSpec changes (proposal, design, delta specs, tasks), ready for `/opsx:apply`:

| Roadmap item | OpenSpec change |
| --- | --- |
| Phase 0 (housekeeping) + Phase 1 items 2-4 (evidence, benchmark, CI) | [prove-live-acceptance](openspec/changes/prove-live-acceptance/) |
| Model benchmarking, the task suite, and the whitepaper | [copperhead-benchmarks](https://github.com/chouhanindustries/copperhead-benchmarks) (separate repository) |
| Phase 1 item 1 (run the live suite) | remaining tasks in [build-copperhead-phase-1](openspec/changes/build-copperhead-phase-1/tasks.md) |
| Phase 2 item 1 (fab release gate) | [add-fab-release-gate](openspec/changes/add-fab-release-gate/) |
| Phase 2 item 2 (supplier BOM export) | [add-supplier-bom-export](openspec/changes/add-supplier-bom-export/) |
| Phase 2 item 3 (part research) | [add-part-research-tools](openspec/changes/add-part-research-tools/) (previously proposed) |
| Phase 2 item 4 (SPICE gate) | [add-spice-verification-gate](openspec/changes/add-spice-verification-gate/) |
| Phase 3 items 1-2 (MCP wrapper + skill) | [add-mcp-server](openspec/changes/add-mcp-server/) |

Phase 3 item 3 (launch) and Phase 4 are process and content work, tracked here rather than as changes.

---

## Current state (verified)

**Solid.** `init` and `check`/`verify` are deterministic, LLM-free, and green in CI against a real KiCad fixture. The two invariants are covered by structural tests, not prompts: edit tools are absent from the tool list until an OpenSpec proposal validates, `finish` blocks on open ledger obligations and unverified ERC, `DECISIONS.md` is append-only, the pre-commit hook blocks desynced hand edits, and the `check` module graph is asserted to never import a provider SDK.

**Implemented, not yet proven.** The agent loop (`do`, `sync --resolve`, `create`) is complete and structurally gated for both providers, but the live acceptance suite (AC-3.x, provider parity per AC-3.10) has not been observed passing end to end. The suite exists and is key-gated; the gap is running it.

**Shipped.** Deterministic schematic drafting: the engine computes placement, routing, power symbols, and group boxes from the netlist intent, a read-only legibility checker gates drawing quality, and a scorer reports the sheet's composite advisorily. `draft schematic` and `score schematic` are LLM-free and network-free like the rest of `check`. Closes #136 and #159.

**Pending.** The `add-part-research-tools` OpenSpec change is proposed with design and tasks written, not yet implemented.

---

## Phase 0: Housekeeping (immediate)

1. **Fix the README version drift.** `package.json` says 0.3.0; the README status line says v0.1. For a tool whose thesis is that drift is a build failure, this is the one bug that cannot be allowed to sit. Fix the line, then close the loop properly: teach `check` (or a repo-local CI step) to validate the README's version claim against `package.json`, so the tool's own repository is held to the standard it enforces on hardware repos.
2. **Regenerate the maturity section from CI.** The "Solid / Implemented, not yet proven" split should be produced by badge or script, not maintained by hand, so it updates itself as Phase 1 lands.

## Phase 1: Prove the core claim (now to ~4 weeks)

The single biggest weakness is "implemented, not yet proven." Nothing else on this roadmap matters until this phase is done.

1. **Run the live acceptance suite to green.** Execute AC-3.x with real keys and `kicad-cli` present, for both providers (AC-3.10 parity). Fix what breaks. This is the entire gap between the current maturity statement and "proven."
2. **Publish passing run transcripts.** Every run already writes a redacted JSONL transcript and a human `summary.md` to `.copperhead/runs/`. Promote passing acceptance runs to public artifacts linked from the README. The transparency commitment that puts every schematic in public applies to the agent's work too: show the loop, not a claim about the loop.
3. **Make the Open Telegraph a reproducible benchmark.** `copperhead create --brief telegraph.md` from a clean repo, with every trap it catches documented. This is the demo, the regression suite, and the launch story in one artifact.
4. **CI badge matrix.** Offline suite (already green) plus a nightly live-model acceptance run per provider. Feeds Phase 0 item 2.

**Exit criteria:** live suite green on both providers, at least one full published `create` transcript, Telegraph benchmark reproducible from a clean clone.

## Phase 2: Close capability gaps (weeks 4 to 10)

Ranked by fit with the two invariants. Items 1 and 2 extend the LLM-free `check` surface; items 3 and 4 extend verification and grounding.

1. **Fab release gate: `copperhead check --fab`.** Deterministic pre-fabrication checks in the style the ecosystem has validated (kicad-happy's release gate is the reference): routing completeness, BOM readiness with missing-MPN flags, schematic-to-PCB match, gerber and drill verification, documentation presence. Contractually LLM-free and network-free like the rest of `check`, so it is safe in CI and pre-commit. This is the highest-value borrow available.
2. **Supplier-ready BOM export.** JLCPCB-formatted BOM plus DigiKey and Mouser CSVs, quantities computed for board count plus spares. Small lift; closes the distance between "orderable BOM" and an order.
3. **Execute `add-part-research-tools`.** The proposal is already written: `web_search`, `search_parts`, and `fetch_datasheet` as agent tools, a committed datasheet cache keyed by URL, retrieval date, and content hash, the `UNVERIFIED` to `VERIFIED(datasheet)` upgrade path, and sourceability as a cached constraint that `check` validates offline with staleness reporting. This grounds the budget arithmetic in cited datasheets instead of model memory, and it removes the biggest credibility gap in `create` and `do` output. Implement per its design.md and tasks.md.
4. **SPICE as an optional verification gate.** ERC and DRC gate connectivity and layout; ngspice on flagged analog subcircuits extends "nothing is done until the tools agree" to behavior. Opt-in per subsystem, same repair-or-rollback discipline as ERC/DRC.

## Phase 3: Distribution (weeks 8 to 14)

1. **Thin MCP wrapper.** Expose `copperhead_check` and `copperhead_do` as opaque MCP tools that run the full gated pipeline internally and return the run summary. The host agent invokes the whole verified loop; it can never reach around it to edit KiCad files directly, so the invariants survive the integration. List it in the MCP registries where raw KiCad tool servers are currently the only option, and say plainly what they cannot: spec-gated in, verification-gated out.
2. **Claude Code / Codex skill.** A skill that teaches coding agents to call copperhead rather than touch `.kicad_sch` files themselves. Meets the agent-skills audience on their own turf.
3. **Launch.** Show HN and Hackaday, with the reproduced Telegraph run as the demo rather than a tool description. The hook is the guarantee: watch an agent design a real board, refuse to break its power budget, and roll back when verification fails.

## Phase 4: Widen the moat (ongoing)

1. **Import from code-first HDLs, do not fight them.** tscircuit and atopile both export KiCad; accept their output as input. Their users become copperhead users at the layout, verification, and drift stage, with no rewrite asked of anyone.
2. **Constraint packs.** Shareable, versioned budget and rule presets as plain JSON: battery-powered device, USB-PD, EMC-conscious layout. Community contributions that compound. Everything stays readable markdown and JSON in the user's repo, per the no-lock-in commitment.
3. **Layout levers beyond the hand-rolled engine.** Two successors are documented rather than built, both judged by the Tier C harness so a swap has to prove itself on the same corpus. **elkjs** (EPL-2.0, license-compatible as an unmodified dependency) stays the escape hatch for topologies the rule-based placer draws awkwardly; it was rejected for v1 because it is an 8 MB GWT transpilation that cannot be debugged when a layout is wrong and has no grid support, so every coordinate would need snap-and-repair. A **template corpus** (tscircuit-style idiom matching) is the successor to the built-in idiom rules, for when the rule set stops generalizing. Reach for either only when the scorer says the current engine has run out of road.
4. **Own the category framing.** "Drift is a build failure" positions copperhead as CI for hardware design, not another AI designer. Every competitor claims design; none can make the verification guarantee. Write it as a build-log post and keep making the argument.

## Non-goals (unchanged)

- **No autorouter.** Layout intent and draft placement, yes; competing with dedicated routers, no.
- **No GUI application.** Repo-native is the differentiation. KiCad remains the editor.
- **No custom fine-tuned model.** Frontier models through documented prompts, both providers at parity. The prompts are public; a model fork is a maintenance trap and an opacity risk.
- **Not the engineer of record.** A human signs off. The tool's job is to make that sign-off trustworthy.
