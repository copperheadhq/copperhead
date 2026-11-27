# ADR 0005: Geometry core, contract format, process protocol

**Status:** Accepted (2026-09-06)
**RFC:** 11 Appendix C.2 items 1 to 3; §6.1; §14.1

## Evidence

Every geometric operation v1 needs (union, intersection test, distance, area, bounding box, offset, containment) is on polygons with few vertices per pad and outline; the largest board in scope has under 50 components and a few thousand copper objects. `polygon-clipping` 0.15.7 (MIT, Martinez-Rueda algorithm, robust to degeneracies through snap rounding) and `martinez-polygon-clipping` 0.8.1 (MIT) are both available on npm; `ts-json-schema-generator` 2.9.0 (MIT) generates JSON Schema from TypeScript types. kicad-tools uses `shapely` for the same operations in Python; no numerical-robustness problem was observed in its runs.

## Decision

1. **TypeScript geometry** behind `src/pcb/ir/geometry.ts` on `polygon-clipping`; distances and offsets implemented locally over its polygon type. The facade is the only module that imports the kernel, so a Rust binding can replace it if profiling on the reference boards shows a hot spot. Integer nanometres are stored as `number` (a metre is 10⁹ nm, well inside 2⁵³).
2. **JSON Schema** for manifests, jobs, and results, generated from the TypeScript types by `ts-json-schema-generator` into `schemas/pcb/*.schema.json`, committed, and checked by a test. Python wrappers validate against the same files.
3. **File-based process protocol**: `job.json` in, `result.json` out, NDJSON progress on stdout, in an isolated run directory with a scrubbed environment (implementation spec §6.3). A socket transport is added only when an engine needs one (PCBWorld-Engine would).

## Consequences

Two new runtime dependencies (`polygon-clipping`, `ts-json-schema-generator` as a dev dependency). The `check` module graph gains `src/pcb/ir` and `src/pcb/verify`, both offline and LLM-free by construction and asserted by the import-direction test.
