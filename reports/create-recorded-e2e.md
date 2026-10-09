# Recorded create pipeline integration coverage

## What runs

`test/create-recorded-e2e.test.ts` injects only a model Provider at the existing
agent-loop test seam. `runCreate`, the real agent loop, tool dispatcher,
proposal/finish gates, actual KiCad CLI, rollback and Git commits are unchanged.
The workspace begins with configuration and an empty OpenSpec directory;
the original nontrivial 500 mA brief is the sole design input. No completed
stage artifacts are copied into the workspace.

The positive case replays 29 immutable recorded model turns and requires all
eight stages in order, eight independent new stage commits, a final committed
DEVPLAN, all current completion contracts, a fresh output manifest/archive,
the final native checks and a clean working tree. The run report must say
eight ran and zero resumed. These are actual pipeline/tool checks, not mocked
ERC or DRC results.

## Runnable explicitly gated job

The current default CI installs KiCad 10. The intentionally scoped manufacturing
profile supports KiCad 9; this job must therefore run separately in a prepared
KiCad 9 environment. Do not remove the version gate or mock exports to make
this job green on another version.

Required environment: Linux, Node 20 or newer, KiCad CLI 9, installed KiCad 9
symbol and footprint libraries, configured footprint library table, Git and
the project's existing npm dependencies. The recorded footprint definitions
were exercised with KiCad 9.0.2; library changes may legitimately cause a
recorded exact-text edit or real verification to fail. No provider credential
is needed. No new dependency is introduced.

From the repository root:

```sh
npm ci
npm run typecheck
npm run build
node scripts/run-recorded-create-e2e.mjs
```

The runner explicitly sets `COPPERHEAD_TEST_RECORDED_CREATE=1`, uses an isolated
temporary root and imposes a ten-minute process-group deadline. It exits 124
on a timeout and propagates other failures. Both success and failure evidence
remain at the printed location. Archive the log, generated run reports,
transcripts and Git design repository from that location for CI review, then
remove that job's own temporary root after collecting it.

The default `npm test` run checks fixture integrity, the external timeout, and
the real empty-schematic false-green regression. It skips the two explicitly
gated full replay cases. A skipped full replay is not an end-to-end pass.

## Negative controls

- A real wedged subprocess must be terminated with timeout exit 124 by the same
  supervisor that bounds the gated job.
- Actual ERC can be clean on the generated zero-symbol scaffold. The real
  schematic completion contract must still reject it.
- In a separate replay, omit the final devplan reply without altering any saved
  response. The pipeline must fail after seven completed stages, never commit
  devplan, roll its unverified plan back, and leave the verified tree clean.

## Meaning and limits

Some recorded development-plan prose contains generic future purchasing approval,
payment-method and delivery-address instructions. It contains no filled personal
values and is retained as immutable generated prototype-plan text, not as current
contributor workflow or permission to place an order.

This is sequential recorded experimental-model replay, not exact cache-key
replay, fresh inference or proof of a supported live provider's behavior. Saved
model text may refer to historical dates or outputs; only newly executed tool
results and independently checked files establish this replay's outcome.
Fixture-integrity errors, unavailable recorded tools, exhausted recordings and
unmet completion contracts fail the test; replies are never rewritten to force
success. Full request equality and historical tool-result equality are not
asserted by this sequential replay. The model factory and all live fallbacks
are explicitly forbidden in the test.

The initial model usage was unknown. Original numeric zero placeholders remain
unchanged and must not be presented as measured historical token usage or cost.
The nonprogrammable design has a real firmware-not-applicable deliverable;
the firmware stage is retained and no dummy source file is invented.

Native placement/routing checks can retain four intrinsic J1 hole-clearance
errors separately. Passing this regression is not zero-error raw DRC,
manufacturer approval, fabrication release or physical qualification. The
pre-existing classification is not changed by this test. There is no upload,
order or external communication in this harness.

This coverage addresses the automated integration requirement in
[issue 66](https://github.com/copperheadhq/copperhead/issues/66); acceptance of
the experimental recording's provenance remains a maintainer decision.
