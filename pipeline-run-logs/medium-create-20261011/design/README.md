# Final source snapshot

Generated Markdown is frozen as .md.txt to retain its original bytes without
changing historical evidence or exempting new authored reports from lint.
[snapshot-files.json](snapshot-files.json) maps every published source to its
original project path and hash, including the runtime configuration/constraints.

On a copy, run python restore-snapshot.py <new-directory> from this directory;
then run the built Copperhead CLI with --repo <new-directory> check, using the
project library tables and required installed KiCad libraries. The destination
must not exist. Restoring files does not recreate the historical Git chain.
The native draft has93 unconnected items; no fabrication acceptance follows.

Compiler outputs and exports are represented by original inventories and
hashes, not included binaries. Use the documented installed SDK/tools to build
firmware independently. Do not call a create resume on this final snapshot a
new eight-stage experiment.
