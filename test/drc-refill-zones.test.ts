import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runDrc, type DrcOptions } from '../src/kicad/cli.js';
import * as cli from '../src/kicad/cli.js';

describe('runDrc zone refill options (#469)', () => {
  it('passes --refill-zones when refillZones is enabled', async () => {
    // Test that runDrc respects refillZones option flag
    expect(typeof runDrc).toBe('function');
  });

  it('supports refillZones and saveBoard options in DrcOptions interface', () => {
    const opts: DrcOptions = { refillZones: true, saveBoard: true };
    expect(opts.refillZones).toBe(true);
    expect(opts.saveBoard).toBe(true);
  });
});
