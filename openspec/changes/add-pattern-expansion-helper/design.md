# add-pattern-expansion-helper: Design

## Architecture

The pattern expansion helper is designed as a pure, side-effect-free function residing in `src/kicad/draft/patternExpand.ts`.

```text
src/kicad/patterns/<name>.json  ────────┐
                                        │
refPrefix / instanceId options ─────────┼──► expandPatternRef() ──► { parts, nets }
                                        │                             (ready to merge into
                                        │                              schematic.intent.json)
```

## Interface Specification

```typescript
export interface ExpandPatternOptions {
  /**
   * Prefix or naming modifier applied to all component reference designators in the pattern.
   * Example: "PWR_" turns "U1" into "PWR_U1" and "C1" into "PWR_C1".
   */
  refPrefix?: string;

  /**
   * Optional instance identifier or suffix.
   */
  instanceId?: string;

  /**
   * Optional custom directory to load pattern JSON files from (defaults to src/kicad/patterns).
   */
  patternsDir?: string;

  /**
   * Optional subsystem group override to assign to all expanded parts.
   */
  group?: string;
}

export interface ExpandedPatternResult {
  parts: IntentPart[];
  nets: IntentNet[];
}

export function expandPatternRef(
  patternName: string,
  options?: ExpandPatternOptions
): ExpandedPatternResult;
```

## Reference Renumbering & Pin Rewriting

1. **Part Renumbering**:
   - For each part in the pattern, the reference designator is transformed:
     - If `refPrefix` is provided (e.g. `"PWR_"` or `"REG1_"`), the new ref is `${refPrefix}${part.ref}` (or alphanumeric equivalent).
     - If `instanceId` is provided without a prefix, `${part.ref}_${instanceId}` is used.
     - If neither is provided, the original `part.ref` is retained.
   - If `group` is provided in options, `part.group` is updated; otherwise the pattern's default `group` is used.

2. **Net Pin Rewriting**:
   - For each net in the pattern, every endpoint `"REF.PIN"` is rewritten so that `REF` is mapped to the renumbered ref of that component.
   - Example: `"U1.3"` becomes `"PWR_U1.3"`.
   - Internal pattern nets keep their electrical properties (`name`, `kind`).

3. **Validation & Error Handling**:
   - Throws `Error` with descriptive messages if:
     - `patternName` is empty or invalid.
     - The corresponding pattern file `<patternName>.json` does not exist in `patternsDir`.
     - The pattern file contains invalid JSON or lacks required `parts`/`nets` arrays.
     - Any net endpoint references a ref not present in the pattern's `parts` list.
