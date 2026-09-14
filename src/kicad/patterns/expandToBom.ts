import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BomRow } from '../../memory/bom-table.js';

export interface PatternPart {
  ref: string;
  libId: string;
  value: string;
  footprint?: string;
  group: string;
}

export interface PatternDefinition {
  name: string;
  description: string;
  parts: PatternPart[];
  nets: Array<{
    name: string;
    pins: string[];
    kind?: 'power' | 'ground' | 'signal';
  }>;
}

export interface PatternBomRow extends BomRow {
  rationale: string;
  markdown: string;
}

export interface PatternExpansionResult {
  patternName: string;
  sourceFile: string;
  headerLine: string;
  rows: PatternBomRow[];
  markdownRows: string[];
}

export interface ExpandToBomOptions {
  patternsDir?: string;
}

export interface ResolvePatternsOptions extends ExpandToBomOptions {
  onResolved?: (patternName: string, partCount: number) => void;
}

function resolvePatternsDir(override?: string): string {
  if (override) return override;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return here;
}

/**
 * Loads a pattern JSON from the patterns directory and returns its parsed content.
 * Throws a descriptive error if the pattern does not exist.
 */
export function loadPatternDefinition(patternName: string, patternsDir?: string): PatternDefinition {
  const dir = resolvePatternsDir(patternsDir);
  const patternPath = path.join(dir, `${patternName}.json`);

  if (!existsSync(patternPath)) {
    throw new Error(`Pattern "${patternName}" not found at ${patternPath}`);
  }

  const raw = readFileSync(patternPath, 'utf8');
  const parsed = JSON.parse(raw) as PatternDefinition;
  return parsed;
}

/**
 * Expands a named pattern into an array of typed BOM rows with Markdown formatting.
 */
export function expandPatternToBomRows(
  patternName: string,
  options?: ExpandToBomOptions,
): PatternBomRow[] {
  const pattern = loadPatternDefinition(patternName, options?.patternsDir);
  const rationale = `from pattern: ${pattern.name}`;

  return pattern.parts.map((p) => {
    const footprint = p.footprint ?? '';
    const mpn = 'UNVERIFIED';
    const markdown = `| ${p.ref} | ${p.value} | ${footprint} | ${mpn} | ${rationale} |`;

    return {
      refdes: p.ref,
      value: p.value,
      footprint: footprint || undefined,
      mpn,
      rationale,
      flags: ['UNVERIFIED'],
      markdown,
    };
  });
}

/**
 * Expands a named pattern and returns a full expansion result including the header line.
 */
export function expandPatternToBom(
  patternName: string,
  options?: ExpandToBomOptions,
): PatternExpansionResult {
  const pattern = loadPatternDefinition(patternName, options?.patternsDir);
  const rows = expandPatternToBomRows(patternName, options);
  const sourceFile = `src/kicad/patterns/${pattern.name}.json`;
  const headerLine = `| Pattern: ${pattern.name} | source: ${sourceFile} |`;
  const markdownRows = rows.map((r) => r.markdown);

  return {
    patternName: pattern.name,
    sourceFile,
    headerLine,
    rows,
    markdownRows,
  };
}

/**
 * Matches pattern declarations in text, such as:
 *   use pattern: voltage-regulator-ams1117
 *   | use pattern: voltage-regulator-ams1117 |
 *   | Pattern: voltage-regulator-ams1117 |
 */
const PATTERN_REF_REGEX = /^\s*(?:\|\s*)?(?:use\s+)?pattern:\s*([a-zA-Z0-9_-]+)(?:\s*\|)?\s*$/i;

/**
 * Resolves pattern references in BOM.md markdown text by expanding them in-place.
 */
export function resolvePatternsInBomText(
  bomContent: string,
  options?: ResolvePatternsOptions,
): { text: string; resolved: Array<{ patternName: string; partCount: number }> } {
  const lines = bomContent.split(/\r?\n/);
  const newLines: string[] = [];
  const resolved: Array<{ patternName: string; partCount: number }> = [];

  for (const line of lines) {
    // Avoid re-expanding an already expanded header line that contains "source:"
    if (line.includes('source:')) {
      newLines.push(line);
      continue;
    }

    const match = PATTERN_REF_REGEX.exec(line);
    if (match) {
      const patternName = match[1]!;
      try {
        const expansion = expandPatternToBom(patternName, options);
        newLines.push(expansion.headerLine);
        for (const rowMd of expansion.markdownRows) {
          newLines.push(rowMd);
        }
        resolved.push({ patternName: expansion.patternName, partCount: expansion.rows.length });
        options?.onResolved?.(expansion.patternName, expansion.rows.length);
        continue;
      } catch (err) {
        // If pattern name is unknown or fails to load, keep line and let validation/caller handle it
        newLines.push(line);
        continue;
      }
    }

    newLines.push(line);
  }

  return {
    text: newLines.join('\n'),
    resolved,
  };
}
