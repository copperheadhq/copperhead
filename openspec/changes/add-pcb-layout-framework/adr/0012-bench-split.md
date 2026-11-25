# ADR 0012: The benchmark moves to the copperbench repository

**Status:** Accepted (2026-09-16)
**Supersedes:** [ADR 0007](0007-bench-home.md)
**RFC:** 11 Appendix C.2 item 10; RFC 15

## Context

ADR 0007 put the benchmark in this repository "until the schemas of ADR 0005
have gone one release without a breaking change", and named the exit: "Splitting
out later is a move of one directory plus an npm dependency on the published
package."

Two things brought the exit forward. RFC 15 specifies CopperBench Placement as a
standard others are meant to run, and a standard that ships inside the
implementation it measures cannot be run against anything else. And copperbench
already exists as a separate public repository, holding the model-edit
benchmark, its standard, its fixtures and its paper; a second benchmark measuring
the same project belongs beside the first, not in a third place.

## Decision

`src/bench/` and `bench/` move to
[copperbench](https://github.com/copperheadhq/copperbench). copperhead no longer
declares a `copperbench` binary. The harness reaches copperhead's PCB IR,
verifiers and intent checkers through the package rather than relative imports,
and `declaration: true` is turned on here so those imports carry types. The
dependency is a `file:` link while the layout framework is unreleased, and
becomes an exact published pin when it ships.

Three things do not move, because they were never benchmark data:

1. **The engine toolchain.** Freerouting, the JRE, kicad-tools, OrthoRoute and
   pyplacer are fetched by `scripts/tools.sh` into `vendor/tools/`, and are used
   by `pcb route` and `pcb place` at runtime, not only by the benchmark.
   `toolsDirs()` still searches the legacy `bench/var/tools` so an existing
   checkout does not re-fetch 668 MB, and it searches the package root as well as
   the calling repository, which is how copperbench gets the engines.
2. **The golden microboards, as test fixtures.** Eighteen of copperhead's test
   files read them, and `expected.json` encodes the diagnostics `pcb verify` must
   raise. A frozen snapshot lives at `test/fixtures/microboards/`; copperbench
   owns the corpus and the generator.
3. **The critical-DRC fix** that `add-placement-benchmark` specified. The defect
   is in this repository's checker, so it is tracked here as
   `fix-critical-drc-keys`.

## Consequences

A benchmark report now names two versions rather than one, and copperbench
records copperhead's version and commit in every result's comparability stamp;
an internals change on this side is a suite-version event on that side. The
coupling that ADR 0007 wanted — a report always naming the commit that produced
it — is kept by the stamp instead of by co-location.

The cost is a real one: the microboards exist in two places, and a board changed
in one and not the other shows up as a test failure rather than as a merge
conflict. `test/fixtures/microboards/README.md` says so.
