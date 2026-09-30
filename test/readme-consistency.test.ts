import { describe, it, expect } from 'vitest';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { tempFixtureRepo } from './helpers.js';

describe('README consistency script', () => {
  it('passes on a clean consistent repo', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      // In tempFixtureRepo, we copy the project fixture. Let's make sure it has the required files.
      // Copy the actual script and status.json/package.json/README.md to have a consistent setup
      const root = process.cwd();
      const scriptPath = path.join(root, 'scripts', 'check-readme-consistency.ts');
      
      const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
      const status = await readFile(path.join(root, 'status.json'), 'utf8');
      const readme = await readFile(path.join(root, 'README.md'), 'utf8');

      await writeFile(path.join(repo, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
      await writeFile(path.join(repo, 'status.json'), status, 'utf8');
      await writeFile(path.join(repo, 'README.md'), readme, 'utf8');

      // Run consistency script in the temp repo
      const res = await execa('npx', ['tsx', scriptPath], { cwd: repo });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('README consistency check passed');
    } finally {
      await cleanup();
    }
  });

  it('fails and reports version drift when version mismatches', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const root = process.cwd();
      const scriptPath = path.join(root, 'scripts', 'check-readme-consistency.ts');
      
      const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
      pkg.version = '9.9.9'; // bump version
      const status = await readFile(path.join(root, 'status.json'), 'utf8');
      const readme = await readFile(path.join(root, 'README.md'), 'utf8');

      await writeFile(path.join(repo, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
      await writeFile(path.join(repo, 'status.json'), status, 'utf8');
      await writeFile(path.join(repo, 'README.md'), readme, 'utf8');

      const res = await execa('npx', ['tsx', scriptPath], { cwd: repo, reject: false });
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toContain('Version claim drift detected');
    } finally {
      await cleanup();
    }
  });

  it('fails and reports maturity block drift when status.json changes', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const root = process.cwd();
      const scriptPath = path.join(root, 'scripts', 'check-readme-consistency.ts');
      
      const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
      const status = JSON.parse(await readFile(path.join(root, 'status.json'), 'utf8'));
      // Modify an AC status in status.json
      status.acceptanceCriteria['AC-3.1'].openai.status = 'fail';
      
      const readme = await readFile(path.join(root, 'README.md'), 'utf8');

      await writeFile(path.join(repo, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
      await writeFile(path.join(repo, 'status.json'), JSON.stringify(status, null, 2), 'utf8');
      await writeFile(path.join(repo, 'README.md'), readme, 'utf8');

      const res = await execa('npx', ['tsx', scriptPath], { cwd: repo, reject: false });
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toContain('Maturity block drift detected');
    } finally {
      await cleanup();
    }
  });

  it('regenerates README.md successfully when --write flag is provided', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const root = process.cwd();
      const scriptPath = path.join(root, 'scripts', 'check-readme-consistency.ts');
      
      const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
      pkg.version = '1.2.3'; // bump version
      const status = await readFile(path.join(root, 'status.json'), 'utf8');
      const readme = await readFile(path.join(root, 'README.md'), 'utf8');

      await writeFile(path.join(repo, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
      await writeFile(path.join(repo, 'status.json'), status, 'utf8');
      await writeFile(path.join(repo, 'README.md'), readme, 'utf8');

      // Run with --write
      const writeRes = await execa('npx', ['tsx', scriptPath, '--write'], { cwd: repo });
      expect(writeRes.exitCode).toBe(0);
      expect(writeRes.stdout).toContain('Successfully regenerated and updated README.md');

      // Verify the file was updated
      const updatedReadme = await readFile(path.join(repo, 'README.md'), 'utf8');
      expect(updatedReadme).toContain('early (v1.2.3)');
      expect(updatedReadme).toContain('where v1.2.3 stands');

      // Verify a subsequent check passes
      const checkRes = await execa('npx', ['tsx', scriptPath], { cwd: repo });
      expect(checkRes.exitCode).toBe(0);
    } finally {
      await cleanup();
    }
  });
});
