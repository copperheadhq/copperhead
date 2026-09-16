# Design

## D1: Materialize the referenced tree

Read the root and every transitive Sheetfile reference independently at each revision. Preserve repo-relative paths in fresh temporary directories, then invoke the existing read-only parser. A visited set bounds cycles and repeated references. Normalize backslashes before Git and path operations. Reject paths outside the repository and current symlinks that resolve outside it. Cleanup is in finally blocks.

Resolve the baseline to a commit with `git rev-parse --verify --end-of-options` before reading blobs. Use literal pathspecs for existence checks. A missing baseline root represents an empty design; a missing referenced child is an incomplete design and fails by name. Git failures become actionable command errors.

## D2: Stable semantic reporting

Preserve the original component and connection result fields, adding base, baseCommit, and nets. Compare raw value/footprint fields, then sort changed reference designators naturally. All lists use deterministic ordering.

Reuse listNets and pinNets. Infer a rename only when one removed name and one added name have the same nonempty pin membership. Keep explicit connection changes as supporting evidence. Unconnected labels remain additions/removals. This is named-net review using the existing reader, not a new electrical solver: unnamed-net connectivity, hierarchical alias resolution, reference renumbering equivalence, net merges, and constraint evaluation are outside this change.

## D3: Read-only MCP outcome

Add copperhead_diff with optional base, a read-only annotation, versioned input schema, and the shared redacted envelope. No filesystem path input, raw KiCad operation, credential, or provider call is exposed. The result data matches CLI JSON. Keep MCP tools outside the agent capability catalog.

## D4: Preview before rollback

Capture the working electrical state before any dry-run mutation, including uncommitted user work. After the existing finish gates pass, compare against the proposed working design, print the preview, and include it in the returned result and redacted transcript/summary. Restore the existing Git snapshot afterward. Preview failure goes through failure/rollback, never commit. No extra preview is emitted for refusals or failed verification.

## Verification

Exercise real single-sheet and nested open-key fixtures, historical child renames, missing roots/children, Windows separators, invalid revisions, path containment, stable ordering, and named-net inference. Drive the real CLI and MCP transport and script the actual spec-gated dry-run loop with real ERC. Run the full offline suite, typecheck, build, docs build, OpenSpec validation, and edit-sandbox commands before publishing.
