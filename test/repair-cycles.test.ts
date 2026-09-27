import { describe, it, expect } from 'vitest';
import { countRepairCycle } from '../src/capabilities/handlers.js';
import { repairBudgetExhausted } from '../src/agent/loop.js';
import type { RunContext } from '../src/agent/context.js';
import type { CheckReport } from '../src/kicad/report.js';

type Kind = 'erc' | 'drc';
/** A normalised report: `unrouted` is a count beside the violations, never among them (AC-15.39). */
const report = (counts: Record<string, number>, unrouted?: number): CheckReport => {
  const violations = Object.entries(counts).flatMap(([type, n]) =>
    Array.from({ length: n }, () => ({ severity: 'error', type, description: '', items: [] })),
  );
  return { ok: violations.length === 0, violations, ...(unrouted === undefined ? {} : { unrouted }) } as unknown as CheckReport;
};
const clean = report({});

/** Drives countRepairCycle the way the run_erc/run_drc handlers do. */
function session() {
  const ctx = { repairCycles: 0, lastErc: null, lastDrc: null } as unknown as RunContext;
  const last = (k: Kind) => (k === 'erc' ? 'lastErc' : 'lastDrc') as 'lastErc' | 'lastDrc';
  return {
    ctx,
    /** An edit to the file this kind checks (markTouched clears the last report). */
    edit(kind: Kind = 'drc') {
      ctx[last(kind)] = null;
    },
    check(r: CheckReport, kind: Kind = 'drc') {
      countRepairCycle(ctx, kind, r);
      ctx[last(kind)] = r;
    },
    /** edit, then check: the normal repair step */
    step(r: CheckReport, kind: Kind = 'drc') {
      this.edit(kind);
      this.check(r, kind);
    },
  };
}

describe('countRepairCycle: only a fix that did not work costs a cycle (#331)', () => {
  it('replays the live stage that failed at 6 of 5 under the old rule, within budget', () => {
    // The seven real run_drc reports from the usb-c-power-breakout Opus run, with their types.
    const s = session();
    s.step(clean);
    s.step(report({ solder_mask_bridge: 2, copper_edge_clearance: 1, courtyards_overlap: 2, pth_inside_courtyard: 2, shorting_items: 2, silk_overlap: 3, silk_over_copper: 5, silk_edge_clearance: 3 }));
    s.step(report({ silk_overlap: 3, silk_over_copper: 7 }));
    s.step(report({ silk_overlap: 9, silk_over_copper: 9 }));
    s.step(report({ silk_overlap: 9, silk_over_copper: 9 }));
    s.step(report({ silk_overlap: 1 }));
    s.step(report({ silk_overlap: 1, silk_over_copper: 1 }));
    // First failure: free. 9 electrical -> 0: a repair that worked. Then silkscreen only:
    // 10 -> 18 and 18 -> 18 made no progress, 1 -> 2 got worse. Three cycles, not six.
    expect(s.ctx.repairCycles).toBe(3);
  });

  it('still exhausts on a failure that persists unchanged', () => {
    const s = session();
    for (let i = 0; i < 7; i++) s.step(report({ clearance: 3 }));
    expect(s.ctx.repairCycles).toBe(6); // the first failing check has nothing to compare with
  });

  it('rolls back on the maxRepairCycles-th failed repair, and a limit of 0 allows none', () => {
    expect(repairBudgetExhausted(4, 5)).toBe(false);
    expect(repairBudgetExhausted(5, 5)).toBe(true);
    expect(repairBudgetExhausted(0, 0)).toBe(false);
    expect(repairBudgetExhausted(1, 0)).toBe(true);
    // the live sequence from #331: 3 failed repairs of 5, so the stage runs on
    expect(repairBudgetExhausted(3, 5)).toBe(false);
  });

  it('ends a stuck silkscreen-only loop too, rather than running out the turn budget', () => {
    const s = session();
    for (let i = 0; i < 7; i++) s.step(report({ silk_overlap: 2 }));
    expect(s.ctx.repairCycles).toBe(6);
  });

  it('does not charge silkscreen progress', () => {
    const s = session();
    for (const n of [18, 12, 7, 3, 1]) s.step(report({ silk_overlap: n }));
    expect(s.ctx.repairCycles).toBe(0);
  });

  it('does not let fewer silkscreen findings hide more electrical ones', () => {
    const s = session();
    s.step(report({ clearance: 1, silk_overlap: 17 })); // 18 findings
    s.step(report({ clearance: 3 })); // 3 findings, but electrical got worse
    expect(s.ctx.repairCycles).toBe(1);
  });

  it('does not let routing progress (fewer unrouted connections) hide a new short', () => {
    const s = session();
    s.step(report({ silk_overlap: 2 }, 24));
    s.step(report({ silk_overlap: 2, shorting_items: 1 }, 10));
    expect(s.ctx.repairCycles).toBe(1);
  });

  it('does not charge routing progress while silkscreen findings wait', () => {
    // the routing stage's shape: copper clean, two deferred silkscreen overlaps,
    // and the ratsnest shrinking with every batch of tracks
    const s = session();
    s.step(report({ silk_overlap: 2 }, 30));
    for (const n of [24, 18, 11, 5, 2]) s.step(report({ silk_overlap: 2 }, n));
    expect(s.ctx.repairCycles).toBe(0);
    s.step(report({ silk_overlap: 2 }, 2)); // no routing and no silkscreen progress: a failed repair
    expect(s.ctx.repairCycles).toBe(1);
  });

  it('a board with unrouted connections and no violation is a passing check, never a cycle', () => {
    const s = session();
    for (const n of [30, 30, 30]) s.step(report({}, n));
    expect(s.ctx.repairCycles).toBe(0);
  });

  it('does not charge the first failure after a clean check', () => {
    const s = session();
    s.step(clean);
    s.step(report({ clearance: 4 }));
    s.step(clean);
    s.step(report({ clearance: 2 }));
    expect(s.ctx.repairCycles).toBe(0);
  });

  it('does not charge re-running a check with no edit in between', () => {
    const s = session();
    s.step(report({ clearance: 2 }));
    s.check(report({ clearance: 2 }));
    s.check(report({ clearance: 2 }));
    expect(s.ctx.repairCycles).toBe(0);
    s.step(report({ clearance: 2 })); // an edit that did not help does count
    expect(s.ctx.repairCycles).toBe(1);
  });

  it('keeps ERC and DRC histories separate', () => {
    const s = session();
    s.step(report({ pin_not_connected: 2 }), 'erc');
    s.step(report({ clearance: 2 }), 'drc'); // first DRC: no DRC predecessor
    s.step(report({ pin_not_connected: 2 }), 'erc'); // unchanged ERC after an edit: one cycle
    expect(s.ctx.repairCycles).toBe(1);
  });
});
