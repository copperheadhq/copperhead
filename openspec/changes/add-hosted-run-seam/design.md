# add-hosted-run-seam: Design

## D1: the event bound is enforced where redaction already runs

`Transcript.event()` (`src/agent/transcript.ts:87`) is the single point every event passes through, and it already applies `redactSecrets` there. Putting the size bound at the same call means both write-time invariants, AC-4.1 and the size bound, are enforced on one line and cannot drift apart as callers are added.

The alternative, bounding at each call site, was rejected for the reason the original defect happened: `event()` has many callers across `loop.ts` and `create.ts`, and the pathological line came from one of them handing over a whole tool result. A rule enforced per caller is a rule that a new caller can forget.

Order matters: redact first, then bound. Redaction can only shorten a string (`[REDACTED]` is shorter than any secret it replaces), so bounding after redaction cannot reintroduce a secret at the truncation boundary, whereas bounding first could cut a secret in half and leave an unmatchable fragment that redaction then misses.

## D2: the bound is 128 KiB, chosen from measured traffic

Measured over 1106 events from real `create` runs in this repository's manual-test sandboxes:

| Percentile | Bytes |
| --- | --- |
| median | 337 |
| p90 | 6334 |
| p99 | 18042 |
| p99.9 | 20581 |
| max | 60981 |

128 KiB (131072) sits at roughly twice the largest event ever observed, so no event in that corpus would be truncated, while bounding the failure case that motivated this (a line large enough to blow a one-million-token prompt) by about an order of magnitude.

64 KiB was considered and rejected: at 65536 it leaves only seven percent of headroom over the observed maximum, which is close enough that an ordinary large capture would start truncating, and a bound that fires on legitimate traffic teaches readers to distrust it.

The number is a named constant rather than a literal, since the hosted activity log's inline payload limit has to agree with it and the platform will want to reference one definition.

## D3: truncation records what was lost, and never drops the event

An over-bound event is written with its payload replaced by a marker naming the original byte count, not discarded. Two reasons.

The transcript is an audit trail, and an event vanishing entirely is worse than an event arriving abbreviated: the run's history acquires a hole with nothing to indicate one exists. It is also the resume path's input, so a silently missing event is a silently different resume.

Recording the original size is what makes the hosted `ArtifactRef` spill implementable later. The platform's rule is that an event over the inline limit spills its body to an artifact and keeps a reference; locally there is no artifact store, so the marker is the degenerate form of the same rule. Keeping the shape identical means the hosted path adds a location to an existing marker rather than introducing a new event shape.

## D4: artifact classification is derived from version control, not declared

Which outputs survive a destroyed workspace is already decided, by whether the run commits them:

| Producer | Written to | In the board template's `.gitignore` | Therefore |
| --- | --- | --- | --- |
| `exportFab` (gerbers, drill, DXF, STEP) | `outputs/` | no | committed, reference only |
| `export bom` | `outputs/<supplier>-bom.csv` | no | committed, reference only |
| `exportSvg` | `.copperhead/renders/` | no (only `runs/` is ignored) | committed, reference only |
| `Transcript` | `.copperhead/runs/<ts>/` | yes | dies with the workspace, must be stored |
| `create` report | `.copperhead/runs/` | yes | dies with the workspace, must be stored |

Stating the rule rather than enumerating a fixed list means a producer added later classifies itself, and the classification cannot drift from reality: if a directory's ignore status changes, the classification changes with it, which is the correct outcome rather than a stale table.

One consequence worth stating rather than discovering later: the board template ignores `build/`, `fab/` and `gerbers/` under the comment "build and fabrication output, which is regenerated from the design", but the fab tool writes to `outputs/`, which none of those cover. Fabrication output is therefore committed today, which contradicts the template's evident intent. The rule above classifies by what actually happens, so gerbers are references. Whether that is the desired behaviour is a question for the template, not for this contract, and is raised in tasks rather than silently settled here.

## D5: `location` carries its own discriminant

`ArtifactRef.location` is a union of a repository coordinate and a stored-object coordinate. Narrowing it by property presence alone works in TypeScript but degrades as soon as a third backend exists, and the whole premise of freezing these types is that changing them afterwards breaks both streams. A `kind: 'repo' | 'blob'` tag inside `location`, distinct from the top-level `ArtifactRef.kind` which names the artifact's role, costs one field now and avoids a versioned type change later.

The two `kind` fields are deliberately not merged. The top-level one answers what the artifact is for (`pointer`, `derived`, `log`, `manifest`), which the console filters on; the nested one answers where its bytes are, which resolution dispatches on. A `log` is always blob-backed today, but collapsing them would encode that coincidence as a constraint.

## D6: `WritebackResult` includes a policy-skip state now

The union distinguishes an empty diff (`nothing-to-write`) from writeback being disabled for the run (`skipped-by-policy`). Whether hosted runs can disable writeback is a platform question this repository cannot answer, so this is provisional.

It is included rather than deferred because the two directions are not symmetric. Adding a state later is a cross-stream break, since stream 1 exhaustively matches the union. Carrying an unused state costs one unreachable branch. When the cost of being wrong is that asymmetric, the reversible choice wins.

## D7: the layout contract names runs, not only artifacts

`src/agent/runmeta.ts:108` computes `priorRuns` by listing `.copperhead/runs` and filtering out the current run id, so it treats every entry there as a run. The shared-path report at `src/commands/create.ts:736` already violates that assumption: `REPORT.md` and `report.json` sit beside the run directories and are each counted as a run, inflating `priorRuns` by two.

Retention makes this sharper, because deleting expired artifacts from that directory would move the same number. The contract therefore has to state which entries are runs and which are not, so a retention policy has a rule to respect and the miscount has a definition to be fixed against.

The miscount itself is not fixed here. `src/commands/create.ts:736` is currently touched by open work on the report path (#155, #149, and #251's planned change), and a fourth edit to the same lines would collide. This change states the contract that fix must satisfy and leaves the fix to whichever of those lands.

## D8: retention cannot be purely time-based

`.copperhead/runs/<ts>/` is simultaneously agent memory and an artifact source. The resume path reads a prior run's transcript; the same file is an artifact with a retention window. A retention policy that deletes on age alone can therefore delete an input a resume still depends on.

The contract states that retention is run-state aware: an artifact belonging to a run that can still be resumed is not eligible for deletion regardless of age. The mechanism is a platform concern, but the constraint originates here, because this repository is what makes the file load-bearing.
