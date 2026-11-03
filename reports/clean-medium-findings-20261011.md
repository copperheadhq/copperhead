# Medium create findings

This report covers issues observed in the ordinary gpt-6.1-sol/medium run.
[Public evidence and reproduction index](../pipeline-run-logs/medium-create-20261011/README.md)
retains failed attempts, successful resumes and stage-specific summaries.

## DEFECT: selected-MPN feedback (P1)

- Where: src/memory/bom-table.ts, src/commands/create.ts; initial and resume-cli-1 logs in the evidence runtime directory.
- Symptom: UNVERIFIED prefixes in the MPN identity column produced successful agent candidate commits but failed the existing stage predicate.
- Suggested: give exact field feedback before finish, retaining qualification in Rationale and the existing predicate.
- Status: fixed with focused tests; normal model tools corrected the field. Candidate/failure records remain in the evidence index.

## INEFFICIENCY: populated reference clearance (P2)

- Where: src/kicad/populate.ts, test/board-populate.test.ts; layout stage summary and DRC boundaries.
- Symptom: library reference placement led to repeated visible silkscreen clearance repair.
- Suggested: conservative explicit --populate-references clearance, preserving pad/footprint geometry and default behavior.
- Status: implemented/tested and used by this sample; no manual board edits.

## BLOCKER: installed compiler inaccessible to firmware stage (P1)

- Where: resume-cli-3 firmware refusal; src/commands/firmware-build.ts and associated build/create tests.
- Symptom: no normal compiler capability; real refusal and rollback removed the uncommitted firmware candidate.
- Suggested: opt-in installed SDK/tools paths, fixed isolated build command, actual logs and freshness-bound receipts; no install/flash or model-supplied shell command.
- Status: implemented/tested; real firmware resume compiled twice with identical ELF/bin. Development fixture checks are not counted as medium firmware success.

## DEFECT: managed compiler outputs tracked (P2)

- Where: firmware commit91ec2b14 and test/firmware-build-ignore.test.ts.
- Symptom: ordinary commitAll tracked compiler intermediates.
- Suggested: SDK opt-in prepares an ignore rule and untracks only its managed directory, retaining files and history.
- Status: fixed/tested; a normal no-model create resume left engineering hashes unchanged and preserved the original successful commit.

## BLOCKER: candidate DEVPLAN skips final-stage review (P1)

- Where: src/commands/create.ts, src/commands/devplan.ts; test/create-devplan.test.ts; issue #66.
- Symptom: firmware wrote DEVPLAN, and file content alone made Stage8 appear complete without an independent stage commit.
- Suggested: preserve the candidate, require a matching normal devplan commit for resume, require a document change at finish, and review the actual design through the normal stage path.
- Status: fixed/tested; genuine Stage8-only resume completed at21:51:12 UTC with commit3eb8ae8eb2a6ef690754973463190f511c5b6b7f and CLI exit0. Earlier history retained; no empty commit or manual document repair.

## NOTE: draft DRC and verification scope (P2)

- Where: evidence/checks raw DRC, final hash report and skipped-case index; original draft specification.
- Symptom: native exit5 with0 violations and93 unconnected items. Offline skips do not prove other provider behavior or optional corpus coverage.
- Suggested: preserve raw exit/ratsnest and profile/hardware limits; list exact skip conditions and separate real inference from recorded regression.
- Status: disclosed. Current sources/exports/build bindings match, but full routing, fabrication, hardware qualification and complete public Git/provider provenance are not claimed. The final published test results are indexed separately after checks on this source tree.

## DEFECT: ordering rows and saved generated symbols (P1)

- Where: src/commands/outputs.ts, src/kicad/power-symbols.ts; output-profiles and generated-power-verification regressions.
- Symptom: mechanical missing-MPN rows prevented Stage6 completion; real KiCad10.0.6 upgrade produced three false generated-symbol findings.
- Suggested: exclude explicitly non-purchased/DNP ordering rows with warnings and identify remaining MPN failures; normalize only known save defaults and historical graphics while retaining full meaningful checks.
- Status: baseline ordering regressions failed2/42; fixes passed the focused99-case run. Native upgrade changed zero findings to three before the fix. These follow-ups occurred after the preserved medium run and are not represented as its original runtime code. Final validation results are linked in the evidence index.

## NOTE: normative placement and byte-preserved evidence (P2)

- Where: active fix-create-stage-evidence delta, older proposals, SPEC section2.5 and README export documentation.
- Symptom: repeated old-change additions could create duplicate requirements; export documentation sat under non-goals/license; CRLF conversion could corrupt frozen hashes.
- Suggested: keep new rules in one change, retain short references, move normative prose into the proper sections, keep byte-pinned paths as -text.
- Status: duplicate additions restored to their upstream scope; current rules remain in the follow-up. New evidence follows pipeline-run-logs convention; raw generated Markdown is text with a restore map, without a new lint exemption.
