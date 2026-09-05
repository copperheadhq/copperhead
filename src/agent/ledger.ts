/**
 * Sync-obligations ledger (design D13). Deterministic post-tool-call hooks
 * record obligations; the commit gate refuses while any is open. This is what
 * turns "keep everything in sync" into a mechanical gate instead of a prompt.
 */
export type ObligationKind =
  | 'erc'
  | 'drc'
  | 'drift'
  | 'legibility'
  | 'changelog'
  | 'decision-log'
  | 'affects-revisit';

export interface Obligation {
  kind: ObligationKind;
  detail: string;
  openedBy: string;
}

export class ObligationsLedger {
  private open: Obligation[] = [];

  /**
   * @param gateLegibility whether error-severity legibility findings block
   * `finish`. True for repos whose schematic copperhead authored (create
   * origin) — there the standard is copperhead's own responsibility. False for
   * hand-drawn repos (`do` on an init-ed or hand-maintained project), where a
   * pre-existing sheet could never satisfy the standard without a full redraw
   * and the obligation would wedge every schematic-touching run; those repos
   * get the same findings as advisory information via the tool and `check`
   * (design C6: check reports, create gates).
   */
  constructor(private readonly gateLegibility = true) {}

  add(kind: ObligationKind, detail: string, openedBy: string): void {
    if (!this.open.some((o) => o.kind === kind && o.detail === detail)) {
      this.open.push({ kind, detail, openedBy });
    }
  }

  /** Returns true if at least one obligation was actually removed. */
  clear(kind: ObligationKind, detail?: string): boolean {
    const before = this.open.length;
    this.open = this.open.filter(
      (o) => !(o.kind === kind && (detail === undefined || o.detail === detail)),
    );
    return this.open.length < before;
  }

  /** Open obligations of one kind, for building corrective tool errors. */
  openOfKind(kind: ObligationKind): readonly Obligation[] {
    return this.open.filter((o) => o.kind === kind);
  }

  /** A KiCad edit re-opens verification obligations even if previously cleared. */
  onKicadEdit(file: string): void {
    this.add('erc', 'ERC must pass after schematic edits', file);
    if (file.endsWith('.kicad_pcb')) this.add('drc', 'DRC must pass after board edits', file);
    if (file.endsWith('.kicad_sch') && this.gateLegibility) {
      this.add('legibility', 'check_legibility must run clean after schematic edits', file);
    }
    this.add('drift', 'check_drift must run clean after KiCad edits', file);
    this.add('changelog', 'CHANGELOG.md entry for this run', file);
  }

  onDocEdit(file: string): void {
    this.add('drift', 'check_drift must run clean after doc edits', file);
  }

  /** A checker run updates the obligation: clean clears it, errors re-open it (gated repos only). */
  onLegibilityResult(errorCount: number): void {
    this.clear('legibility');
    if (errorCount > 0 && this.gateLegibility) {
      this.add('legibility', `${errorCount} error-severity legibility finding(s) unreconciled`, 'check_legibility');
    }
  }

  onConstraintChange(constraintKey: string, affects: string[]): void {
    for (const item of affects) {
      this.add('affects-revisit', `${constraintKey} affects ${item}`, constraintKey);
    }
  }

  onDecision(summary: string): void {
    this.add('decision-log', summary, 'decision');
  }

  get openObligations(): readonly Obligation[] {
    return this.open;
  }

  get isClear(): boolean {
    return this.open.length === 0;
  }

  describe(): string {
    if (this.isClear) return 'all sync obligations satisfied';
    return this.open.map((o) => `- [${o.kind}] ${o.detail} (opened by ${o.openedBy})`).join('\n');
  }
}
