# Receipt of preserved 500 mA live-run evidence

The publication candidate is in [evidence/native-500ma-20261009](evidence/native-500ma-20261009/README.md).
Its 95 files were copied without changing their bytes. The received archive was
111,349 bytes with SHA-256
`6bfd7170085ed8c29f449c70d7d26ac3568bd188ca8da8d4b61371ee19346fd4`.
This receipt records a new static inspection, not a rerun of the live experiment.

## Integrity and inclusion

ZIP CRC, duplicate/path/symlink checks, all 94 entries in SHA256SUMS, all 88
source-derived published hashes/sizes and all five authored-audit hashes passed.
Of the 88 source-derived files, ten match the recorded original hashes and sizes;
78 are explicitly filtered/redacted derivatives. Original and published hashes,
line selections and transformations remain in the supplied provenance manifest.
The manifest's own hash is in SHA256SUMS; no recursive self-hash was invented.

The set retains all 15 v7–v21 CLI log/metadata pairs, 20 preserved summaries,
22 filtered lifecycle/verification event files, the final stage report, original
v15/v16 raw DRC reports, runtime hash manifests and labelled audit extractions.
Failed and interrupted attempts remain visible. No July logs, later replay
outputs, private preservation archive, raw provider payloads, private research,
Chinese review notes or host/system logs are included in this evidence directory.

The 20 filtered summary records retain their recorded multiple blank lines.
A path-specific markdownlint-cli2 ignore covers only those immutable records;
authored documentation remains linted, and all evidence hashes remain checked.

The receiver parsed 31 JSON and 22 JSONL files. An all-file pattern scan found
no credential-token/private-key/Bearer, email, private absolute-path or signed-URL
matches. This is a bounded scan and content review, not a guarantee that every
possible sensitive string is detectable.

## What can be cross-checked here

Eight distinct stage commit IDs in the supplied Git extraction match eight
published run-committed events and their done terminal events. Each event
file's recorded original transcript hash also matches the proof-chain entry.
The extracted final design HEAD is
`f3cee1a1ea6a10245633b6c355de16e3bd4b097e`. The final CLI metadata records exit0;
the final report records eight stages, one run and seven resumed. The wrapper's
contradictory createComplete:false remains unchanged and is explained in the
source README; it is not silently repaired.

The v16 raw DRC bytes match the recorded raw-report hash. They report KiCad9.0.2,
exit5, four error-severity hole_clearance violations (0.2500 mm configured versus
0.1944 mm actual) and zero unconnected items. The invocation's board hash agrees
with the extracted final tracked-PCB inventory. This is the preserved v16
invocation, not a newly executed final audit. Schematic parity was not explicitly
requested. The final native gate's intrinsic-footprint classification and clean
ERC statement must not be shortened to zero raw DRC errors or independent raw
ERC evidence.

The supplied source-side adapter audit reports 49 accepted records and three
cancelled requests across 15 runs, with no listed binding issues. This receiver
can check that audit's integrity and consistency; it cannot repeat the binding
hash audit without the withheld request/response payloads. Likewise, the private
Git objects and final PCB bytes were not delivered in this public candidate, so
this is a cross-check of the supplied extraction and events, not a new inspection
of the original design Git repository or an independent rehash of that PCB.

## Limits that remain

This was segmented execution through an experimental-native adapter and locally
patched source, with supplied research and resumed sessions. It is not a fresh,
uninterrupted run through an officially supported provider. Token/cost usage
is unknown; preserved zero counters are placeholders, not free usage evidence.

No standalone original raw ERC JSON, original final-audit raw DRC JSON or complete
immutable per-stage source/build/dependency/binary/library snapshot was located
by the source-side inventory. Two interrupted runs lack summaries and terminal
records. Historical hashes and partial source recovery do not reconstruct the
whole runtime, and a present-day worktree must not stand in for it.

The historical live environment is KiCad9.0.2 with Node24.19.0. The separate local
compatibility validation uses KiCad9.0.9/10.0.6 and Node24.21.0; the immutable
29-turn replay, its new 9.0.9 result, and these original live derivatives are
separate evidence sets. Manufacturer acceptance, bench qualification and the
four raw DRC findings remain unresolved. The existing edit-probe exception
bookkeeping defect disclosed in [output-profile-compatibility.md](output-profile-compatibility.md)
remains disclosed even though normal-path offline tests now pass.
