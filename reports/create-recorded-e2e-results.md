# Recorded pipeline replay verification results

Verified on 2026-10-09 with Node v24.19.0, KiCad CLI 9.0.2,
Linux and installed KiCad 9 symbols/footprints. No live inference was requested.

## Executed commands and outcomes

| Command | Observed result |
|---|---|
| `node scripts/run-recorded-create-e2e.mjs` | 5 passed, 0 failed; 74.71 seconds; supervisor exit 0 |
| `npm test -- --no-cache --reporter=dot` | 1296 passed, 0 failed, 23 skipped; 52.75 seconds; exit 0 |
| `npm run typecheck` | Exit 0 |
| `npm run build` | Exit 0 |
| `npm run lint` | Exit 0; no lint rule or ignore changes |

The ordinary suite's 23 skips are the existing 21 plus the two explicitly gated
full replays. The gated job separately executes those two cases. Counts are
separate actual runs and must not be added into one invented test total.

## Positive replay

All 29 unchanged recorded turns were consumed with exact per-stage counts:
4, 3, 3, 4, 4, 4, 4, 3. Every stage ran through real `runCreate` and the real agent
loop, dispatcher, KiCad, contracts and commits. The new workspace began with
only configuration and an empty OpenSpec workspace, plus the original brief.
No completed design artifact was imported.

The result was `ok=true`, eight completed stages, eight new distinct stage
commits, report `ran=8` and `resumed=0`, committed DEVPLAN, current output
manifest and clean working tree. Final replay HEAD: `0c0b75aebefb84e910aa7f55df3f72fb6f2c1033`.
This is a new deterministic integration run, not another fresh model inference.

## Negative controls

- The external watchdog terminated a genuinely wedged process with exit 124.
  Independent review also checked SIGTERM-resistant parent and child processes;
  SIGKILL escalation worked after the two-second grace period.
- Actual KiCad ERC reported clean on the zero-symbol scaffold, while the real
  schematic completion contract returned false.
- Omitting the final devplan reply produced `ok=false` with seven completed
  stages. The real agent loop raised recorded-provider exhaustion, rolled back
  the uncommitted plan, and made no devplan commit. Its verified tree remained
  clean at `8c1e9954a06ca95780e4b29b976461c82df52c1e`. All retained replies remained byte-identical.

The positive test asserts consumption of firmware's fourth turn, so a regression
that incorrectly accepts its earlier blocked finish cannot silently pass with
one fewer replayed turn.

## Provenance and review limits

An independent read-only review compared every one of the 29 JSON fixture files
byte-for-byte with its original cached Turn and matched all recorded provenance
hashes. No response was edited to force a pass. The original brief bytes and
SHA-256 are unchanged; it is packaged as `brief.txt` rather than changing its
bare URLs or relaxing Markdown lint. Test-only Provider injection is the sole
model substitution; no production runtime change is included in this increment.

This is sequential recorded experimental-model replay. Complete request equality
and historical tool-result equality are intentionally not asserted. The model
replies were originally produced with supplemental research and continuing
sessions. Historical prose in them is not new verification evidence. Unknown
original token usage remains unknown despite original numeric zero placeholders.

The profile requires KiCad 9 and is explicitly gated separately from the default
KiCad 10 CI environment. This result does not prove fresh supported-provider
inference, zero-error raw DRC, hardware qualification or manufacturer acceptance.
The retained four intrinsic J1 clearance findings remain disclosed.

A preliminary full-suite run had one pre-existing bad-PATH test fail because the
verification shell forced an absolute `COPPERHEAD_KICAD_CLI` override. Removing
that test-environment override, without editing or disabling the test, produced
the green full-suite result above. Preliminary lint failed on the verbatim
brief's bare URLs; renaming the captured input to `.txt` preserved its bytes and
resolved that tooling conflict without weakening rules.

## Evidence checksums

- Fixture manifest SHA-256: `36a976394ea31edea85c080b211529a989d05ab76275267620d64b0dea20c93b`.
- Final gated log SHA-256: `4946237c1f516735696363b954b1e17b5d1a0bcca78c8927b9f0db9386b9e2fe`.
- Final ordinary-suite log SHA-256: `0c361150887e4e143fc91c32b29133182a3050c93807f8a57dea5600ef0a0669`.

The executable entrypoint and environment requirements are documented in
[the integration guide](create-recorded-e2e.md). Raw original provider queues,
credentials and private absolute paths are not part of this result report.
