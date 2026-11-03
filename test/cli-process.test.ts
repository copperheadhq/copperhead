import { describe, expect, it } from 'vitest';
import { cliProcessArgs } from './cli-process.js';

describe('real CLI subprocess arguments', () => {
  it.each([
    ['20.0.0', '--loader'],
    ['20.5.1', '--loader'],
    ['20.6.0', '--import'],
    ['24.19.0', '--import'],
  ])('uses the documented tsx preload for Node %s', (version, flag) => {
    expect(cliProcessArgs(['--json', 'demo', '--tour'], version)).toEqual([
      flag, 'tsx', 'src/cli.ts', '--json', 'demo', '--tour',
    ]);
  });
});
