# add-pcb-layout-framework: Proposal

Implements [RFC 11: The Copperhead PCB Layout Generation Standard](https://github.com/copperheadhq/copperhead-rfcs/blob/main/rfc/rfc11.md). Section numbers below (§) refer to the RFC.

## Why

The board half of `create` has a deterministic front end (`src/kicad/board.ts`: netlist export, footprint resolution, shelf-packed placement, pad nets, load probe) and nothing behind it: stage 5 asks the model to nudge `(at X Y)` lines and leaves routing to "a human or specialist tool", and a board with zero copper reaches stage 6 and produces gerbers (#252, #227). The two attempts at closing that gap so far, PR #253 and an in-house connectivity-aware placer, both put copperhead in the engine business, which is the one place it has no advantage and every neighbour already competes (§4.1). RFC 11 settles the division: **copperhead owns the harness** (canonical IR, constraint registry, intent compiler, orchestration, independent verification, scoring, provenance, repair loop) and **wraps engines** (FreeRouting, kicad-tools, pyplacer, later OrthoRoute and commercial routers) behind one fail-closed plugin contract, with `copperbench` as the evidence that decides what ships. This change is the v1 of that framework: the layout backend for `copperhead create`, the layout track of `check`, and the benchmark.

## What Changes

- **A canonical PCB IR and KiCad adapter** (§6): versioned, hashable, integer-nanometre IR with stable component ids, refdes mapping, explicit pad-to-net connectivity, layer-aware objects, KiCad UUID source mapping, zone definitions preserved and refilled; immutable `BoardSnapshot`s that engines cannot write into.
- **Engine plugin contracts, registry, and runner** (§8.1, §9.1, §9.3, §9.4, §17): `PlacerPlugin`, `RouterPlugin`, `CheckerPlugin` with manifests declaring determinism, execution mode, network requirement, license, and capabilities; capability negotiation that returns `UNSUPPORTED` rather than a degraded attempt; out-of-process isolation; `single`, `race`, `staged`, `ensemble` execution modes (`portfolio` deferred).
- **Wrapped engines, none copperhead-authored** (§8.2, §9.2): `router-freerouting` (DSN/SES, building on the bridge validated in #253), `router-kicad-tools-astar`, `placer-fixed`, `placer-pyplacer`, `placer-kicad-tools-physics` / `-evolutionary`, `placer-layout-reuse`; `placer-reference` and `router-reference` as harness fixtures only; `router-orthoroute` optional.
- **Independent verification** (§10): copperhead geometry and connectivity checkers, KiCad DRC as the rule authority, kicad-tools DRC and kicad-happy adapters, the intent checker, the routability probe; normalized `Diagnostic`s; hard placement and routing gates; the §10.6 domain checklist with its v1 dispositions; the §10.7 supported envelope.
- **Layout constraints in the existing registry** (§7): nine constraint classes in `.copperhead/constraints.json` with `severity`, `scope`, `parameters`, `priority`, `confidence`, `approvedBy`; ECAD-authored constraints ingested first; an intent compiler with provenance and `HOLD` semantics; a physics compiler that is advisory unless its inputs are complete.
- **Reference layout retrieval** (§8.6): before placement, search manufacturer reference designs (through the datasheet cache and RFC 4 patterns), existing native-CAD designs (local corpora and online), and RFC 1 teardowns for blocks that match each subsystem's anchor; rank by similarity; cache with license and provenance; apply permissive blocks automatically and hold copyleft or unknown ones for approval; feed `placer-layout-reuse` and the attachment stage.
- **Scoring and selection** (§11): PCBWorld's eight routing metrics adopted verbatim plus placement metrics; lexicographic gates then a Pareto frontier with a weighted profile picking a default.
- **The repair loop** (§12): permitted and prohibited LLM actions, the bounded repair catalog, engine-second budgets, and the eight terminal statuses used identically by CLI, tools, bench, and evidence.
- **`copperbench`** (§13, §13.5): tracks E/D/F/A/B/C, the dataset composition, the experiment protocol, and milestones B0–B4 as the acceptance evidence.
- **Surfaces** (§14.3, §13.5.2): `copperhead pcb import|infer-intent|place|route|verify|score|layout`, `copperbench run|compare|report`; `create` stage 5 calls `pcb layout` and ships the evidence bundle as `## Draft quality`; `check` gains the layout track; `do "<layout change>"` uses the repair loop with the existing board as preserved geometry.
- Binary acceptance criteria carry the AC-17.x family and are merged into SPEC.md on archive.

## Capabilities

### New Capabilities

- `pcb-ir`: the canonical IR, its requirements, the snapshot contract, refdes mapping, the KiCad adapter's import/export subset, zone preservation and refill, canonical hashing.
- `pcb-engine-contracts`: plugin manifests and contracts for placers, routers, and checkers; registry and discovery; capability negotiation and license/network policy; isolation and provenance; execution modes.
- `pcb-verification`: the checker stack, rule-domain authority, normalized diagnostics, hard placement and routing gates, the domain checklist dispositions, the supported envelope.
- `pcb-layout-intent`: the layout constraint classes in the registry, ECAD ingestion, intent language, intent compiler behaviour, physics compiler.
- `pcb-scoring`: placement and routing metrics, the ranking policy, optimization profiles, comparability rules.
- `pcb-repair-loop`: permitted and prohibited LLM actions, the repair catalog, engine-second budgets, stop conditions, terminal statuses.
- `copperbench`: tracks, datasets, protocol, experiment records, reports, milestones.

### Modified Capabilities

- `cli-surface`: the `pcb` command group and the `copperbench` binary; `check` gains the layout track under the same zero-LLM, zero-network contract.
- `create-pipeline`: the layout-draft stage calls the framework and its completion contract becomes the evidence bundle.
- `agent-core`: the tool list gains the framework's tools (intent, layout, repair) and structurally lacks any tool that could emit copper; `do` on a board uses the repair loop.

## Impact

- **Code**: new `src/pcb/{ir,engines,verify,agent}/` (the RFC's §13.5.1 packages as directories with an import-direction test, split into packages when a second contributor exists) and `bench/`; `src/kicad/board.ts` folds into the adapter; `src/memory/constraints.ts` gains the layout classes; new tools in `src/agent/tools.ts`; `pcb` group in `src/cli.ts`; stage 5 in `src/commands/create.ts`; layout track in `src/commands/check.ts`.
- **Dependencies**: KiCad CLI (pinned major); FreeRouting jar and a JRE, kicad-tools and pyplacer (Python), all optional external tools discovered and run out of process, none bundled; kicad-tools modules adopted per the Phase 0 wrap-vs-vendor decision. Licenses pinned in Phase 0 ADRs.
- **Fixtures**: ten golden microboards with seeded violations (#14's broken-fixture zoo), growing to 40; PCBWorld subset by reference; refusal cases.
- **Invariants**: the sexp reader still never serializes (the adapter emits candidates by template); spec-gating covers every mutating tool; nothing on `check`'s path runs an LLM, touches the network, or invokes an engine whose manifest requires a network.
- **Supersedes**: PR #253 (its DSN/SES bridge and router comparison script are the seed of `router-freerouting` and the bench runner, re-landed behind the contract); the `feat/board-bootstrap` population step becomes the adapter's input stage.
- **Ordering**: the online reference sources reuse the search and datasheet clients of `add-part-research-tools`, so those land first or the retrieval runs on local corpora only until they do; Phase 0 teardowns precede any wrapper; the checkpoint after Phase 2 decides whether placement proceeds; the validation plan has priority at that checkpoint.
- **Out of scope** (§1.2): more than two copper layers, blind/buried vias, differential pairs and length matching, controlled impedance, copper pour generation, BGA escape, a learned portfolio, any copperhead-authored production engine.
