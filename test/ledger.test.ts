import { describe, it, expect } from 'vitest';
import { ObligationsLedger } from '../src/agent/ledger.js';

describe('sync-obligations ledger (design D13)', () => {
  it('a schematic edit opens erc, drift, and changelog obligations', () => {
    const l = new ObligationsLedger();
    l.onKicadEdit('hardware/x.kicad_sch');
    const kinds = l.openObligations.map((o) => o.kind);
    expect(kinds).toContain('erc');
    expect(kinds).toContain('drift');
    expect(kinds).toContain('changelog');
    expect(kinds).not.toContain('drc');
  });

  it('a board edit additionally opens drc', () => {
    const l = new ObligationsLedger();
    l.onKicadEdit('hardware/x.kicad_pcb');
    expect(l.openObligations.map((o) => o.kind)).toContain('drc');
  });

  it('a constraint change opens dual-write and one revisit per affected item', () => {
    const l = new ObligationsLedger();
    l.onConstraintChange('power.sleep_current_uA', ['U2', 'R7-absent']);
    const revisits = l.openObligations.filter((o) => o.kind === 'affects-revisit');
    expect(revisits).toHaveLength(2);
    l.clear('affects-revisit', 'power.sleep_current_uA affects U2');
    expect(l.openObligations.filter((o) => o.kind === 'affects-revisit')).toHaveLength(1);
  });

  it('clearing is scoped; ledger reports open items until all clear', () => {
    const l = new ObligationsLedger();
    l.onKicadEdit('a.kicad_sch');
    expect(l.isClear).toBe(false);
    l.clear('erc');
    l.clear('drift');
    l.clear('legibility');
    l.clear('changelog');
    expect(l.isClear).toBe(true);
    expect(l.describe()).toContain('satisfied');
  });

  it('deduplicates identical obligations', () => {
    const l = new ObligationsLedger();
    l.onKicadEdit('a.kicad_sch');
    l.onKicadEdit('a.kicad_sch');
    expect(l.openObligations.filter((o) => o.kind === 'erc')).toHaveLength(1);
  });
});
