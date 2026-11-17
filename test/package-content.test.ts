import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

describe('published package', () => {
  it('includes the brief needed to run copperhead demo outside a source checkout', async () => {
    const { stdout } = await execa('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: ROOT });
    const packs = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
    expect(packs).toHaveLength(1);
    expect(packs[0]!.files.map((file) => file.path)).toContain('examples/simple/usb-c-breakout.md');
  });
});
