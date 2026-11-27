/**
 * Engine-second and wall-clock accounting (RFC 11 §12.4): the budget is time,
 * not retry count. Every invocation is charged; an action whose estimate
 * exceeds the remainder cannot be selected.
 */
export interface BudgetState {
  engineSecondsTotal: number;
  wallSecondsTotal: number;
  engineSecondsUsed: number;
  wallSecondsUsed: number;
  /** Per invocation, in order. */
  charges: { engineId: string; engineSeconds: number; wallSeconds: number; note?: string }[];
}

export class Budget {
  readonly state: BudgetState;
  private readonly startedAt = Date.now();
  constructor(engineSeconds: number, wallSeconds: number) {
    this.state = { engineSecondsTotal: engineSeconds, wallSecondsTotal: wallSeconds, engineSecondsUsed: 0, wallSecondsUsed: 0, charges: [] };
  }
  get remaining(): { engineSeconds: number; wallSeconds: number } {
    const wall = (Date.now() - this.startedAt) / 1000;
    return { engineSeconds: Math.max(0, this.state.engineSecondsTotal - this.state.engineSecondsUsed), wallSeconds: Math.max(0, this.state.wallSecondsTotal - Math.max(wall, this.state.wallSecondsUsed)) };
  }
  /** Can an action with this estimate start? */
  affords(estimate: { engineSeconds: number; wallSeconds: number }): boolean {
    const r = this.remaining;
    return estimate.engineSeconds <= r.engineSeconds && estimate.wallSeconds <= r.wallSeconds;
  }
  charge(engineId: string, engineSeconds: number, wallSeconds: number, note?: string): void {
    this.state.engineSecondsUsed += engineSeconds;
    this.state.wallSecondsUsed += wallSeconds;
    this.state.charges.push({ engineId, engineSeconds, wallSeconds, ...(note ? { note } : {}) });
  }
  get exhausted(): boolean {
    const r = this.remaining;
    return r.engineSeconds <= 0 || r.wallSeconds <= 0;
  }
}
