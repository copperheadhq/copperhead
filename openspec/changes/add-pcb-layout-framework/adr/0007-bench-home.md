# ADR 0007: The benchmark lives in this repository

**Status:** Superseded by [ADR 0012](0012-bench-split.md) (2026-09-16)
**RFC:** 11 §13, §14.1, Appendix C.2 item 10

## Decision

`bench/` in this repository, sharing the IR, adapter, checkers, and engine runner as ordinary imports, until the schemas of ADR 0005 have gone one release without a breaking change. Corpora are never committed; `bench/var/` holds clones and runs and is git-ignored. Milestone reports are committed under `bench/reports/`. A second binary, `copperbench`, is declared in `package.json` and built with the rest.

## Consequences

The bench cannot be run against a different copperhead version than the one it ships with, which is the point at this stage: a report always names the commit that produced it. Splitting out later is a move of one directory plus an npm dependency on the published package.
