import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  FREEROUTING_JAR_ENV,
  FreeroutingMissingError,
  FreeroutingRoutingEngine,
  resolveFreeroutingJar,
} from '../src/kicad/layout/freerouting.js';
import type { BoardModel, DesignRules } from '../src/kicad/layout/types.js';

const SOME_EXISTING_FILE = path.resolve('package.json');

describe('freerouting jar resolution', () => {
  it('throws an actionable error when nothing is configured', () => {
    expect(() => resolveFreeroutingJar(undefined, {})).toThrow(FreeroutingMissingError);
    expect(() => resolveFreeroutingJar(undefined, {})).toThrow(/COPPERHEAD_FREEROUTING_JAR/);
  });

  it('throws when a configured path does not exist', () => {
    expect(() => resolveFreeroutingJar(undefined, { [FREEROUTING_JAR_ENV]: '/no/such/freerouting.jar' })).toThrow(
      /not found/,
    );
  });

  it('prefers the environment variable over config', () => {
    const env = { [FREEROUTING_JAR_ENV]: SOME_EXISTING_FILE };
    const config = { routing: { freeroutingJar: '/from/config.jar' } };
    expect(resolveFreeroutingJar(config, env)).toBe(SOME_EXISTING_FILE);
  });

  it('falls back to config.routing.freeroutingJar', () => {
    const config = { routing: { freeroutingJar: SOME_EXISTING_FILE } };
    expect(resolveFreeroutingJar(config, {})).toBe(SOME_EXISTING_FILE);
  });
});

describe('freerouting routing engine (integration)', () => {
  it.skipIf(!process.env.COPPERHEAD_TEST_FREEROUTING_JAR)(
    'routes a placed board and returns tracks/vias',
    async () => {
      const jar = resolveFreeroutingJar();
      const engine = new FreeroutingRoutingEngine(jar);

      const board: BoardModel = {
        width: 25.4,
        height: 15.24,
        footprints: [
          {
            ref: 'U1',
            footprint: 'Package_SO:SOIC-8',
            x: 3,
            y: 3,
            rotation: 0,
            side: 'front',
            courtyard: { width: 5, height: 4 },
            pads: [{ number: '1', net: 'N$1', x: -2, y: -1, width: 0.6, height: 1.5, layers: ['F.Cu'] }],
          },
          {
            ref: 'R1',
            footprint: 'Resistor_SMD:R_0603',
            x: 15,
            y: 10,
            rotation: 0,
            side: 'front',
            courtyard: { width: 1.6, height: 0.8 },
            pads: [{ number: '1', net: 'N$1', x: 0, y: 0, width: 0.8, height: 0.8, layers: ['F.Cu'] }],
          },
        ],
        nets: [{ name: 'N$1', pins: [{ ref: 'U1', pad: '1' }, { ref: 'R1', pad: '1' }] }],
      };
      const rules: DesignRules = { clearance: 0.2, trackWidth: 0.25, viaDiameter: 0.6, viaDrill: 0.3 };

      const routed = await engine.route(board, rules);
      expect(Array.isArray(routed.tracks)).toBe(true);
      expect(Array.isArray(routed.vias)).toBe(true);
      // A single two-pad net routes to at least one wire.
      expect(routed.tracks.length).toBeGreaterThan(0);
    },
    120_000,
  );
});
