# Copperhead 66 selected evidence excerpts

**Evidence companion for the completed segmented run.** Terminal completion: 2026-10-09 00:11:58 UTC. Independent terminal cross-check completed.

The numbered lines below are selected from preserved source logs. Historical sections describe earlier attempts. The terminal completion sections below document the resumed eight-stage result; this file does not establish manufacturer or maintainer acceptance. Machine-specific workspace prefixes are replaced with `<workspace>`; text is otherwise retained. Run labels are artifact identifiers, not claims of completion.

## E01 Real spec seed contradiction

Source: `native/logs/native-resume-v3-20261008.log`.

```text
L81:   [finish] all gates satisfied; run will commit
L82: committed 232ae0b48b (1 file(s))
L84: stage spec-seed: the run finished but the stage completion contract is not met — no usable artifact was produced; exhausted 0 auto-retry(ies). Stopping for a human.
```

## E02 Original source deterministic regression

Source: `native/logs/spec-seed-before-commit-evidence.log`.

```text
L5: OLD_PATH_EVIDENCE {"initialHead":"0399bb27a32166a880dbb1feda9be1d3249694ae","currentHead":"93abdd5143c8e96502bf64e81c461016d08ced70","loopOutcome":"success","loopCommit":"93abdd5143c8e96502bf64e81c461016d08ced70","completed":[]}
L8: OLD_PATH_EVIDENCE {"initialHead":"5f382d21cc669d5aeba7bcbec21872d425f163f0","currentHead":"81afddbff2943ff1ca1f06e7aa1db081e6416040","loopOutcome":"success","loopCommit":"81afddbff2943ff1ca1f06e7aa1db081e6416040","completed":[]}
L47:       Tests  2 failed | 15 skipped (17)
```

## E03 Later successful spec seed

Source: `native/logs/native-resume-v4-20261008.log`.

```text
L62: committed f4d40b63e9 (3 file(s))
L64: pipeline so far: 1/8 stages · 7m06s · 0 out tokens · 0% cache hits
```

## E04 Trial A progress and failure

Source: `native/logs/native-architecture-v5-20261008.log`.

```text
L73: committed d7594c9bd2 (5 file(s))
L75: pipeline so far: 2/8 stages · 10m12s · 0 out tokens · 0% cache hits
L81: run failed: provider error: EXPERIMENTAL_STAGE_BOUNDARY: part-selection is outside this trial's bound stage; no request queued
L86: stage part-selection: the run ended as "failure" (provider-error): provider error: EXPERIMENTAL_STAGE_BOUNDARY: part-selection is outside this trial's bound stage; no request queued; exhausted 0 auto-retry(ies). Stopping for a human.
```

## E05 Trial A unresolved part selection

Source: `native/logs/native-parts-v6-20261008.log`.

```text
L159: run failed: turn budget exhausted (5 turns, 4 files touched but unverified)
L164: turn-budget-exhausted · ERC not run · 27m11s · 0 in / 0 out
L169:    (2 stage(s) already complete are detected from repo state and skipped; it resumes at part-selection.)
```

## E06 Trial B spec seed

Source: `native/logs/native-500ma-spec-v7-20261008.log`.

```text
L140: committed ca57cd59f8 (7 file(s))
L142: pipeline so far: 1/8 stages · 17m21s · 0 out tokens · 0% cache hits
```

## E07 Trial B architecture recovery

Source: `native/logs/native-500ma-architecture-v9-20261008.log`.

```text
L91: committed 18296f0338 (5 file(s))
L93: pipeline so far: 2/8 stages · 11m03s · 0 out tokens · 0% cache hits
L99: run failed: provider error: EXPERIMENTAL_STAGE_BOUNDARY: part-selection is outside this trial's bound stage; no request queued
L104: stage part-selection: the run ended as "failure" (provider-error): provider error: EXPERIMENTAL_STAGE_BOUNDARY: part-selection is outside this trial's bound stage; no request queued; exhausted 0 auto-retry(ies). Stopping for a human.
```

## E08 Trial B refusal

Source: `native/logs/native-500ma-parts-v10-20261008.log`.

```text
L85:   [finish] refusal recorded; run will end
L86: refused: Part-selection acceptance is blocked by architecture.selection_gate, power.unloaded_vbus_current_ma, and libraries.identity_and_mapping. The supplied 1.791 mA allocation is not a verified total; MIC2544-2YM programming-current inclusion/bounds and guaranteed current-limit margins remain unresolved. Installed TPS2051CDBV/TPS2041B symbols do not establish electrically qualified alternatives. Exact support-part leakage, resistor temperature behavior, capacitor suitability, LED evidence, and manufacturer package/connector correspondence are also not closed. No accepted BOM was written and no candidate is declared electrically noncompliant merely for lack of evidence. Resume with accessible exact-device manufacturer data covering supply/terminal currents, threshold and fault conditions, and mechanical drawings, then complete the fixed-format per-refdes BOM, cost accounting, pin/footprint checks, and documentation updates without relaxing any requirement. No schematic, PCB, firmware, or physical-test completion is claimed.
L87: refused · ERC not run · 10m11s · 0 in / 0 out
```

## E09 Trial B timeout

Source: `native/logs/native-500ma-parts-v11-20261008.log`.

```text
L107: run failed: provider turns timed out 1× (no response or progress for 10m00s each)
L108: working tree restored to pre-run snapshot
L109: failed work preserved: git stash entry "copperhead failed run 2026-10-08T20-48-03-753Z" (8453f767e5); recover with `git stash apply`, discard with `git stash drop`
L112: provider-error · ERC not run · 16m59s · 0 in / 0 out
```

## E10 Original firmware gate regressions

Source: `firmware/baseline-regressions.log`.

```text
L5:    × firmware applicability stage > accepts documented passive hardware without any source file 16ms
L7:    × firmware applicability stage > accepts only the explicitly reviewed fixed-function MIC2544-2YM 9ms
L36:    × firmware applicability stage > does not count a zero-content pins.h as firmware (0) 7ms
L38:    × firmware applicability stage > does not count a zero-content pins.h as firmware (1) 9ms
L105:       Tests  4 failed | 29 skipped (33)
```

## E11 TPS2065 reproduction

Source: `firmware/tps2065-pre-addition-regression.log`.

```text
L7:    × firmware applicability stage > accepts the exact reviewed TPS2065CDBV with real ERC and coherent docs 23ms
L70:       Tests  1 failed | 39 skipped (40)
```

## E12 Public only combined suite

Source: `native/logs/joint-spec-firmware-v2-public-full.log`.

```text
L320:  Test Files  81 passed | 2 skipped (83)
L321:       Tests  1186 passed | 21 skipped (1207)
```

## E13 Latest experimental inclusive suite

Source: `native/logs/trial-timeout20-full.log`.

```text
L328:  Test Files  83 passed | 2 skipped (85)
L329:       Tests  1248 passed | 21 skipped (1269)
```

## E14 Experimental protocol suite

Source: `native/logs/trial-timeout20-protocol.log`.

```text
L16:  Test Files  2 passed (2)
L17:       Tests  56 passed (56)
```

## E15 Firmware and TPS2065 compatible suite

Source: `firmware/offline-compatible-suite.tps2065.log`.

```text
L296:  Test Files  80 passed | 1 skipped (81)
L297:       Tests  1175 passed | 2 skipped (1177)
```

## E16 Original baseline suite

Source: `baseline/logs/baseline-tests.log`.

```text
L1006:  Test Files  8 failed | 70 passed | 2 skipped (80)
L1007:       Tests  23 failed | 1108 passed | 21 skipped (1152)
```

## E17 Compatibility fixed suite

Source: `compatibility/logs/final-full-suite.log`.

```text
L292:  Test Files  79 passed | 2 skipped (81)
L293:       Tests  1135 passed | 21 skipped (1156)
```

## E18 Official provider outcome

The official Codex CLI startup attempt ended without a usable model result. Public reporting retains this high-level limitation; environment-access diagnostic details are not included. The eventual live workflow used the separately disclosed experimental adapter.

## E19 Experimental usage warning

Source: `native/logs/native-500ma-parts-v12-20261008.log`.

```text
L1: stage spec-seed: already complete (resuming past it)
L2: stage spec-seed: committed already-complete work f1020fe8e1 so a later rollback cannot wipe it (2.4)
L3: stage architecture: already complete (resuming past it)
L4: stage part-selection: running
L5: experimental-native: physical token usage is unknown/unreported; numeric counters are interface placeholders, not measured usage.
```

## Additional metadata checks

- The corrected official Codex smoke result records exit 1, 8.391 seconds, and empty event, tool-attempt, final-message, and usage arrays: `compatibility/logs/fixed-json-smoke-corrected.result.json`.
- The v8 architecture metadata has no terminal exit or finish fields; its log stops during turn 2. That record does not identify why the runtime disappeared: `native/logs/native-500ma-architecture-v8-20261008.meta.json`.
- The later v9 architecture summary reports outcome `success`, exit path `done`, stage 2/8, 3/5 turns, and 11m03s: Trial B `.copperhead/runs/2026-10-08T20-16-53-044Z/summary.md`.
- The v10 summary reports exit path `refused` and no files touched: Trial B `.copperhead/runs/2026-10-08T20-28-22-172Z/summary.md`.
- The timeout-change record sets turn inactivity and hard limits from 600,000 ms to 1,200,000 ms, with the new request TTL maximum also 1,200,000 ms. It records no changes to old request deadlines or real documents: `native/logs/trial-timeout20-change.json`.
- V12 metadata records exit 1 at 21:36:26 UTC with `createComplete: false`, after part selection succeeded and the next-stage boundary stopped the command. Its stage summary records `success`, `done`, 3/5 turns and 19m43s; its ledger has three issued and three accepted requests. Evidence: `native/logs/native-500ma-parts-v12-20261008.meta.json`, `native/runs/native-500ma-parts-v12-20261008/ledger.json`, and Trial B `.copperhead/runs/2026-10-08T21-16-42-319Z/summary.md`.
- V13 ran five accepted requests and ended refused on the four generated-power findings; it did not complete stage 4. After the source fix, v14 ran four accepted requests and completed schematic, committing `e0ae534f6a`. Fresh verification returned 11 verified symbols, no divergences, clean ERC/drift, and zero legibility errors with one advisory. V15 layout then started at 22:14:50 UTC with a 22:54:50 UTC deadline; no fifth-stage completion is recorded at this snapshot.
- The firmware v2 record contains 70 targeted passes, including 34 applicability tests. The TPS2065 record contains 76 targeted passes, including 40 applicability tests, with typecheck/build/diff-check passing: `firmware/verification.json` and `firmware/verification.tps2065.json`.

## Patch checksums

| Patch | SHA 256 |
|---|---|
| `spec-seed-contract-fix.patch` | `559b67081f6bdf6d5b4ce6765bc9eb88fd1432b8b4de533308467074e1dabcf5` |
| `firmware-applicability.v2.patch` | `e0771d8cb118e93eaed49072839ee7a3e8cdb71828a1028c65e415a004d230a6` |
| `tps2065-exact-additive.patch` | `08bf75319d134bd7a8f5a08239df97ec39f55023e469442973905f948c80ada7` |
| `generated-power-verification.v2.patch` | `4ccd12b93d3b3cc2d4ba1001301df4d1720391e8701764d50ba0770ecd802bac` |

V2 replaces the earlier firmware patch. The TPS2065 patch is additive after v2. The experimental adapter is outside these three patches.

Evidence alias definitions are in [the findings draft](copperhead-66-findings-report.md#patch-boundaries-and-evidence-provenance).

## E20 Trial B part selection completed

Source: `native/logs/native-500ma-parts-v12-20261008.log`.

```text
L178:   [finish] all gates satisfied; run will commit
L179: committed c960cbf94f (10 file(s))
L180: done · ERC not run · committed c960cbf94f · 19m43s · 0 in / 0 out
L181: pipeline so far: 3/8 stages · 19m43s · 0 out tokens · 0% cache hits
L182: stage schematic: scaffolded empty KiCad project (protected-usb-c-500-ma-power-breakout-independent-prototype-test-brief.kicad_sch + board + project), wired into config
L188: run failed: provider error: EXPERIMENTAL_STAGE_BOUNDARY: schematic is outside this trial's bound stage; no request queued
```

## E21 Prototype scope and evidence qualification

V12 supplement audit, 21:17:26 UTC, records a test-author clarification that the original brief is a reviewable prototype with physical validation pending. It preserves the original electrical targets, requires uncertainty/validation obligations to remain explicit, and requires transparent documented decisions for changes to model-added assumed criteria. This is an experimental input disclosure, not maintainer acceptance. Source: `native/runs/native-500ma-parts-v12-20261008/supplement-audit.jsonl`.

The committed `docs/BOM.md` identifies ten unique fitted references and marks every MPN UNVERIFIED for final hardware release. The stage summary records a documented revision of the model-added pre-BOM guaranteed-closure sequencing rule; all original targets, original software gates and physical qualification obligations remain. Its actual drift check was vacuously clean because no schematic was configured; no ERC/DRC, legibility or score pass was recorded. Source: Trial B `.copperhead/runs/2026-10-08T21-16-42-319Z/summary.md` and `docs/BOM.md` at commit `c960cbf94f`.

## E22 Continuing session limitation

Some experimental attempts reused a continuing provider session and supplied only a lossless presentation of newly returned tool results. External research and prototype-scope clarification were also disclosed inputs. This method is not proof of fresh stateless-provider equivalence, official Codex CLI operation or measured token usage. Original execution records are preserved separately; raw adapter protocol or queue contents are not included here.

## E23 Intermediate schematic checks and generated aliases

Source: `native/runs/native-500ma-schematic-v13-20261008/presentation-delta-3.json`, actual tool-result content.

```text
verify_symbols: 7 verified, 0 unverifiable (library not installed), 4 issue(s) to reconcile:
  - [wrong-library] "copperhead_power:+5V_PROTECTED" names the wrong library, not the wrong part: use power:+5V instead.
  - [wrong-library] "copperhead_power:GND" names the wrong library, not the wrong part: use power:GND or Device:Crystal_GND2 instead.
  - [wrong-library] "copperhead_power:PWR_FLAG" names the wrong library, not the wrong part: use power:PWR_FLAG instead.
  - [wrong-library] "copperhead_power:VBUS_RAW" names the wrong library, not the wrong part: use power:VBUS instead.
ERC: clean
legibility: 0 error, 1 advisory finding(s) across 1 sheet(s):
  1. [advisory] low-utilization @ / (148.59, 93.35) refs: / — content occupies 0.29 of the usable frame (threshold 0.5); paper "A" would fit this content
drift: clean
```

The actual draft result also records four groups, 32 wire segments and seven no-connects, establishing a populated draft rather than an empty-schematic ERC result. This preserves the original pre-fix observation. The subsequent confirmed fix and successful fourth-stage rerun appear below. No physical qualification follows from these checks.

## E24 Negative short search with successful exact lookup

Source: `native/logs/native-500ma-parts-v12-20261008.log`.

```text
L35:   [search_symbols] no installed symbol matches "R" (searched every library in: /usr/share/kicad/symbols). The part is not capturable on this machine as named — choose a part whose symbol exists, or a same-family variant that does.
L36:   [search_symbols] no installed symbol matches "C" (searched every library in: /usr/share/kicad/symbols). The part is not capturable on this machine as named — choose a part whose symbol exists, or a same-family variant that does.
L42:   [symbol_pins] Device:R — 2 pin(s), 1 unit(s):
L43:   [symbol_pins] Device:C — 2 pin(s), 1 unit(s):
```

This preserves the discrepancy without attributing a cause or claiming a fix.

## E25 Independent full public patch verification

Source: `public-checks/verification-summary.json`, `public-checks/results.json`, and `public-checks/logs/full-suite.log`. The public combination contains the compatibility, spec-seed, firmware v2 and TPS2065 patches. It excludes experimental-native files and uses unmodified test configuration with no test filters or exclusions.

```text
L306:  Test Files  81 passed | 2 skipped (83)
L307:       Tests  1192 passed | 21 skipped (1213)
```

Typecheck and build exited 0. `npm run lint:md` exited 0 with 198 Markdown files and zero issues. The unmodified public combination’s `npm run lint` exited 1 because no such script exists. The separate one-line alias candidate maps `lint` to `npm run lint:md`; its command exited 0, without changing rules/ignores or adding TypeScript lint. At that earlier four-patch snapshot, the candidate was separate and its full suite had not been rerun. It is now integrated and covered by the final runs below. Evidence: `public-checks/logs/typecheck.log`, `public-checks/logs/build.log`, `public-checks/logs/lint.log`, `public-checks/logs/lint-md.log`, `public-checks/logs/lint-alias-candidate.log`, and `public-checks/lint-alias-candidate-result.json`.

The 21 skips comprise 19 live agent-integration tests, one optional-dependency test, and one corpus-report test: `public-checks/skipped-tests.json`.

## E26 Generated power verifier repair on unchanged schematic bytes

Sources: `power-fix/evidence/snapshot-manifest.json`, `power-fix/evidence/before-verifier.json`, `power-fix/evidence/after-diagnosis.json`, and `power-fix/evidence/result-summary.json`.

- Captured schematic SHA-256: `73583b1e518a445e988d26c6bcf51150fc9e05aefde8086d3ee0cab8d150f0fd`
- Before: seven verified, zero skipped, four wrong-library findings
- After, same schematic bytes: 11 verified, zero skipped, no findings
- All four generated definitions match the exact engine template
- 30 new tests; 131 focused combined tests passed
- 15 rail-mutation negatives plus counterfeit-MCU, wrong-identity and forged-PWR_FLAG cases remain rejected
- Full parsed definitions, including metadata, geometry and pin details, are compared; no prefix-only bypass and no rail renaming
- V2 removes one documentation blank line relative to the first patch; runtime code is unchanged

## E27 Successful schematic rerun

Source: `native/logs/native-500ma-schematic-v14-20261008.log`.

```text
L44:   [verify_symbols] verify_symbols: 11 symbol(s) match the installed libraries or exact engine power templates. No divergences.
L45:   [run_erc] ERC: clean
L46:   [check_legibility] legibility: 0 error, 1 advisory finding(s) across 1 sheet(s):
L47:   [check_drift] drift: clean
L92:   [check_drift] drift: clean
L122:   [check_drift] drift: clean
L124: committed e0ae534f6a (9 file(s))
L125: done · ERC clean · committed e0ae534f6a · 9m08s · 0 in / 0 out
L127: pipeline so far: 4/8 stages · 9m09s · 0 out tokens · 0% cache hits
L134: run failed: provider error: EXPERIMENTAL_STAGE_BOUNDARY: layout-draft is outside this trial's bound stage; no request queued
```

The v14 ledger records four issued and four accepted requests. The stage report totals 9m09s; the agent completion line is 9m08s. The following deliberate layout boundary still exits the overall command with code 1, so this remains partial 4/8 progress.

## E28 Final public and experimental test runs

Source: `power-fix/evidence/public-full.log` and `power-fix/evidence/public-full.meta.json`; the metadata explicitly records `containsExperimentalNative: false`.

```text
L318:  Test Files  82 passed | 2 skipped (84)
L319:       Tests  1222 passed | 21 skipped (1243)
```

The current experimental-inclusive trial tree is a separate run, `native/logs/joint-generated-power-full.log`:

```text
L317:  Test Files  84 passed | 2 skipped (86)
L318:       Tests  1278 passed | 21 skipped (1299)
```

Both configurations passed typecheck, build and the now-integrated `npm run lint` alias. The public lint log checks 198 Markdown files with zero issues. This remains Markdown lint, without a claim of TypeScript lint. Sources: `power-fix/evidence/public-typecheck.meta.json`, `public-build.meta.json`, `public-lint.meta.json`, `public-lint.log`, and `native/logs/joint-generated-power-lint-final.log`.

## E29 Earlier v15 layout attempt

V15 launch metadata records 22:14:50 UTC start and 22:54:50 UTC deadline. Its launch log records deterministic placement of ten footprints on 13 nets, unrouted, with the outline grown to 30 × 23 mm. The first four stages were recognized as complete. This establishes initial setup for stage 5, not completion. At that earlier point, a placement/routing batch produced five DRC violations. This is historical evidence; the later v16 result below supersedes its completion status while retaining the raw intrinsic findings. Sources: `native/logs/native-500ma-layout-v15-20261008.log` and `.meta.json`.

Earlier v15 layout check, same log:

```text
L72:   [run_drc] DRC: 5 violation(s)
```

## E30 Layout stage completed with raw intrinsic errors retained

Source: `native/logs/native-500ma-layout-v16-20261008.log`.

```text
L22:   [run_drc] DRC: clean (26 connection(s) unrouted, left as ratsnest)
L23:   [run_erc] ERC: clean
L24:   [check_drift] drift: clean
L52:   [run_drc] DRC: clean
L53:   [run_erc] ERC: clean
L54:   [check_drift] drift: clean
L87:   [check_drift] drift: clean
L108:   [run_drc] DRC: clean
L109:   [run_erc] ERC: clean
L110:   [check_drift] drift: clean
L112: committed 7852a36b5c (8 file(s))
L113: done · ERC clean · DRC clean · committed 7852a36b5c · 11m25s · 0 in / 0 out
L115: pipeline so far: 5/8 stages · 11m28s · 0 out tokens · 0% cache hits
L121: run failed: provider error: EXPERIMENTAL_STAGE_BOUNDARY: outputs is outside this trial's bound stage; no request queued
```

V16’s ledger records four issued and accepted requests. The stage total is 11m28s. `native/runs/native-500ma-layout-v16-20261008/presentation-delta-3.json` preserves the full native DRC result: its stage-specific clean result separately lists four J1 `hole_clearance` findings inside one library footprint. Committed `docs/LAYOUT.md` and the v16 readback document the independent raw KiCad result: zero `unconnected_items`, exit 5, four errors at 0.1944 mm against the unchanged 0.2500 mm constraint. These intrinsic findings remain uncorrected and unwaived. This is a reviewable draft-stage result, not manufacturing clearance.

## E31 Export success labels and actual paths differ

Source: `native/logs/native-500ma-outputs-v17-20261008.log`.

```text
L59:   [export_outputs] produced: gerbers, drill, outline.dxf, board.step, board.svg, schematic.svg
L77:   [read_file] error: EISDIR: illegal operation on a directory, read
L80:   [read_file] error: ENOENT: no such file or directory, open '<design>/outputs/schematic.svg'
```

Read-only file inspection confirms the real DXF is `outputs/outline.dxf/protected-usb-c-500-ma-power-breakout-independent-prototype-test-brief-Edge_Cuts.dxf`; the schematic SVG is `outputs/renders/protected-usb-c-500-ma-power-breakout-independent-prototype-test-brief.svg`. The relevant source is `src/kicad/cli.ts:394–409`, not the top-level `src/cli.ts`. The exporter has real files but reports names that are not their actual paths. At that historical v17 snapshot the path-reporting fix was pending and no sixth-stage commit existed. Inventory v2 and the JLC profile were later integrated, and v18 committed stage 6 as recorded below.

The source also uses generic Gerber/drill commands (`src/kicad/cli.ts:397–398`) while the stage prompt promises a JLC profile (`src/commands/create.ts:314`). The JLC assembly-BOM emitter (`src/commands/export.ts:81–89`) does not configure those exports. The [current JLCPCB KiCad 9 guide](https://jlcpcb.com/help/article/how-to-generate-gerber-and-drill-files-in-kicad-9), updated September 24, recommends separate PTH and NPTH drill files. The observed mixed-plating drill deviates from that recommendation. No actual vendor rejection or acceptance was established. The earlier profile gap was subsequently addressed by the bounded local profile and tests recorded below, without a manufacturer-acceptance claim.

## E32 Final stages and terminal completion

### Outputs stage

Source: `native/logs/native-500ma-outputs-v18-20261008.log`.

```text
L84: committed 84cddb82a5 (7 file(s))
L88: pipeline so far: 6/8 stages · 8m03s · 0 out tokens · 0% cache hits
```

### Firmware applicability stage

Source: `native/logs/native-500ma-firmware-v19-20261008.log`.

```text
L74: committed 0c2fb31c8f (5 file(s))
L76: pipeline so far: 7/8 stages · 6m52s · 0 out tokens · 0% cache hits
```

### Development plan and complete workflow

Source: `native/logs/native-500ma-devplan-v21-20261009.log`.

```text
L34:   [verify_symbols] verify_symbols: 11 symbol(s) match the installed libraries or exact engine power templates. No divergences.
L35:   [run_erc] ERC: clean
L36:   [run_drc] DRC: clean
L37:   [check_drift] drift: clean
L38:   [check_legibility] legibility: 0 error, 1 advisory finding(s) across 1 sheet(s):
L79:   [check_drift] drift: clean
L94:   [verify_symbols] verify_symbols: 11 symbol(s) match the installed libraries or exact engine power templates. No divergences.
L95:   [run_erc] ERC: clean
L96:   [run_drc] DRC: clean
L97:   [check_legibility] legibility: 0 error, 1 advisory finding(s) across 1 sheet(s):
L98:   [check_drift] drift: clean
L100: committed f3cee1a1ea (4 file(s))
L102: pipeline so far: 8/8 stages · 11m42s · 0 out tokens · 0% cache hits
L105:   4 finding(s) inside a single library footprint, not a placement problem: J1 hole_clearance, J1 hole_clearance, J1 hole_clearance, J1 hole_clearance
L111: create pipeline complete; all checks green
```

The final run metadata records `exitCode: 0` and `finishedAt: 2026-10-09T00:11:58.344224+00:00`, while also retaining `createComplete: false`. Independent review identified the false helper flag as an initialized-but-never-updated wrapper field. It does not negate the actual CLI exit 0 and completed stage checks; the original metadata remains preserved. The final `.copperhead/runs/REPORT.md` lists seven resumed stages and devplan executed in this invocation. The terminal log’s zero counters are explicitly unmeasured provider placeholders, not usage or cost evidence.

## E33 Inventory and explicit JLC package fixes

- `export-file-inventory.v2.patch`: `dba2e648f6c20fa629a576e62e3c268d28d06a828ba1283d3b87f8b7e3293251`
- `jlc-profile.final.patch`: `6a32c487163e3de678cdb2593b5e12bf8792726cb3a5319cce30d9243482e87a`

Inventory evidence records 13 failing original-path cases and an additional failing destination-conflict regression, followed by 14 focused inventory passes. The JLC evidence records 15 original-path failures, 107 final focused passes and a successful real KiCad 9.0.2 export with the board unchanged. Sources: `export-fix/validation-summary.json`, `jlc-fix/implementation-evidence.json`, and `export-fix/combined-public-validation.json`.

Fresh live v18 exports include actual relative paths, separate PTH/NPTH drills, an ordering BOM, `jlcpcb.zip` and `export-manifest.json`. The profile validates file/source freshness within its stated scope, rejects unsupported KiCad versions and copper-fill zones, and explicitly marks manufacturer acceptance as unverified. Source freshness does not cover every external library/model dependency or `.kicad_dru`.

## E34 Final independent public combination

Source: `export-fix/logs/public-jlc-full-suite.log`.

```text
L322:  Test Files  85 passed | 2 skipped (87)
L323:       Tests  1293 passed | 21 skipped (1314)
```

`export-fix/combined-public-validation.json` confirms that experimental provider code/tests are excluded, and typecheck/build/Markdown lint passed. Lint checked 198 files with zero issues. The exact eight-file patch apply order is retained there. This suite is independent of the segmented live run; its skipped live tests do not establish full automated live coverage.

## E35 Final independent checks and experimental limitations

Independent read-only review confirmed final commit `f3cee1a1ea6a10245633b6c355de16e3bd4b097e`, all eight stage-completion predicates true, a fresh output manifest and a clean Git worktree. Fresh raw KiCad DRC still returned exit 5 with four intrinsic J1 hole-clearance errors and zero unconnected items. The [independent verification report](eight-stage-verification.md) preserves this conclusion without replacing the underlying raw evidence. That result remains a physical-release limitation.

The helper’s retained `createComplete: false` is an initialized-but-never-updated recording field in the experimental wrapper. It does not override the actual CLI exit-0 result. Experiment-only adapter corrections are excluded from the public patch combination and upstream findings. The multi-invocation run used experimental-native, supplemental public research and some continuing sessions. No fresh single-invocation official-provider equivalence, measured zero usage or manufacturer release is established.

## E36 Combined local submission verification

The final local branch integrates public fixes, the recorded-response test increment and coherent OpenSpec change. Its actual commands passed: `npm test` (1,296/0/23), `node scripts/run-recorded-create-e2e.mjs` (5/5), typecheck, build, Markdown lint, scoped strict OpenSpec validation and diff checks. See [submission-validation.md](submission-validation.md), [recorded integration results](create-recorded-e2e-results.md), [manual-test-log.md](manual-test-log.md), and [invariant-evidence.md](invariant-evidence.md).

All 29 recorded turns were verified against source bytes/hashes, with exact stage consumption. Replay is sequential, not request/tool-result matching or fresh inference. The optional live-provider tests and default remote CI are not asserted as passed. Three historical strict-warning cases and the flat SPEC discovery limit remain separate from the clean new-change validation.

The actual documented edit sandbox exercised setup, init, the real commit hook, check and supplier-BOM export. Its retained legibility finding and missing-MPN exclusions are recorded; the optional live `do` command was not rerun. Bounded independent review found all seven contribution invariants preserved within the patch scope.
