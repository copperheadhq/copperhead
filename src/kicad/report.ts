export interface ViolationItem {
  description: string;
  x?: number;
  y?: number;
}

export interface Violation {
  severity: 'error' | 'warning' | string;
  type: string;
  description: string;
  sheet?: string;
  items: ViolationItem[];
}

export interface CheckReport {
  ok: boolean;
  source: 'erc' | 'drc';
  violations: Violation[];
}

interface RawItem {
  description?: string;
  pos?: { x?: number; y?: number };
}

interface RawViolation {
  severity?: string;
  type?: string;
  description?: string;
  items?: RawItem[];
}

function normViolation(v: RawViolation, sheet?: string): Violation {
  return {
    severity: v.severity ?? 'error',
    type: v.type ?? 'unknown',
    description: v.description ?? '',
    ...(sheet !== undefined ? { sheet } : {}),
    items: (v.items ?? []).map((i) => ({
      description: i.description ?? '',
      ...(i.pos?.x !== undefined ? { x: i.pos.x } : {}),
      ...(i.pos?.y !== undefined ? { y: i.pos.y } : {}),
    })),
  };
}

/**
 * Normalize kicad-cli ERC and DRC JSON reports into one shape. ERC nests
 * violations per sheet; DRC has top-level `violations` plus `unconnected_items`
 * and `schematic_parity`. Tolerant of missing fields across KiCad versions.
 */
export function normalizeReport(raw: unknown, source: 'erc' | 'drc'): CheckReport {
  const r = raw as {
    sheets?: { path?: string; violations?: RawViolation[] }[];
    violations?: RawViolation[];
    unconnected_items?: RawViolation[];
    schematic_parity?: RawViolation[];
  };
  const violations: Violation[] = [];
  for (const sheet of r.sheets ?? []) {
    for (const v of sheet.violations ?? []) violations.push(normViolation(v, sheet.path));
  }
  for (const v of r.violations ?? []) violations.push(normViolation(v));
  for (const v of r.unconnected_items ?? []) violations.push(normViolation(v));
  for (const v of r.schematic_parity ?? []) violations.push(normViolation(v));
  // `ok` gates the agent loop's repair-cycle counter and its finish() check
  // (agent/tools.ts), so it has to mean "nothing left that the agent could
  // fix" rather than "zero violations of any kind": a real board in a bare
  // checkout carries permanent library-resolution warnings (missing vendor
  // symbol/footprint libraries) that no edit can resolve. Counting those as
  // blocking would burn every repair cycle on unfixable warnings before the
  // agent ever gets to touch the actual request, and finish() would refuse
  // forever. Warning-severity violations still appear in `violations` (the
  // agent can see and act on them) — only the pass/fail gate ignores them.
  return { ok: violations.every((v) => v.severity !== 'error'), source, violations };
}

export function formatViolations(report: CheckReport): string {
  // Deliberately violations.length, not report.ok: ok is the error-severity
  // pass/fail gate (see normalizeReport), but "clean" here is a display
  // question — a warning-only report is ok yet still has something to show,
  // and hiding it behind "clean" is exactly the bug this comment prevents.
  if (report.violations.length === 0) return `${report.source.toUpperCase()}: clean`;
  const lines = [`${report.source.toUpperCase()}: ${report.violations.length} violation(s)`];
  for (const v of report.violations) {
    const where = v.sheet ? ` [sheet ${v.sheet}]` : '';
    lines.push(`  ${v.severity} ${v.type}${where}: ${v.description}`);
    for (const i of v.items) {
      const pos = i.x !== undefined ? ` @ (${i.x}, ${i.y})` : '';
      lines.push(`    - ${i.description}${pos}`);
    }
  }
  return lines.join('\n');
}
