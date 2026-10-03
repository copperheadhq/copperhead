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
  /**
   * DRC only: connections not yet routed (KiCad's `unconnected_items`). A
   * draft board legitimately leaves nets as ratsnest (SPEC §First-draft
   * layout), so they are counted and reported, never a violation (#314).
   */
  unrouted?: number;
  /**
   * DRC only: findings whose every item belongs to one footprint (a stock
   * USB-C footprint's pad 0.18 mm from its own peg hole). Placement cannot
   * move them and layout may not edit footprints, so they are reported
   * beside the result, never a failure (#314). Anything spanning two parts,
   * copper outside a footprint, a short between two nets, or a footprint
   * KiCad reports as modified or unresolvable stays a violation.
   */
  intrinsic?: Violation[];
  /**
   * ERC only: findings the schematic intent's `ercExclusions` excuse (#355),
   * each with the reason given for it. Never counted against `ok`, always
   * printed, so an exclusion is visible evidence rather than a silent pass.
   */
  excluded?: ExcludedViolation[];
  /** ERC only: declared exclusions that excused no finding (stale entries). */
  unusedExclusions?: { type: string; pins: string[]; reason: string }[];
}

export interface ExcludedViolation extends Violation {
  /** The excusing entry's reason and pins, verbatim from the intent. */
  reason: string;
  pins: string[];
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
 * and `schematic_parity`. Unrouted connections are a count, not violations:
 * `ok` means nothing routed or placed is wrong. Tolerant of missing fields
 * across KiCad versions.
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
  // A footprint KiCad cannot vouch for is never excused: one that no longer
  // matches its library was edited on the board, and one whose library KiCad
  // cannot find (`lib_footprint_issues`) was never compared at all, so what
  // lies inside either is not known to be the library's doing.
  const unvouched = new Set(
    (r.violations ?? [])
      .filter((v) => v.type === 'lib_footprint_mismatch' || v.type === 'lib_footprint_issues')
      .flatMap((v) => (v.items ?? []).map((i) => /^Footprint (\S+)/.exec(i.description ?? '')?.[1]))
      .filter((x): x is string => !!x),
  );
  const intrinsic: Violation[] = [];
  for (const v of r.violations ?? []) {
    const n = normViolation(v);
    const owner = source === 'drc' ? footprintOwner(n) : null;
    if (owner && !unvouched.has(owner) && !joinsNets(n)) intrinsic.push(n);
    else violations.push(n);
  }
  for (const v of r.schematic_parity ?? []) violations.push(normViolation(v));
  const unrouted = r.unconnected_items?.length ?? 0;
  return { ok: violations.length === 0, source, violations, ...(source === 'drc' ? { unrouted, intrinsic } : {}) };
}

/**
 * Does a finding put two different nets in contact? Only a short does: two
 * schematic nets wired onto coincident or overlapping pads of one stock part
 * is an electrical fault whichever footprint it sits in, so it is never
 * library-intrinsic. A clearance between a footprint's own pads is the
 * library's geometry even across nets (a USB-C receptacle's DP/DM pads sit
 * closer than the board rule), and placement cannot change it.
 */
export function joinsNets(v: Violation): boolean {
  return v.type === 'shorting_items';
}

/**
 * The one footprint every item of a finding belongs to, or null. KiCad names
 * a footprint's items "Pad A1 [GND] of J1 on F.Cu", "NPTH pad of J1"; a track,
 * zone, or board-edge item names none, so it never counts as intrinsic.
 */
export function footprintOwner(v: Violation): string | null {
  if (!v.items.length) return null;
  let owner: string | null = null;
  for (const i of v.items) {
    const m = /\bof ([A-Za-z#_][\w#.-]*)\b/.exec(i.description);
    if (!m || (owner !== null && m[1] !== owner)) return null;
    owner = m[1]!;
  }
  return owner;
}

export function formatViolations(report: CheckReport): string {
  const unrouted = report.unrouted ? ` (${report.unrouted} connection(s) unrouted, left as ratsnest)` : '';
  const intrinsic = report.intrinsic?.length
    ? `\n  ${report.intrinsic.length} finding(s) inside a single library footprint, not a placement problem: ` +
      report.intrinsic.map((v) => `${footprintOwner(v)} ${v.type}`).join(', ')
    : '';
  const excluded = report.excluded?.length ? `; ${report.excluded.length} finding(s) excluded by the intent` : '';
  const lines = report.ok
    ? [`${report.source.toUpperCase()}: clean${excluded}${unrouted}${intrinsic}`]
    : [`${report.source.toUpperCase()}: ${report.violations.length} violation(s)${excluded}${unrouted}${intrinsic}`];
  const pushFinding = (v: Violation, indent: string): void => {
    const where = v.sheet ? ` [sheet ${v.sheet}]` : '';
    lines.push(`${indent}${v.severity} ${v.type}${where}: ${v.description}`);
    for (const i of v.items) {
      const pos = i.x !== undefined ? ` @ (${i.x}, ${i.y})` : '';
      lines.push(`${indent}  - ${i.description}${pos}`);
    }
  };
  for (const v of report.violations) pushFinding(v, '  ');
  if (report.excluded?.length) {
    lines.push('  excluded by schematic.intent.json ercExclusions (not counted, listed for review):');
    for (const v of report.excluded) {
      pushFinding(v, '    ');
      lines.push(`      reason (${v.pins.join(', ')}): ${v.reason}`);
    }
  }
  for (const ex of report.unusedExclusions ?? []) {
    lines.push(`  note: ercExclusions entry ${ex.type} [${ex.pins.join(', ')}] excused no finding; remove it if the wiring changed`);
  }
  return lines.join('\n');
}

/**
 * The excluded findings in one line for run summaries, or '' when there are
 * none: `; 2 excluded by the intent (pin_to_pin U9.7: SA0 low selects 0x18; …)`.
 */
export function excludedSummary(report: CheckReport | null): string {
  if (!report?.excluded?.length) return '';
  const each = report.excluded.map((v) => `${v.type} ${v.pins.join('+')}: ${v.reason}`).join('; ');
  return `; ${report.excluded.length} excluded by the intent (${each})`;
}
