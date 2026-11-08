# End-to-End Test Report — `copperhead create` (brief → clean full run)

**Issue:** #66 — Bounty: end-to-end test `copperhead create` (brief → clean full run) + findings report

## What

This PR adds a reproducible end-to-end test report for the `copperhead create`
flow, exercising the full path from a natural-language **brief** through to a
**clean full run**. It documents the exact commands, environment, observed
output, and four reproducible findings (F1–F4) with proposed fixes.

## Why

The bounty asks for a verified end-to-end run plus a findings report. This
deliverable gives maintainers a concrete, reproducible baseline and surfaces
four concrete defects with minimal repro steps, so they can be triaged directly.

## Testing

Executed on a clean checkout with the documented toolchain:

```
git clone https://github.com/copperheadhq/copperhead
cd copperhead
./copperhead create --brief "examples/brief.md" --out ./out
```

Full run completed; the report records stdout/stderr, exit codes, and the
artifacts produced under `./out`. Each finding (F1–F4) includes a minimal
reproduction and the observed vs. expected behavior.

## Findings summary

| ID | Severity | Summary |
|----|----------|---------|
| F1 | Medium   | Brief parsing drops trailing section when file lacks a final newline |
| F2 | Low      | Progress output interleaves with warnings on stderr, hurting log readability |
| F3 | Medium   | `--out` directory is not created if parent path is missing (fails late) |
| F4 | Low      | Exit code is `0` even when a non-fatal warning is emitted |

## Invariant checklist

- [x] No behavior is changed by this PR — it is documentation/report only.
- [x] All commands in the report were executed on a clean checkout.
- [x] Findings are reproducible with the minimal steps provided.
- [x] No secrets, tokens, or machine-specific absolute paths are included.
- [x] The report does not modify any source or test files.
