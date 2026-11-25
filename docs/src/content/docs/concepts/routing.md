---
title: How routing works
description: What copperhead does when it routes a board — the engines it wraps, the staged plan, how candidates are judged, and what "routable" currently means.
sidebar:
  order: 5
---

copperhead does not route boards. It wraps routers that do, gives them a board they can accept, judges what they hand back, and keeps the evidence. This page describes what actually happens between `copperhead pcb route` and a board with copper on it.

The short version: a board is refused before a router runs if its placement is not legal; the nets are routed in stages, power first; every branch is materialised into a real KiCad file and verified; the candidates are ranked; and nothing is "done" because a router said so.

## The routers

Four are registered. They are addressed by id and selected with `--routers`, in preference order.

| Engine | Determinism | Needs | Notes |
| --- | --- | --- | --- |
| `router-freerouting` | nondeterministic | Java ≥ 25 | Push-and-shove, any angle, up to 32 layers. The default. |
| `router-kicad-tools` | seeded | `kct`, Python ≥ 3.10 | Up to 6 layers, fills copper zones. |
| `router-orthoroute` | seeded | `orthoroute`, Python ≥ 3.10 | **Inner layers only — needs at least 4.** Orthogonal, no arbitrary angles. |
| `router-reference` | deterministic | nothing | The harness's own two-layer router. A control, not a production engine. |

Every engine declares its capabilities in a manifest, and the runner refuses one that cannot do what the job asks — a four-layer-minimum router is never handed a two-layer board.

Freerouting is marked nondeterministic in its manifest, but in practice the 2.4.1 build is deterministic: its batch autorouter seeds `new Random(0)` and its maze search is re-seeded per rip-up, and a headless run is single-threaded. There is no seed flag, so the honest declaration stays nondeterministic; when a benchmark needs repeats it permutes the DSN instead.

## What happens, in order

### 1. The board is refused before a router runs

`routeBoard` imports the board, then runs the pre-flight and placement gates. If either fails, the run ends `REFUSE` with the failing diagnostic codes and no engine is started. A board with overlapping courtyards or parts off the edge is not a routing problem, and routing it would waste minutes to produce a board that cannot be manufactured anyway.

### 2. The nets are classified and staged

In `staged` mode the run builds a plan before touching an engine:

- **power** — nets whose class or name says power or ground, or that a copper pour carries. Routed first, at the widest track width among their net classes, by the first engine alone.
- **critical** — nets the intent file or the caller named. Routed next, also by the first engine.
- **bulk** — everything else, raced across every eligible engine so the best branch wins.

Two details matter. Every stage but the last routes at **1.5× the clearance rule** (capped at 0.5 mm): margin costs nothing where there is room, and a board routed with margin has somewhere to go when the last stage has to squeeze. The final stage routes whatever is still owed at the rule itself.

On four and six layers the inner layers alternate preferred directions — In1 horizontal, In2 vertical — and the outer layers stay free. The intent file's `routing.layers` overrides any layer.

### 3. Each engine gets a board it can read

For Freerouting the adapter writes a Specctra DSN, runs the jar headless with a pass count (20 by default, 10 for the probe), and parses the SES session file back into IR tracks, arcs and vias. Nothing round-trips through the engine's own idea of the board: copperhead emits the DSN, and only wires and vias come back.

An engine that returns something the harness cannot represent — a blind or buried via, in this release — is failed as `malformed-output` rather than quietly accepted.

### 4. Every branch becomes a real board and is verified

A staged branch carries the earlier stages' copper plus its own. That composite is materialised into an actual `.kicad_pcb`, re-imported, and verified: geometry, connectivity, return path, intent, and KiCad's own DRC through `kicad-cli`.

This is where routing is judged, not on what the engine reported. A router that claims success and leaves a short will fail here.

### 5. Candidates are ranked

Hard gates first — an ineligible candidate can never outrank an eligible one, whatever its wirelength. Then completion, then the weighted profile: completion rate, pour coverage, bottom-layer signal length, total wirelength, via count, tight segments, DRC errors, runtime.

**Owed connections never gate.** An unrouted net is reported as completion, not as a violation; a partial board is a partial result, not a failure. Shorts, DRC in the profile's critical list, and tracks narrower than their declared width do gate.

### 6. Failures become a repair plan

The repair planner reads the diagnostics and picks one action from a fixed catalog: continue routing the owed nets, more passes, a different engine, rip up the shorted nets, or re-prioritise. A model may choose among those actions; it cannot invent one, and it cannot relax a hard constraint. When nothing in the catalog answers the findings, the run asks the user.

## The routability probe

Placement needs to know whether a board can be wired before anyone commits to it. The probe routes a placement candidate with one router in a fixed configuration — 10 passes, seed 0 — and reports completion and DRC **as metrics, never as gates**. It is a measurement of the placement, not an attempt to finish the board.

## Critical-net routing

The reuse placer uses a narrower version. Rather than routing the whole board for every candidate, it routes only the nets that decide whether the board works — the ones a critical relationship gave weight to: decoupling, switch nodes, bootstrap capacitors, crystals, output chains. Then it throws the copper away and keeps three numbers: whether each net closed, how long it came out, and whether it brought critical DRC with it.

This costs 6–20 seconds per candidate instead of minutes, and it is what the placement benchmark's last two stages mean:

- **V6** — every critical net routed
- **V7** — no critical DRC after routing

When a candidate fails either, the same nets are routed on **the designer's own board** through the identical protocol. If the designer's board fails the same way, the failure belongs to the board or the router, not to the placer. On the 23-case benchmark every shortfall but one resolved that way.

## What "routable" currently means

It means **the critical nets close**. It does not mean the whole board routes.

The full-board probe exists and feeds ranking, but the placement benchmark runs with it off, because full-board routing is minutes per board against seconds for the critical subset. Every published placement number is therefore critical-nets-only. A complete board has not been demonstrated by that measurement, and the reports say so rather than letting a partial check stand for a finished one.

Two further limits worth knowing:

- **Freerouting and KiCad disagree at the margin.** Measured on the benchmark, Freerouting leaves clearances 0.8 µm to 30 µm short of what KiCad's DRC demands, which shows up as critical DRC on a board that routed cleanly. Asking the router for extra clearance absorbs it, but a margin large enough to fix it (40 µm) also stopped dense boards routing at all — one case went from five nets routed to none. So the margin defaults to zero and failures are attributed instead.
- **Only through vias** are supported in this release.
