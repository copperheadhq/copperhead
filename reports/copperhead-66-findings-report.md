# Copperhead 66 engineering findings report

**Eight-stage software workflow completed and independently cross-checked.** Completion time: 2026-10-09 00:11:58 UTC.

The independent 500 mA prototype reached **8/8 stages**, automatically committed its final development plan as `f3cee1a1ea`, and the actual Copperhead CLI exited **0** with a completion message. This was a **segmented, resumed run using the local experimental-native adapter**, with source fixes between attempts. Issue 66 explicitly permits multiple invocations and resume; segmented execution is not itself an acceptance gap. This run does not establish official-provider or fresh stateless-session equivalence. The separate original 3 A trial remains **2/8**.

The completed workflow produces a reviewable prototype and a plan for future physical testing. Four intrinsic J1 hole-clearance errors remain in raw KiCad DRC; no board was fabricated or bench-qualified. Native provider usage is unknown. Numeric zero counters in the logs are placeholders and do not establish zero usage or free execution.

Target: [Copperhead issue 66](https://github.com/copperheadhq/copperhead/issues/66). Base: Copperhead 0.11.0, commit `e26be947ed31a35fbbb52623174bb25017d6cd44`. Recorded environment: Node 24.19.0, KiCad CLI 9.0.2, Linux x64. Official Codex CLI startup checks used version 0.159.2 and did not succeed in this environment.

## Completion evidence and remaining review

The terminal log reports 8/8, final commit `f3cee1a1ea6a10245633b6c355de16e3bd4b097e`, and pipeline completion. `native/logs/native-500ma-devplan-v21-20261009.meta.json` records exit 0 and finish time `2026-10-09T00:11:58.344224+00:00`. An independent read-only cross-check confirmed all eight stage-completion predicates true, a fresh output manifest and a clean Git worktree; [the independent verification report](eight-stage-verification.md) records that review conclusion. The same helper metadata retains `createComplete: false`: review identified it as an initialized field that the wrapper never updated. It is a recording defect in the experimental runner, not a contradiction of the actual CLI exit-0 result or an upstream Copperhead finding. The original metadata is retained rather than silently rewritten.

The final checks verified 11 symbols with no divergences, clean ERC and document drift, and zero legibility errors with one advisory. Native DRC reported a clean placement/routing result while explicitly listing four J1 library-internal `hole_clearance` findings. The earlier independent raw KiCad check reported zero unconnected items but exit 5 for those four errors: 0.1944 mm clearance against the unchanged 0.2500 mm requirement. This is not a zero-error raw DRC result or manufacturing release.

| Stage | Completed design commit | Recorded outcome |
|---|---|---|
| 1 spec-seed | `ca57cd59f8` | Requirements and budgets committed |
| 2 architecture | `18296f0338` | Prototype architecture committed |
| 3 part-selection | `c960cbf94f` | Conditional prototype BOM committed; release qualification remains open |
| 4 schematic | `e0ae534f6a` | Schematic committed after generated-power verification fix |
| 5 layout-draft | `7852a36b5c` | Draft layout committed; zero unconnected items, four raw J1 errors retained |
| 6 outputs | `84cddb82a5` | Fresh inventory-checked, explicit KiCad 9 JLC-profile review package committed |
| 7 firmware | `0c2fb31c8f` | Evidence-backed firmware-not-applicable result committed |
| 8 devplan | `f3cee1a1ea` | Future bring-up/test plan committed; physical test rows remain NOT RUN or OPEN |

These are **local Git design commits**, not GitHub submissions. Earlier successful stages deliberately stopped at the next adapter boundary and resumed in later invocations; only the final invocation reached overall exit 0. The original 3 A / under-USD-3 brief remains a separate incomplete case, with spec-seed `f4d40b63e9` and architecture `d7594c9bd2`. The 500 mA / under-USD-8 case began independently from an empty design directory; its brief SHA-256 is `4185465cbc16b103d012147c987bb609399930448f4c6c2992116bf5cccbffde`.

The combined local submission branch now passes **1,296 tests, zero failures, 23 skips**, plus a separate explicitly gated **5/5 recorded eight-stage integration job**. The 23 skips are the prior 21 plus two gated full replays, which actually run in that separate job; counts are not added together. Typecheck, build, Markdown lint and diff checks pass. The original public runtime fixes alone passed 1,293 with 21 skips; the new result includes the replay increment.

The recorded job checks all 29 immutable response files against source bytes/hashes and exact per-stage consumption, then uses real tools, KiCad, gates and eight new commits from blank initialization. It also verifies wedge timeout, an ERC-clean empty-schematic rejection, and missing-final-response failure/rollback. It is sequential recorded experimental-model replay, not request/cache-key or historical tool-result equality, and not fresh inference. The KiCad 9 command/environment are documented; default KiCad 10 remote CI is not claimed.

The coherent `fix-create-stage-evidence` change passes official OpenSpec 1.14.1 strict validation with zero issues. The actual manual edit sandbox, real pre-commit hook, deterministic CLI checks and supplier-BOM export are recorded, and all seven contribution invariants have bounded direct evidence. Historical OpenSpec warnings, the flat canonical SPEC discovery limit, manual legibility findings and unrun optional live `do` remain disclosed. See [issue requirements](https://github.com/copperheadhq/copperhead/issues/66) for the requested software acceptance criteria.

Key evidence: `native/logs/native-500ma-outputs-v18-20261008.log`; `native/logs/native-500ma-firmware-v19-20261008.log`; `native/logs/native-500ma-devplan-v21-20261009.log` and `.meta.json`; the final design’s `.copperhead/runs/REPORT.md`, per-invocation summaries/transcripts, and `outputs/export-manifest.json`; `export-fix/combined-public-validation.json`. Selected excerpts appear in [the evidence companion](copperhead-66-evidence-excerpts.md).

## Findings

### F01 DEFECT P1 Spec-seed could commit before its own completion contract passed

- **Where:** `src/commands/create.ts`, spec-seed prompt, completion predicate, and finish-gate wiring; `test/create-spec-seed-gate.test.ts`.
- **Symptom:** The live v3 run placed genuine budgets under “Requirements and constraints.” The completion predicate required a nonempty Budget/Budgets section, but the prompt and pre-commit finish path did not enforce the same contract. The log first reported commit `232ae0b48b`, then rejected stage completion. A diagnostic copy changed only the heading and changed `isComplete` from false to true. No live design was manually patched by that reproduction.
- **Suggested:** Use the existing contract before committing, state the required heading/content in the prompt, and return a specific repair message. Preserve the existing acceptance algorithm.
- **Status:** Locally fixed in `spec-seed-contract-fix.patch`. Seventeen added regressions pass. Two key cases fail on the original source: the loop reports success and changes HEAD while `completed` stays empty. After the fix, missing/empty budgets cannot commit; a deterministic provider can repair the heading and commit exactly once in the same run. The later real Trial A spec-seed completed. Not merged.
- **Evidence:** `native/logs/native-resume-v3-20261008.log:81–84`; `native/diagnostics/spec-seed-v3/reproduction.json`; `native/logs/spec-seed-before-commit-evidence.log`; `test/create-spec-seed-gate.test.ts:218–281`; public-only full test log includes all 17 cases.

### F02 DEFECT P1 Hardware-only boards had no honest firmware completion path

- **Where:** Stage 7 in `src/commands/create.ts`; new `src/commands/firmware-applicability.ts`; `examples/simple/usb-c-breakout.md`; `test/firmware-applicability.test.ts`.
- **Symptom:** The official example explicitly has no MCU, while the original firmware stage demanded MCU/HAL artifacts and source-file presence. Real ERC-backed passive and reviewed fixed-function fixtures were rejected without unnecessary firmware files.
- **Suggested:** Retain all eight stages and allow a documented N/A stage result only with independent, populated hardware evidence. A prose claim alone must not qualify.
- **Status:** Locally fixed in `firmware-applicability.v2.patch`. The N/A path requires an exact three-field declaration with a concrete reason, a configured nonempty schematic, a closed set of reviewed symbol identities across sheets, meaningful BOM/PINOUT rows, no drift findings, and successful real KiCad ERC. Unknown/custom/unreviewed parts and programmable devices remain rejected. v2 also rejects an unexpanded angle-bracket reason template. The 34-case v2 suite passes. The live 500 mA design subsequently reached stage 7 in v19 and committed the evidence-backed N/A result as `0c2fb31c8f`; the finish gate first required a fresh drift check after a document edit, then accepted the unchanged applicability path.
- **Evidence:** `firmware/baseline-regressions.log` shows the original gate rejecting both positive N/A fixtures; `firmware/verification.json`; `src/commands/firmware-applicability.ts:28–85`; the zero-symbol, missing-evidence, hierarchy, drift, ERC and MCU negative cases in `test/firmware-applicability.test.ts`.

The separate `tps2065-exact-additive.patch`, applied after v2, adds only `Power_Management:TPS2065CDBV`. One ERC-backed positive and five nearby/custom-name negatives bring applicability coverage to 40 cases. The positive failed against v2 before that extension. The combined applicability/stage test run is **76/76 passed**. This proves the narrow applicability extension, not electrical budget compliance or hardware functionality. Evidence: `firmware/verification.tps2065.json`, `firmware/tps2065-pre-addition-regression.log`, and `firmware/REVIEW-TPS2065.md`.

### F03 DEFECT P2 Empty firmware files counted as source artifacts

- **Where:** Original stage-7 source-presence check; replacement `hasFirmwareSource` in `src/commands/firmware-applicability.ts:9–20`.
- **Symptom:** A zero-byte or whitespace-only `pins.h` in the design’s firmware directory made the original gate return true on MCU fixtures. The two corresponding regressions failed against the original source.
- **Suggested:** Require non-whitespace content in at least one supported source file; preserve the real firmware path.
- **Status:** Included in firmware v2 and covered by both empty-source negatives plus the nonempty MCU source positive. This remains an artifact-presence gate. It does not establish compilation, functional correctness, or adequate firmware implementation.
- **Evidence:** `firmware/baseline-regressions.log`; `test/firmware-applicability.test.ts:219–231`; `firmware/verification.json`.

### F04 DEFECT P2 A version-specific test depended on the host KiCad version

- **Where:** `test/board-populate.test.ts`, library-table lookup fixture.
- **Symptom:** The test created a KiCad 10 configuration directory but let runtime discovery choose the installed major, KiCad 9. The stock library lookup returned null.
- **Suggested:** Pass the existing `kicadMajor: 10` option for this deliberately KiCad-10 fixture. Keep production version discovery unchanged.
- **Status:** Test-only fix completed locally. Exact case fails before and passes after; the full file passes **44/44**.
- **Evidence:** `baseline/logs/libtable-version-repro.log`; `baseline/logs/libtable-test-before.log`; `baseline/logs/libtable-test-after.log`; `baseline/logs/board-populate-file-after.log`; `compatibility/all-test-fixture-fixes.patch`.

### F05 DEFECT P2 Fixed schematic fixtures could not load on KiCad 9.0.2

- **Where:** Fixture/reference data used by `test/draft-opamp.test.ts` and `test/draft-reference-boards.test.ts`.
- **Symptom:** Ten tests failed when real KiCad ERC could not load fixture schematics. Isolated tests identified the combination of default `in_pos_files yes` and `duplicate_pin_numbers_are_jumpers no` fields as the compatibility problem.
- **Suggested:** Keep the narrowly demonstrated default-field compatibility fix separate from product behavior changes. Preserve all non-default values and existing ERC/legibility/reference assertions.
- **Status:** Forty-four fixture/reference files changed, removing 192 default-field lines. Focused results changed from **10 failed, 1 passed** to **11 passed** with real ERC and unchanged assertions. Verified on KiCad 9.0.2 only. This is not permission to strip arbitrary fields or claim support for KiCad 8/9.0.0.
- **Evidence:** `compatibility/compat-evidence/summary.json`; `compatibility/compat-fixture-evidence/summary.json`; `compatibility/logs/fixtures-tests-before.log`; `compatibility/logs/fixtures-tests-after.log`; `compatibility/fixture-fix-statistics.json`.

### F06 INEFFICIENCY P2 The tsx test launcher required unavailable IPC

- **Where:** CLI/stdio/parity test subprocess launchers, rather than Copperhead's production verification gates.
- **Symptom:** Baseline tests encountered `listen EPERM` for the tsx wrapper's Unix listener. A second run reproduced the same restriction.
- **Suggested:** Use the supported Node preload entrypoint for the same tsx-backed test commands, avoiding the wrapper listener dependency.
- **Status:** Test harness corrected locally without opening sockets or altering security settings. The affected five test/helper files pass **28 tests**, including real MCP stdio exchange. Four new cases cover preload-flag selection; they are not multi-version runtime certification.
- **Evidence:** `baseline/logs/baseline-tests.log`; `compatibility/logs/tsx-node-import-smoke.log`; `compatibility/logs/cli-harness-tests-after.log`; combined compatibility patch.

### F07 DEFECT P2 A missing-library fixture was not deterministically empty

- **Where:** `test/create-layout-draft.test.ts`, deliberate missing-library failure fixture.
- **Symptom:** An absent global footprint table could be initialized with default content by KiCad. A test expecting pre-agent failure instead observed a mocked agent call.
- **Suggested:** Create a valid empty global table for the actual KiCad major.
- **Status:** Test-only fix completed. The exact test changes from **1 failed, 9 skipped** to **1 passed, 9 skipped**, retaining its failure/no-agent/rollback assertions. The mocked call was never evidence of a live layout stage.
- **Evidence:** `compatibility/logs/layout-test-before.log`; `compatibility/logs/layout-test-after.log`; `compatibility/layout-empty-library-fixture.patch`.

### F08 BLOCKER P1 Official Codex CLI startup remained unavailable here

- **Where:** Corrected fixed-JSON Codex CLI smoke attempt, before a Copperhead design run.
- **Symptom:** The official CLI startup attempt exited before producing a model response. No usable official-provider result or usage was recorded.
- **Suggested:** Establish a working supported provider path before claiming a reproducible official-provider run. Keep this environment failure separate from model quality or a Copperhead pipeline defect.
- **Status:** Unresolved for the official CLI in this environment. Later progress uses a local `experimental-native` test adapter, not a repaired official CLI integration. Maintainer acceptance of that substitute is unknown.
- **Evidence:** `compatibility/logs/fixed-json-smoke-corrected.result.json`, exit 1 after 8.391 seconds. The public evidence retains only the high-level outcome, not environment-access diagnostics.

### F09 BLOCKER P1 Part selection stopped on missing qualification evidence

- **Where:** Trial B, v10, stage 3; `native/logs/native-500ma-parts-v10-20261008.log:84–88` and that design's run summary `2026-10-08T20-28-22-172Z`.
- **Symptom:** Library checks found candidate symbols/footprints, but manufacturer evidence did not close current-limit margin, non-overlapping worst-case unloaded current, exact support parts, and device-to-package mapping. The model explicitly refused to freeze a BOM. Its 1.791 mA figure was an allocation, not a verified total.
- **Suggested:** Supply traceable exact-device electrical/mechanical evidence, preserve uncertainty, and resume through normal gates. Do not weaken the brief or infer electrical failure merely from missing evidence.
- **Status:** The v10 refusal was an actual evidence blocker rather than an established software defect. After v11 timed out, v12 completed conditional prototype selection and automatically committed `c960cbf94f` in 19m43s. This advancement used supplemental public component research and an explicitly recorded test-author clarification: the input calls for a reviewable prototype with physical validation pending. The model then documented a revision of its added pre-BOM guaranteed-closure sequencing rule while retaining the original electrical targets and release qualification duties. Every selected MPN remains marked UNVERIFIED for final hardware release. This is not evidence that all qualification gaps were resolved.
- **Evidence:** v10 reports `refusal recorded`; summary exit path `refused`, files touched `(none)`, and no ERC/DRC. The v12 log, run summary `2026-10-08T21-16-42-319Z`, committed `docs/BOM.md`, and `native/runs/native-500ma-parts-v12-20261008/supplement-audit.jsonl` record the later conditional selection and input clarification. Trial A separately exhausted five turns with unresolved constraints in `native/logs/native-parts-v6-20261008.log:159–165`; that is not a proof that its brief is impossible.

### F10 INEFFICIENCY P2 Experimental requests exceeded the turn timeout

- **Where:** Trial B v11 provider turn and the local adapter's timeout configuration.
- **Symptom:** v11 ended as `provider-error` after ten minutes without response/progress on a turn. Total attempt duration was 16m59s; unverified work was preserved and the tree restored. This differs from v10's deliberate refusal.
- **Suggested:** Keep request expiry, turn inactivity timeout, and hard cap consistent for the experiment; retain finite attempt limits and preserved failures. Record timing separately from product acceptance.
- **Status:** Trial-local limits were raised to 1,200,000 ms for v12. Existing deadlines were not retroactively changed. The focused adapter suite passes **56/56**, and the full experimental-inclusive suite passes **1,248 tests**. v12 subsequently completed part selection without a timeout. That one success does not isolate the timeout change as the cause: the research inputs, scope clarification, and continuing-session presentation also differed. These adapter changes are excluded from the production patch set.
- **Evidence:** `native/logs/native-500ma-parts-v11-20261008.log:107–113`; `native/logs/trial-timeout20-change.json`; `native/logs/trial-timeout20-protocol.log:16–17`; `native/logs/native-500ma-parts-v12-20261008.meta.json`.

### F11 NOTE P2 v8 has no trustworthy terminal outcome

- **Where:** Trial B architecture v8 log/metadata and architecture v9 recovery.
- **Symptom:** The v8 runtime disappeared; its preserved log stops during turn 2 and its metadata lacks a terminal exit/result. The cause is unknown. v9 later completed architecture and committed `18296f0338`.
- **Suggested:** Preserve incomplete-run records and make stage/commit recovery auditable. Do not assign a crash, cancellation, or lifecycle cause that the evidence does not establish.
- **Status:** Architecture progress recovered in v9; the v8 root cause remains unverified. The recovery demonstrates this particular continuation, not arbitrary interruption resilience.
- **Evidence:** `native/logs/native-500ma-architecture-v8-20261008.log` and `.meta.json`; v9 log lines 91–93 and run summary `2026-10-08T20-16-53-044Z`.

### F12 NOTE P3 Acceptance commands and metrics need explicit qualification

- **Where:** `package.json` scripts, skipped test records, experimental provider logs.
- **Symptom:** The issue names `npm run lint`, but this base exposes `lint:md` and no `lint` script. Recorded suites skip live-model tests. Experimental logs show numeric zero token counters while explicitly warning that physical usage is unknown.
- **Suggested:** Keep the now-integrated lint entrypoint covered by verification and label provider and live-test status on every result. Preserve unknown usage as unknown.
- **Status:** The original base and earlier four-patch combination lacked `npm run lint`, with an observed exit 1. The one-line alias is now integrated. Both the active trial tree and independent final public combination pass `npm run lint`, checking 198 Markdown files with zero issues, along with typecheck/build. The alias invokes Markdown lint only, with no changed rules or ignores; it does not add TypeScript lint. No assertion of free usage, zero physical tokens, stateless provider parity, or measured real-provider cost is supported.
- **Evidence:** `package.json`; `public-checks/verification-summary.json`; `public-checks/logs/lint.log`; `public-checks/logs/lint-md.log`; `public-checks/logs/lint-alias-candidate.log`; `power-fix/evidence/public-lint.log`; `native/logs/joint-generated-power-lint-final.log`; `native/logs/trial-timeout20-full.log:328–329`; the usage warning in every native trial log.

### F13 DEFECT P1 The verifier rejected exact power symbols generated by the drafting engine

- **Where:** Trial B schematic v13; `src/kicad/symlib.ts`, shared power-symbol templates in `src/kicad/power-symbols.ts`, and the verification response in `src/capabilities/handlers.ts`.
- **Symptom:** The populated draft passed real ERC and BOM/PINOUT drift, with zero legibility errors and one advisory, but `verify_symbols` falsely classified four engine-generated aliases as wrong-library: `copperhead_power:VBUS_RAW`, `+5V_PROTECTED`, `GND`, and `PWR_FLAG`. V13 used five accepted requests and correctly refused to claim completion while those findings remained.
- **Suggested:** Recognize only definitions that exactly match the drafting engine’s complete parsed templates, while retaining ordinary installed-library verification and failing closed on changed or counterfeit generated definitions. Preserve rail names, connectivity, and schematic bytes.
- **Status:** Confirmed and locally fixed in `generated-power-verification.v2.patch`. On the unchanged captured v13 schematic (SHA-256 `73583b1e518a445e988d26c6bcf51150fc9e05aefde8086d3ee0cab8d150f0fd`), the result changes from seven verified plus four false wrong-library findings to **11 verified, zero skipped, zero findings**. Acceptance uses full parsed-definition equality, including metadata, geometry and pins; the namespace prefix alone grants no exemption. Thirty added tests include 15 rail-mutation cases plus counterfeit-MCU, mismatched-identity and forged-PWR_FLAG negatives. The focused combined suite passes 131 tests. Fresh live v14 checks then passed and schematic committed `e0ae534f6a`, advancing Trial B to **4/8**. No rail renaming, electrical qualification or bench validation is claimed. The separately noted inherited U1 descriptive metadata was disclosed and is not changed by this patch.
- **Evidence:** `power-fix/evidence/before-verifier.json`; `power-fix/evidence/after-diagnosis.json`; `power-fix/evidence/snapshot-manifest.json`; `power-fix/evidence/result-summary.json`; `test/generated-power-verification.test.ts`; `native/logs/native-500ma-schematic-v13-20261008.log`; `native/logs/native-500ma-schematic-v14-20261008.log:44–47,124–127`.

### F14 NOTE P3 Single letter symbol search disagrees with exact pin lookup

- **Where:** Actual `search_symbols` and `symbol_pins` calls in Trial B part-selection v12, also observed in v11.
- **Symptom:** Bare searches for `R` and `C` returned no installed symbol matches and advised choosing another part. Exact `symbol_pins` calls for `Device:R` and `Device:C` succeeded in the same pipeline, returning two-pin maps for each.
- **Suggested:** Keep exact installed-library lookup evidence with the search failure, and investigate the difference before treating a negative search as proof that the component is unavailable. Do not substitute parts solely on that negative search result.
- **Status:** Observed tool-result inconsistency. Root cause and corrective implementation are unverified; no fix is claimed.
- **Evidence:** `native/logs/native-500ma-parts-v12-20261008.log:35–43`; `native/logs/native-500ma-parts-v11-20261008.log:38–44`.

### F15 DEFECT P2 Export success labels did not identify actual files

- **Where:** Original `src/kicad/cli.ts` export job construction and the real v17 `export_outputs` call; final inventory handling also updates `src/capabilities/handlers.ts`.
- **Symptom:** The exporter reported `outline.dxf` and `schematic.svg` as successful artifacts, but the DXF was a nested file under an `outline.dxf/` directory and the schematic SVG was under `renders/`. Reads at the reported names returned EISDIR and ENOENT even though real exports existed. The original success path also trusted command success without validating newly generated nonempty files.
- **Suggested:** Return actual relative file paths and sizes, verify each job’s fresh outputs, and cover directory-style DXF and multi-sheet SVG behavior without trusting stale files.
- **Status:** Fixed locally in `export-file-inventory.v2.patch`. Jobs export to fresh temporary directories; nonempty regular files and expected extensions are checked before publication. The result retains logical labels and adds an actual file inventory. Known destination conflicts are checked before replacing any job files; this does not claim transaction-atomic behavior for arbitrary I/O failure. Thirteen focused original-source cases failed, plus a separately reproduced destination-conflict regression; the final focused inventory selection passes 14 tests. Fresh live v18 exported the corrected package and committed stage 6. The final public combination includes this fix.
- **Evidence:** `native/logs/native-500ma-outputs-v17-20261008.log:59,77–80,98`; `export-fix/validation-summary.json`; `export-fix/logs/baseline-inventory.log`; `export-fix/logs/destination-conflict-red.log`; `export-fix/logs/patched-inventory-v2.log`; `native/logs/native-500ma-outputs-v18-20261008.log`.

### F16 DEFECT P2 The requested JLC profile lacked an explicit package contract

- **Where:** Original outputs prompt/completion predicate in `src/commands/create.ts`, generic fabrication jobs in `src/kicad/cli.ts`, and the separate assembly-BOM emitter. Final package implementation is in `src/commands/outputs.ts` and `src/kicad/jlc-profile.ts`.
- **Symptom:** The stage requested a JLC profile while invoking generic KiCad Gerber/drill commands; the former completion predicate only required a Gerber file. A JLC assembly-BOM format did not configure or verify fabrication exports. The observed merged drill differed from the current guide’s recommendation for separate PTH/NPTH files, but no actual vendor rejection was observed.
- **Suggested:** Use an explicit bounded profile, verify every required category and current source/file inventory, and keep vendor-format checks separate from manufacturer acceptance.
- **Status:** Fixed locally in `jlc-profile.final.patch`, layered after inventory v2. The KiCad-9-only path chooses the required layer set, checks Gerber/drill metadata, produces separate metric PTH/NPTH drills, an ordering BOM, and a verified ZIP. A hashed manifest records current sources/files; finish/resume validation rejects missing, empty, changed or stale required outputs. Fifteen original-path regressions failed; the final focused combined selection passes 107 tests. A real KiCad 9.0.2 export probe succeeded without changing the board, and live v18 committed the fresh package as `84cddb82a5`.
- **Evidence:** `jlc-fix/implementation-evidence.json`; `jlc-fix/logs/profile-red-verified.log`; `jlc-fix/logs/profile-green-final.log`; `jlc-fix/real-probe/probe-result.json`; `export-fix/combined-public-validation.json`; live v18 log and `outputs/export-manifest.json`; [JLCPCB’s KiCad 9 export guide](https://jlcpcb.com/help/article/how-to-generate-gerber-and-drill-files-in-kicad-9).

The explicit profile supports KiCad 9 only. Copper-fill zones fail closed because this implementation does not establish fill freshness; keepouts remain supported. Source hashes cover the board, schematic hierarchy, BOM, and present project files, not every external model/library dependency or `.kicad_dru`. The manifest marks manufacturer acceptance as unverified. MPN text is preserved without promoting verification status. No upload, vendor acceptance, factory release, or hardware qualification is implied. Separate OpenSpec CLI validation was unavailable at that initial fix-validation point. The later coherent submission change was validated with official OpenSpec 1.14.1 in strict mode, with one valid change and zero issues; historical warnings remain separately disclosed.

## Verified test configurations

These are actual recorded invocations, not sums of independently selected results. Different skip counts reflect different invocation scopes; they must not be merged into one headline.

| Configuration | Passed | Failed | Skipped | Evidence |
|---|---:|---:|---:|---|
| Original baseline, each of two runs | 1,108 | 23 | 21 | `baseline/logs/baseline-tests.log` and preserved original run |
| Compatibility/test-fixture fixes only | 1,135 | 0 | 21 | `compatibility/logs/final-full-suite.log` |
| Compatibility plus spec-seed, public-only | 1,152 | 0 | 21 | `native/logs/spec-seed-public-only-full.log` |
| Compatibility plus spec-seed plus firmware v2, earlier public-only run | 1,186 | 0 | 21 | `native/logs/joint-spec-firmware-v2-public-full.log` |
| Earlier four public patches including TPS2065, independently reconstructed and unfiltered | 1,192 | 0 | 21 | `public-checks/logs/full-suite.log` and `public-checks/verification-summary.json` |
| Compatibility plus firmware v2 and TPS2065 extension; spec-seed excluded, live integration explicitly excluded | 1,175 | 0 | 2 | `firmware/offline-compatible-suite.tps2065.log` |
| Combined trial tree plus TPS2065, experimental adapter included | 1,246 | 0 | 21 | `native/logs/joint-tps2065-full.log` |
| Combined trial tree after timeout change, experimental adapter included | 1,248 | 0 | 21 | `native/logs/trial-timeout20-full.log` |
| Earlier five-patch public source combination plus lint alias, no experimental adapter | **1,222** | **0** | **21** | `power-fix/evidence/public-full.log` and `.meta.json` |
| Earlier trial tree after generated-power fix, experimental adapter included | **1,278** | **0** | **21** | `native/logs/joint-generated-power-full.log` |
| Public combination after inventory v2 | 1,235 | 0 | 21 | `export-fix/logs/public-full-suite.log` |
| Final public combination including inventory v2 and JLC profile | **1,293** | **0** | **21** | `export-fix/logs/public-jlc-full-suite.log` and `export-fix/combined-public-validation.json` |

The independently executed public runtime-fix result was **1,293 passed, zero failed, 21 skipped**, across 87 files (85 passed, two skipped). The subsequently integrated submission branch, including recorded coverage, passed **1,296/0/23** and the separate gated job passed **5/5**. Experimental provider code and tests are excluded. This is a recorded complete invocation, not a sum of focused results. The 21 skips include live agent integration tests; offline green results alone do not establish live pipeline completion. The segmented live run supplies separate execution evidence. Historical experimental-inclusive totals above must not be presented as public-only results, and added test counts are not counts of product defects fixed.

The spec-seed suite exercises deterministic finish/commit behavior for one stage. Firmware tests exercise applicability and real ERC-backed fixtures. Adapter tests exercise the experimental protocol. Those suites are distinct from the completed segmented live workflow. The later recorded integration job now supplies runnable, explicitly KiCad-9-gated eight-stage coverage and the requested negative controls. It is sequential replay with the disclosed limitations, not fresh inference or an asserted remote CI result.

## Recommendations and remaining work

- **P0:** No P0 product defect is established. Keep the physical-release hold: the four raw J1 DRC errors and unperformed electrical/thermal/fault tests remain open despite software-stage completion.
- **P1:** Preserve the independently checked live result, passing recorded integration job, manual log and scoped invariant evidence. Review the documented recording provenance and scope limits alongside those results.
- **P2:** Review the production fixes as separately explained changes, retain the verified 1,296-pass combined local submission branch and separate 5/5 gated job, and rerun affected checks if the patch set changes. Preserve source/brief hashes, actual output paths, per-invocation logs and the physical-release limitations.
- **P3:** Retain the verified Markdown-lint alias, keep the R/C search inconsistency open until diagnosed, and distinguish measured, not run, not applicable, skipped and unknown results. Do not interpret placeholder token counts as cost measurements.

No new GitHub issue number is invented here. The overall work relates to [issue 66](https://github.com/copperheadhq/copperhead/issues/66). Earlier failure classes described in that issue are context, not claimed new reproductions unless evidenced above.

## Patch boundaries and evidence provenance

The final public apply order against the stated upstream base is:

1. `all-test-fixture-fixes.patch`
2. `spec-seed-contract-fix.patch`
3. `firmware-applicability.v2.patch`
4. `tps2065-exact-additive.patch`
5. `generated-power-verification.v2.patch`
6. `lint-alias-candidate.patch` (the file retains its earlier name; the alias is now integrated)
7. `export-file-inventory.v2.patch`
8. `jlc-profile.final.patch`

V2 patches replace their earlier versions; do not stack both versions. Inventory v2 precedes the JLC patch. The generated-power v2 revision removes one documentation blank line relative to v1 without runtime changes. Exact checksums and the independently executed final combination are recorded in `export-fix/combined-public-validation.json` and the evidence companion. Compatibility fixes affect tests/fixtures; the experimental provider and its tests are excluded from the public patch set.

The native trials received attributed external public research and a recorded test-author clarification that the input is a reviewable prototype with physical qualification pending. Some attempts reuse a continuing provider session and a lossless presentation of new tool results. These materially affect reproducibility: this is not a fresh stateless-provider run or evidence that the official Codex CLI integration worked. The source inputs and original execution records remain preserved.

Experiment-only adapter corrections were necessary between attempts, without changes to production stage gates for those corrections. They are excluded from the public patch set and are not counted as upstream product defects. Physical usage remains unknown. The final report’s zero-token counters and resumed-stage accounting are not cost measurements for the entire multi-invocation workflow.

The latest live outcome is Trial A 2/8 and Trial B 8/8 with final CLI exit 0 at 2026-10-09 00:11:58 UTC. The independent completion cross-check and the stale experimental-wrapper `createComplete: false` field are explained above. Stage 7 now has a real evidence-backed N/A commit; stage 8 supplies a future test plan, not performed tests. No fabrication, hardware qualification or vendor acceptance is established by these software results.

Evidence aliases identify artifact groups without machine-specific paths:

- `native/`: `copperhead-native-trial-20261008`
- `baseline/`: `copperhead-trial-20261008`
- `compatibility/`: `copperhead-trial-20261008-round2`
- `firmware/`: `firmware-applicability-evidence`
- `public-checks/`: `public-patch-verification-20261008`
- `power-fix/`: `copperhead-generated-power-fix-20261008`
- `export-fix/`: `copperhead-export-inventory-fix-20261008`
- `jlc-fix/`: `copperhead-jlc-profile-fix-20261008`
- Bare `src/`, `test/`, `examples/` and design-document paths are repository relative. Source line references in historical findings identify the inspected version; later patches may shift them.

Each real invocation has a matching design `.copperhead/runs/<timestamp>/summary.md` and `transcript.jsonl`. Historical refusals, interruptions and boundaries remain evidence of those attempts, not successful runs. The final `.copperhead/runs/REPORT.md` lists seven resumed stages and the final executed devplan stage. The relative evidence locations identify the preserved runs underlying these technical conclusions.
