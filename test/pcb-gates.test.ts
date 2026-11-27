/**
 * The placement gate (RFC 11 Section 10.4, RFC 15 Section 11.1): a hard
 * intent constraint is a gate, whatever kind of intent it is.
 */
import { describe, expect, it } from 'vitest';
import { make, type Diagnostic } from '../src/pcb/verify/diagnostic.js';
import { placementGate } from '../src/pcb/verify/gates.js';
import { loadProfile } from '../src/pcb/verify/profiles/index.js';

const checker = { id: 'placement-intent', version: 'test' };
const finding = (code: string, severity: 'error' | 'warning'): Diagnostic => make(checker, code, { severity, entityIds: [], entityReferences: ['U1'], message: code });
const profile = loadProfile('jlcpcb-2layer');

describe('the placement gate', () => {
  for (const code of ['intent.emc.hot-loop', 'intent.emc.isolation', 'intent.emc.channel', 'intent.rf.clearance', 'intent.relative.chain.order']) {
    it(`rejects a hard ${code} violation`, () => {
      expect(placementGate([finding(code, 'error')], profile).passed).toBe(false);
    });
  }

  it('lets a soft violation through, and leaves routing intent to the routing gate', () => {
    expect(placementGate([finding('intent.emc.hot-loop', 'warning')], profile).passed).toBe(true);
    expect(placementGate([finding('intent.routing.width', 'error')], profile).passed).toBe(true);
  });
});
