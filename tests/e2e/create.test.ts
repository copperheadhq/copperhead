import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { mkdtempSync, rmSync } from 'fs';

// Helper to locate the compiled CLI entry point.
// The repo builds to `dist/cli.js` via the existing build script.
const CLI_PATH = path.resolve(__dirname, '../../dist/cli.js');

describe('copperhead create (end‑to‑end)', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'copperhead-e2e-'));

  afterAll(() => {
    // Clean up the temporary directory after the test suite finishes.
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('runs cleanly with --no-kicad and produces a manifest', () => {
    const brief = 'Create a simple 2‑layer board that lights an LED when powered.';
    const cmd = [
      'node',
      `"${CLI_PATH}"`,
      'create',
      `"${brief}"',
      '--output',
      `"${tempDir}"',
      '--no-kicad',
    ].join(' ');

    // Execute the CLI; any non‑zero exit code will cause execSync to throw.
    execSync(cmd, { stdio: 'inherit', env: { ...process.env } });

    // Verify that the manifest file exists and contains the expected fields.
    const manifestPath = path.join(tempDir, 'copperhead.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest).toMatchObject({
      brief,
      status: 'completed',
    });
    expect(Array.isArray(manifest.stages)).toBe(true);
    expect(manifest.stages).toContain('schematic');
  });
});
