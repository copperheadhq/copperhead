# Copperhead eight stage completion verification

Evidence checked on 2026-10-09, 00:15–00:17 UTC. This is a read-only functional audit of the independent protected USB-C 500 mA prototype case.

## Conclusion

The evidence supports actual completion of all eight software pipeline stages in the same design repository, followed by a successful final CLI invocation. The final design commit is `f3cee1a1ea6a10245633b6c355de16e3bd4b097e`; the v21 CLI exited **0** at **2026-10-09 00:11:58 UTC**. All eight current stage-completion contracts were independently re-evaluated and returned true. Git was clean before and after the audit, and tracked file hashes were unchanged.

This is **segmented completion using the experimental-native adapter and locally patched Copperhead**, with supplied research and resumed model sessions. It is not evidence of a fresh, uninterrupted eight-stage run through an official supported provider. It also does not establish zero-error raw DRC, manufactured hardware, physical qualification or manufacturer acceptance.

## Case identity and committed artifacts

- Design repository name: `native-500ma-spec-v7-20261008`.
- Input: `briefs/usb-c-500ma-protected-v1.md`, a separate 500 mA, under-USD-8 component-budget prototype brief.
- Brief SHA-256: `4185465cbc16b103d012147c987bb609399930448f4c6c2992116bf5cccbffde`.
- Initial commit `83eaca80ce32d216b3460929a5e593d99ee1f0fb` contains configuration and ignore rules, not a pre-completed design.
- Every commit below has a matching successful pipeline transcript with a successful finish-gate result, matching run-committed hash and done terminal state. Each commit contains the relevant deliverable. Extra resume bookkeeping commits were not counted as additional stages.

| Stage | Distinct stage commit | Verified deliverable |
|---|---|---|
| spec-seed | `ca57cd59f88d033dd65c47d556eaa427c69868df` | docs/SPEC.md and constraints |
| architecture | `18296f033848ffd3e9fe52e0782902b1413070d4` | docs/SUBSYSTEMS.md |
| part-selection | `c960cbf94f4347b1c36ed2f12fe96d8a235a3762` | docs/BOM.md |
| schematic | `e0ae534f6afa48b8c29ec5dc35ef6296951d2ba2` | Nonempty .kicad_sch, schematic.intent.json and PINOUT.md |
| layout-draft | `7852a36b5c6b666ac9a16701663464e3a2c7a243` | .kicad_pcb and docs/LAYOUT.md |
| outputs | `84cddb82a522a5033b1a1606d132a85b04296f53` | Gerbers, separate drills, ZIP, BOM, DXF, STEP, SVG and manifest |
| firmware | `0c2fb31c8fb6088baff27e9915484bb45e737d04` | firmware/README.md and docs/FIRMWARE.md |
| devplan | `f3cee1a1ea6a10245633b6c355de16e3bd4b097e` | docs/DEVPLAN.md |

Firmware is a genuine hardware-only applicability result: no programmable components, and a concrete explanation of the passive/analog design. No dummy firmware source or fabricated compilation was counted. The development plan explicitly leaves physical tests and procurement open.

The earlier 3 A, under-USD-3 case is a separate repository (`native-specseed-v2-20261008`) with only specification and architecture completed. Its commits and partial results were not combined with this case.

## Independent final-state checks

- All eight exported `STAGES[].isComplete` checks returned true on the final design. These include the current schematic/intent, footprint/pad correspondence, layout, output-package and hardware-only applicability contracts.
- A fresh deterministic `runCheck` returned `ok=true`: ERC zero violations, drift zero mismatches, constraints zero violations, legibility zero errors and one retained advisory; score 91.38/100. No legibility families were disabled or suppressed.
- Fresh symbol verification checked 11 definitions with zero findings and zero skipped definitions.
- Native placement/routing DRC reported zero blocking violations, zero unrouted connections and four separately reported intrinsic footprint findings.
- Direct KiCad DRC independently returned **exit 5 and four error-severity J1 hole-clearance findings**: actual 0.1944 mm versus the configured 0.2500 mm clearance. It reported zero unconnected items and zero schematic-parity findings. Therefore “native gates passed” must never be shortened to “raw DRC has zero errors.” This intrinsic-finding classification is unchanged from the source base's report-normalization implementation.
- The final standalone OpenSpec CLI field was null, not a separately verified global OpenSpec CLI pass. Stage transcripts record the proposal-validation/tool-unlock checks and successful finish gates.

## Output freshness and archive integrity

The final `outputsPackageGap` check returned null. Independently recomputed hashes match all **four recorded inputs** and **18 manifest-listed output files**. The recorded inputs are the PCB, root schematic, BOM.md and present .kicad_pro. These inputs, the manifest and manufacturing ZIP are unchanged between the stage-6 commit and final HEAD, so firmware and development-plan edits did not stale this package.

Python's independent ZIP reader verified all CRCs and exact bytes/names for **11 manufacturing entries**: nine Gerbers and separate PTH/NPTH drill files. They match the current manifest inventory. Unrelated retained files are not part of this manufacturing ZIP.

- Profile: `jlcpcb-kicad9-2026-09-24`; KiCad CLI 9.0.2; no copper-fill zones.
- Manifest SHA-256: `20830b98f767d7226227e26cdf709bbe89cb82a1f3dc97b0598551e3cd4c86c1`.
- Manufacturing ZIP SHA-256: `a6ce0b3c7e6d661dde3518dc094a8b85ad02aee736cbcadeba713b17c5e96873`.
- Freshness covers recorded inputs, not all possible external libraries or 3D-model dependencies. Local settings and archive checks are not manufacturer acceptance or fabrication release.

## Segmentation and model evidence

The preserved new-case records span v7 through v21. Earlier attempts include deliberate stage boundaries, failures and incomplete terminal records. The final report correctly says **one stage ran and seven resumed**; its 11m42s duration is the final development-plan invocation, not total project effort.

The eight successful stage logs are v7, v9, v12, v14, v16, v18, v19 and v21. Their successful transcripts match the eight Git commits above. All 49 accepted request/response records across the new case passed the adapter's canonical request, message, tool and response hash/binding checks during this audit. This supports consistent recorded execution; these local hashes are not independent third-party attestation of provider provenance.

Supplied public research, prototype-scope clarification and continuing-session presentation are recorded conditions of the experiment. Local source fixes were integrated during the attempts. The metadata's sourceCommit identifies the upstream base `e26be947ed31a35fbbb52623174bb25017d6cd44`, not a clean, immutable snapshot of the complete patched runtime. The devplan/dev-plan identifier correction before v21 is an experimental adapter fix, not an upstream product defect.

Numeric token counters are placeholders. Physical usage and cost are unknown; zero must not be described as measured free or zero-token execution.

## Why the wrapper says createComplete false

The preserved v21 metadata contains `createComplete:false` together with `exitCode:0`. In `run-native-trial.py`, line 49 initializes createComplete to false; the script never updates that field. Lines 91–99 capture the real child exit code and preserve it through cleanup. This is a wrapper bookkeeping defect, not evidence that the CLI failed.

The underlying CLI log independently records successful finish, final commit, 8/8 stages, final checks and complete termination. The ledger's cancelled status occurs after that terminal result to close outstanding consumers; its recorded reason is cleanup. Neither metadata nor source was edited to make the evidence agree.

## Evidence locators

These are relative technical evidence names, not published web links:

- `logs/native-500ma-devplan-v21-20261009.log`, especially lines 99–111: finish, final commit, 8/8 count, retained J1 findings and pipeline completion.
- Corresponding `.meta.json`: final child exit code and finish timestamp.
- Design `.copperhead/runs/report.json`: eight stages, one ran, seven resumed.
- Each successful stage's `.copperhead/runs/<run-id>/transcript.jsonl` and `summary.md`: proposal/tool checks, finish outcome and actual committed hash.
- The locally preserved experimental execution records and supplement/presentation audit: hash consistency was checked; raw model requests and responses are intentionally not reproduced in this report.
- Design Git history, `outputs/export-manifest.json`, `outputs/jlcpcb.zip`, `firmware/README.md` and `docs/DEVPLAN.md`: durable artifact evidence.

Final CLI log SHA-256: `b057c9da21df00897c23d3d2aaa05b1cab12e4e1c810201875b372bf32f559ab`.

Final metadata SHA-256: `fbb09d2b24e6170faac1a4321d247ac9239b80a76a7008718e750fdd9cbd2df5`.

This audit found consistent evidence of actual patched-pipeline execution and durable artifacts. It does not convert the run into an unmodified-upstream, single-shot supported-provider acceptance test, or establish physical design safety. The four raw J1 errors and all documented fabrication/bench qualification holds remain open.
