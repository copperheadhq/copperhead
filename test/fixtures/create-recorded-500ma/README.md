# Recorded 500 mA pipeline fixture

These 29 JSON files are unchanged cached model turns from the separately
recorded 500 mA experiment. The manifest records the exact SHA-256 of every
file, its original cache key, request/response provenance hashes, stage and
recorded attempt. No generated design checkpoint is included. The original
brief is preserved byte-for-byte as `brief.txt` and hash-checked. Its filename
only distinguishes captured input from authored Markdown; no lint rule is
relaxed and its original bare URLs are not rewritten.

The experiment used the experimental-native model boundary, supplied public
research and prototype-scope clarification, and continuing model sessions.
It originally completed across multiple attempts. The chosen successful stage
recordings are v7, v9, v12, v14, v16, v18, v19 and v21. They contain 29 turns in
total. Prior failed attempts are not silently relabeled as successful fixtures.

This is sequential recorded-response replay. It does not assert that new
requests have the same full cache keys as the historical requests. The recorded
model statements are historical text, not fresh inference about the newly
generated files. Actual tool results, KiCad checks, file inventories and commits
are generated and checked again by the test. Historical prose or timestamps
inside an unchanged model reply are not used as current verification evidence.

The zero counters in these original Turn objects were interface placeholders;
the experiment's physical token usage and cost were unknown. The replay returns
the Turn objects unchanged. It makes no live inference call, but does not turn
historical unknown usage into measured zero usage.

Do not edit a recorded reply to make a replay pass. If source or library changes
make it inapplicable, preserve the failure and deliberately version a new
recording with its own real provenance. The negative final-stage test omits the
last reply as an explicitly synthetic fault injection; it never changes a reply.
