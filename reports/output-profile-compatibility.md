# Output profile compatibility follow-up

Local candidate based on `41eeaa5e2e8835f91c07ef04c5f073b753b1e4ff`, with original
upstream base `e26be947ed31a35fbbb52623174bb25017d6cd44`. This report records new
software checks separately from the historical 500 mA experiment. No new live
provider run, medium design, DRC repair or hardware validation was performed.

## Behavior

`export_outputs` and create Stage 6 default to `outputProfile: generic`; omission
has the same meaning. Generic mode keeps ordinary `exportFab` command arguments,
supports copper zones and board-only exports, and records profile settings and
zone fills as unverified. It inventories the board's manufacturing layers,
requires real nonempty outputs from every configured job, and records current
source/file hashes plus `fabrication.zip`. The ZIP contains only the board's
manufacturing copper layers (including inner copper), mask, silk, paste, outline
and drill files. Technical layers, job metadata and drill maps remain on disk and
in the raw manifest inventory but stay out of the ZIP. Both X2 metadata and
canonical legacy filenames are covered by the archive-selection regressions.
UTF-8 basenames and spaces are
preserved in generic ZIPs, with traversal/control/duplicate/device-name checks
and the existing bounded archive limits retained.

An absent or incomplete ordering BOM is an explicit generic-export warning.
It does not block the board exports and cannot complete create Stage 6. Full
Stage 6 still requires Gerbers/drill, DXF, STEP, board/schematic SVGs, valid
ordering BOM and archive. One Gerber, a stale file, a partial board-only export
or a copied legacy file set cannot establish completion.

Set `"outputProfile": "jlcpcb-kicad9-2026-09-24"` in `.copperhead/config.json` for
the strict JLC profile. Its version, copper-fill/keepout, layer, format and
separate-drill checks remain intact. No `--check-zones` or `--refill-zones` flags
are introduced and no KiCad 10 JLC/fill verification is claimed. Explicit-profile
failure never falls back. Unknown profile values fail.

The selected profile must match the manifest. A profile switch or missing legacy
manifest requires `export_outputs` to run again. Completion checks remain
read-only; failed exports invalidate earlier success. Generic success is file
inventory/integrity evidence, distinct from JLC settings/package checks, and
neither is manufacturer acceptance or fabrication release.

The historical replay harness now explicitly selects the JLC profile. All 29
saved response files, their manifest/cache keys/hashes and the brief remain
byte-for-byte unchanged. That harness still has the real pipeline, empty
schematic, wedged-process and missing-final-stage controls. Its historical 5/5
result is not validation of this new candidate or of the generic default.

## Executed checks (2026-10-09)

Environment: Ubuntu 24.04.5 x86-64, Node 24.21.0, npm 12.2.0, Vitest 3.2.7,
Git 2.43.0 and Python 3.12.3. Existing lockfile dependencies were installed
locally with scripts disabled; package manifests/lockfiles are unchanged.
Verified official KiCad PPA packages and Ubuntu dependencies were extracted into
separate workspace roots. KiCad 10.0.6 and 9.0.9 use process-only library/config
paths. No system installation, kernel configuration or global library-table
change was performed.

| Check | Pristine HEAD | Local candidate |
| --- | --- | --- |
| KiCad 10.0.6 full suite, one worker, same environment | 1296 passed / 0 failed / 23 skipped | 1340 passed / 0 failed / 23 skipped |
| Typecheck / build / Markdown lint | pass | pass |
| Focused offline contracts | 101/101 | 145/145 |
| KiCad 9.0.9 focused contracts | not repeated | 145 passed (145) |
| Real KiCad 10 output acceptance | not repeated separately | 7/7 groups |
| Real KiCad 9 default/JLC output acceptance | not repeated separately | 9/9 groups |
| Recorded replay and controls under 9.0.9 | not repeated | 5 passed (5) |
| Historical recorded reply hashes | 29/29 | 29/29 unchanged |
| OpenSpec 1.14.1 follow-up strict | no findings | no findings |
| OpenSpec Phase 1 default / strict | pass / 3 legacy warnings | same |

Real output checks exercise the handler, CLI and Stage 6 against disposable
variants of the small existing fixture: complete/default, inner copper,
board-only, copper zones, keepouts, explicit profile rejection, source/file
freshness, missing manifests, profile switches and a genuinely failed export.
The synthetic BOM is test input, not ordering evidence. Zone-fill correctness,
manufacturer acceptance and hardware safety remain unverified; no new medium
or live provider run was made.

On KiCad 10.0.6 the board-only fixture actually has no schematic or BOM
(`schematic: null`): the real handler succeeds with 26 inventoried files while
Stage 6 remains incomplete. The copper-zone fixture has one top-level F.Cu zone
on net 0, with a polygon and fill settings, no keepout and no stored
`filled_polygon`; it exports 28 inventoried files without changing board bytes.
A separate keepout fixture also passes. These checks establish export and
evidence behavior for those inputs, not correctness of connected-net pours,
existing/stale fills, complex zones or footprint-contained copper zones. No
zone checking/refilling flags were executed. Successful CLI startup alone is
not the basis for this scoped compatibility result.

The 23 full-suite skips include 19 live-provider cases, two separately gated
recorded cases, one optional Claude Code case and one optional corpus case.
KiCad 9 did not receive another full-suite run; KiCad 8 was covered only by
mocked process-boundary version strings. This is local evidence, not a green
GitHub CI claim or provider parity. Historical replies were recorded using
9.0.2; the 9.0.9 replay and libraries are explicitly a different environment,
not a reproduction of historical byte outputs or original physical usage.

A first parallel full-suite attempt lost its execution transport. Its partial
logs have no successful conclusion. Readable journal records did not establish
an OOM cause; kernel-buffer access was denied. Subsequent CAD tasks ran serially
and suites used one worker. A forced CLI override initially interfered with a
PATH-failure control; it was removed and both full suites were rerun under the
same final environment. Interrupted and failed logs are retained privately.

Earlier missing-CAD runs had 40 matching failures. Installing the isolated
runtime resolves their normal-path test environment, but does not erase the
separately reproduced existing edit-probe exception bookkeeping defect: if a
loadability probe throws after writing, a change can remain unregistered. That
fault path was reproduced on both versions without a success commit and is not
changed by this output compatibility patch.

The official OpenSpec CLI was pinned to 1.14.1 in local tooling, with scripts
and telemetry disabled. Follow-up strict validation has no findings; Phase 1
retains the same three historical warnings. The flat SPEC.md layout is not
recognized as canonical capability directories, so no archive or monolithic
spec certification is claimed. No tasks are marked complete solely from these
partial acceptance results.

## Original evidence handoff

The preserved publication candidate has now been received and verified locally:
95 files, archive size 111,349 bytes, SHA-256
`6bfd7170085ed8c29f449c70d7d26ac3568bd188ca8da8d4b61371ee19346fd4`.
See [the receipt](native-500ma-evidence-receipt.md) and
[the unchanged source inventory](evidence/native-500ma-20261009/README.md).
All package hashes and published derivative hashes match. Eight supplied stage
commit IDs match their filtered commit/terminal events; v16 raw DRC has four
error-severity hole-clearance findings and zero unconnected items. Its board
hash agrees with the supplied final tracked-PCB inventory. This does not turn
that invocation into a final audit or a zero-error raw DRC result.

The files are original-byte records, filtered derivatives and explicitly new
source-side audit extractions, distinguished by the dual-hash manifest. The
receiver did not obtain private Git objects, raw provider payloads or the final
PCB bytes, and cannot independently re-audit those withheld sources. The
supplied audit's 49 accepted bindings are not independent provider attestation.
No standalone original raw ERC, final-audit raw DRC or complete immutable
per-stage runtime snapshot is supplied. Two interrupted attempts still lack
summaries and terminal records. Historical KiCad9.0.2 live evidence stays
separate from the later 29-turn replay and current9.0.9/10.0.6 regression checks.

No private preservation archive, review notes, system logs or July substitute
logs are included in the public evidence directory. The existing probe-exception
bookkeeping defect remains disclosed above. Normal-path tests passing do not
resolve that fault path, the four raw DRC findings, manufacturer acceptance or
bench qualification.
