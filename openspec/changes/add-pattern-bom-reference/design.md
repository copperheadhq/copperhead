# Design: Pattern-to-BOM Expansion for Part Selection

## Architecture and Flow

```text
Pattern JSON (src/kicad/patterns/<name>.json)
  │
  ▼
expandToBom helper (src/kicad/patterns/expandToBom.ts)
  │
  ▼ (expands to standard BOM rows with "from pattern: <name>" rationale)
docs/BOM.md (Standard Markdown Table)
  │
  ▼ (indistinguishable from manually written rows)
Stage 4 Drafting Engine & Schematic Intent
```

## Module Design: `src/kicad/patterns/expandToBom.ts`

The helper module exposes pure functions for transforming static pattern definitions into BOM table rows:

```typescript
export interface PatternBomRow {
  refdes: string;
  value?: string;
  footprint?: string;
  mpn?: string;
  rationale: string;
  flags: string[];
  markdown: string;
}

export interface PatternExpansionResult {
  patternName: string;
  sourceFile: string;
  headerLine: string;
  rows: PatternBomRow[];
  markdownRows: string[];
}

export function expandPatternToBomRows(
  patternName: string,
  options?: { patternsDir?: string }
): PatternBomRow[];

export function expandPatternToBom(
  patternName: string,
  options?: { patternsDir?: string }
): PatternExpansionResult;

export function resolvePatternsInBomText(
  bomContent: string,
  options?: {
    patternsDir?: string;
    onResolved?: (patternName: string, partCount: number) => void;
  }
): { text: string; resolved: Array<{ patternName: string; partCount: number }> };
```

### Conversion Logic
1. Load `src/kicad/patterns/<patternName>.json`.
2. For each part in `pattern.parts`:
   - `Refdes`: `part.ref` (e.g. `U1`, `C1`, `C2`)
   - `Value`: `part.value` (e.g. `AMS1117-3.3`, `10u`)
   - `Footprint`: `part.footprint ?? ''`
   - `MPN`: `"UNVERIFIED"`
   - `Rationale`: `"from pattern: <patternName>"`
   - `Row Markdown`: `| ${refdes} | ${value} | ${footprint} | UNVERIFIED | from pattern: ${patternName} |`
3. Generate header line:
   `| Pattern: ${patternName} | source: src/kicad/patterns/${patternName}.json |`

## Stage 3 Pipeline Integration

In `src/commands/create.ts`:
1. The Stage 3 prompt informs the model that it can declare `use pattern: <pattern-name>` for supported patterns.
2. In Stage 3 post-processing / completion checks, any `use pattern: <name>` declarations in `docs/BOM.md` are resolved into expanded rows.
3. The CLI logs:
   `Resolved pattern "<name>" -> N parts added to BOM.md`
4. Stage 4 receives the expanded `BOM.md` containing standard table rows with standard column widths and valid component values.
