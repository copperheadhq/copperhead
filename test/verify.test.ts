import { describe, it, expect, vi, afterEach } from 'vitest';
import { runVerifyParts, updateBomLcsc } from '../src/commands/verify.js';
import { verifyMpn } from '../src/kicad/catalog.js';
import { runExportBom } from '../src/commands/export.js';
import { runCheck } from '../src/commands/check.js';
import { tempFixtureRepo } from './helpers.js';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

describe('Part verification (verify-parts-networked)', () => {
  // Note: Vitest 3 fetchSpy.mockReset() restores original fetch, so tests queue exact mock responses per unique MPN call.
  const fetchSpy = vi.spyOn(global, 'fetch');

  afterEach(() => {
    fetchSpy.mockReset();
  });

  it('verifyMpn handles RESOLVED, NO STOCK, and NOT FOUND from catalog responses', async () => {
    // 1. RESOLVED case
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        components: [
          { lcsc: 12345, mfr: 'ESP32-S3-WROOM-1', package: 'SMD', stock: 100, price: 2.5 }
        ]
      })
    } as Response);
    const r1 = await verifyMpn('ESP32-S3-WROOM-1');
    expect(r1.status).toBe('RESOLVED');
    expect(r1.item?.lcscCode).toBe('C12345');

    // 2. NO STOCK case (case-insensitive match)
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        components: [
          { lcsc: 67890, mfr: 'esp32-s3-wroom-1', package: 'SMD', stock: 0, price: 2.5 }
        ]
      })
    } as Response);
    const r2 = await verifyMpn('ESP32-S3-WROOM-1');
    expect(r2.status).toBe('NO STOCK');
    expect(r2.item?.lcscCode).toBe('C67890');

    // 3. NOT FOUND case with candidates
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        components: [
          { lcsc: 111, mfr: 'ESP32-S3-WROOM-1-N16R8', package: 'SMD', stock: 100, price: 2.5 }
        ]
      })
    } as Response);
    const r3 = await verifyMpn('ESP32-S3-WROOM-1');
    expect(r3.status).toBe('NOT FOUND');
    expect(r3.candidates).toHaveLength(1);
    expect(r3.candidates?.[0]?.mfr).toBe('ESP32-S3-WROOM-1-N16R8');
  });

  it('verifyMpn handles fetch rejection (network failure)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('Network offline'));
    await expect(verifyMpn('ESP32-S3-WROOM-1')).rejects.toThrow(
      'Catalog lookup failed for MPN "ESP32-S3-WROOM-1": Network offline'
    );
  });

  it('runVerifyParts parses BOM.md, runs query, reports tabular status, and skips placeholders', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const bomPath = path.join(repo, 'docs', 'BOM.md');
      await mkdir(path.dirname(bomPath), { recursive: true });
      await writeFile(bomPath, `# BOM
| Refdes | Value | Footprint | MPN | Manufacturer | LCSC |
|---|---|---|---|---|---|
| R1 | 10k | R_0603 | RC0603FR-0710KL | Yageo | |
| R2 | 1k | R_0603 | UNVERIFIED | | |
| U1 | ESP | SMD | MOCK-NOT-FOUND | | |
`, 'utf8');

      // Mock resolutions (should only be called for RC0603FR-0710KL and MOCK-NOT-FOUND, since UNVERIFIED is skipped)
      // RC0603FR-0710KL
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          components: [{ lcsc: 25804, mfr: 'RC0603FR-0710KL', package: '0603', stock: 500, price: 0.01 }]
        })
      } as Response);
      // MOCK-NOT-FOUND
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          components: []
        })
      } as Response);

      const res = await runVerifyParts({ repoRoot: repo, strict: false });
      expect(res.ok).toBe(false); // fails overall since U1 is NOT FOUND
      expect(res.results).toHaveLength(3);
      expect(res.results[0]).toMatchObject({ refdes: 'R1', status: 'RESOLVED', lcscCode: 'C25804' });
      expect(res.results[1]).toMatchObject({ refdes: 'R2', status: 'SKIPPED' });
      expect(res.results[2]).toMatchObject({ refdes: 'U1', status: 'NOT FOUND' });
    } finally {
      await cleanup();
    }
  });

  it('runVerifyParts handles catalog API errors gracefully as LOOKUP FAILED', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const bomPath = path.join(repo, 'docs', 'BOM.md');
      await mkdir(path.dirname(bomPath), { recursive: true });
      await writeFile(bomPath, `# BOM
| Refdes | Value | Footprint | MPN | Manufacturer | LCSC |
|---|---|---|---|---|---|
| R1 | 10k | R_0603 | RC0603FR-0710KL | Yageo | |
`, 'utf8');

      // Mock 503 response from catalog
      fetchSpy.mockResolvedValue({
        ok: false,
        statusText: 'Service Unavailable',
      } as Response);

      const res = await runVerifyParts({ repoRoot: repo });
      expect(res.ok).toBe(false);
      expect(res.results[0]).toMatchObject({ refdes: 'R1', status: 'LOOKUP FAILED' });
    } finally {
      await cleanup();
    }
  });

  it('runVerifyParts --update rewrites BOM.md and handles rows without trailing pipes', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const bomPath = path.join(repo, 'docs', 'BOM.md');
      await mkdir(path.dirname(bomPath), { recursive: true });
      await writeFile(bomPath, `# BOM
| Refdes | Value | Footprint | MPN | Manufacturer | LCSC | Rationale
|---|---|---|---|---|---|---|
| R1 | 10k | R_0603 | RC0603FR-0710KL | Yageo | | pullup
`, 'utf8');

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          components: [{ lcsc: 25804, mfr: 'RC0603FR-0710KL', package: '0603', stock: 500, price: 0.01 }]
        })
      } as Response);

      const res = await runVerifyParts({ repoRoot: repo, update: true });
      expect(res.ok).toBe(true);

      const content = await readFile(bomPath, 'utf8');
      expect(content).toContain('| R1 | 10k | R_0603 | RC0603FR-0710KL | Yageo | C25804 | pullup |');
    } finally {
      await cleanup();
    }
  });

  it('runVerifyParts --strict fails if any part is out of stock', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const bomPath = path.join(repo, 'docs', 'BOM.md');
      await mkdir(path.dirname(bomPath), { recursive: true });
      await writeFile(bomPath, `# BOM
| Refdes | Value | Footprint | MPN | Manufacturer | LCSC |
|---|---|---|---|---|---|
| R1 | 10k | R_0603 | RC0603FR-0710KL | Yageo | |
`, 'utf8');

      // Return out of stock
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          components: [{ lcsc: 25804, mfr: 'RC0603FR-0710KL', package: '0603', stock: 0, price: 0.01 }]
        })
      } as Response);

      const res = await runVerifyParts({ repoRoot: repo, strict: true });
      expect(res.ok).toBe(false); // fails strict check since stock is 0
    } finally {
      await cleanup();
    }
  });

  it('runVerifyParts retries catalog lookup once and succeeds on second attempt', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const bomPath = path.join(repo, 'docs', 'BOM.md');
      await mkdir(path.dirname(bomPath), { recursive: true });
      await writeFile(bomPath, `# BOM
| Refdes | Value | Footprint | MPN | Manufacturer | LCSC |
|---|---|---|---|---|---|
| R1 | 10k | R_0603 | RC0603FR-0710KL | Yageo | |
`, 'utf8');

      // First fetch fails, second fetch succeeds
      fetchSpy.mockRejectedValueOnce(new Error('Network offline'));
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          components: [{ lcsc: 25804, mfr: 'RC0603FR-0710KL', package: '0603', stock: 500, price: 0.01 }]
        })
      } as Response);

      const res = await runVerifyParts({ repoRoot: repo });
      expect(res.ok).toBe(true);
      expect(res.results[0]).toMatchObject({ refdes: 'R1', status: 'RESOLVED', lcscCode: 'C25804' });
    } finally {
      await cleanup();
    }
  });

  it('offline invariant: check and plain export bom make zero network calls', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      // 1. Run check
      await runCheck(repo, () => {});
      expect(fetchSpy).not.toHaveBeenCalled();

      // 2. Run plain export bom
      const bomPath = path.join(repo, 'docs', 'BOM.md');
      await mkdir(path.dirname(bomPath), { recursive: true });
      await writeFile(bomPath, `# BOM
| Refdes | Value | Footprint | MPN | Manufacturer | LCSC |
|---|---|---|---|---|---|
| R1 | 10k | Resistor_SMD:R_0603_1608Metric | RC0603FR-0710KL | Yageo | C25804 | pullup |
`, 'utf8');
      
      await runExportBom({
        repoRoot: repo,
        supplier: 'jlcpcb',
        boards: 1,
        spares: 10,
        includeUnverified: false
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it('runVerifyParts logs tabular summary, near-match hints, and update confirmations via opts.log', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const bomPath = path.join(repo, 'docs', 'BOM.md');
      await mkdir(path.dirname(bomPath), { recursive: true });
      await writeFile(bomPath, `# BOM
| Refdes | Value | Footprint | MPN | Manufacturer | LCSC |
|---|---|---|---|---|---|
| R1 | 10k | R_0603 | RC0603FR-0710KL | Yageo | |
| U1 | ESP | SMD | ESP32-S3-WROOM-1 | Espressif | |
`, 'utf8');

      // RC0603FR-0710KL resolved
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          components: [{ lcsc: 25804, mfr: 'RC0603FR-0710KL', package: '0603', stock: 500, price: 0.01 }]
        })
      } as Response);

      // ESP32-S3-WROOM-1 returns candidates
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          components: [
            { lcsc: 111, mfr: 'ESP32-S3-WROOM-1-N16R8', package: 'SMD', stock: 100, price: 2.5 }
          ]
        })
      } as Response);

      const logs: string[] = [];
      const res = await runVerifyParts({ repoRoot: repo, update: true, log: (msg) => logs.push(msg) });

      expect(res.ok).toBe(false);
      const fullLog = logs.join('\n');
      expect(fullLog).toContain('Verifying BOM parts against catalog...');
      expect(fullLog).toContain('R1');
      expect(fullLog).toContain('RESOLVED');
      expect(fullLog).toContain('C25804');
      expect(fullLog).toContain('Hint (near matches in catalog): ESP32-S3-WROOM-1-N16R8');
      expect(fullLog).toContain('Updated 1 LCSC code(s) in BOM.md.');
    } finally {
      await cleanup();
    }
  });

  it('runVerifyParts throws VerificationError when docs/BOM.md is missing', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await expect(runVerifyParts({ repoRoot: repo })).rejects.toThrow(/no docs[/\\]BOM\.md to verify/);
    } finally {
      await cleanup();
    }
  });

  it('runVerifyParts warns when --update is used but no LCSC column is present in BOM.md', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const bomPath = path.join(repo, 'docs', 'BOM.md');
      await mkdir(path.dirname(bomPath), { recursive: true });
      await writeFile(bomPath, `# BOM
| Refdes | Value | Footprint | MPN | Manufacturer |
|---|---|---|---|---|
| R1 | 10k | R_0603 | RC0603FR-0710KL | Yageo |
`, 'utf8');

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          components: [{ lcsc: 25804, mfr: 'RC0603FR-0710KL', package: '0603', stock: 500, price: 0.01 }]
        })
      } as Response);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await runVerifyParts({ repoRoot: repo, update: true });
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no LCSC column in docs/BOM.md'));
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  it('runVerifyParts passes log callback to output human table and candidate suggestions on NOT FOUND', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const bomPath = path.join(repo, 'docs', 'BOM.md');
      await mkdir(path.dirname(bomPath), { recursive: true });
      await writeFile(
        bomPath,
        `# BOM\n| Refdes | Value | Footprint | MPN | LCSC |\n|---|---|---|---|---|\n| R1 | 10k | R_0603 | UNKNOWN_MPN | |\n`,
        'utf8',
      );

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          components: [
            { lcsc: 99999, mfr: 'UNKNOWN_MPN_V1', package: '0603', stock: 10, price: 0.05 },
          ],
        }),
      } as Response);

      const logged: string[] = [];
      const res = await runVerifyParts({
        repoRoot: repo,
        log: (s) => logged.push(s),
      });

      expect(res.ok).toBe(false);
      const output = logged.join('\n');
      expect(output).toContain('Verifying BOM parts against catalog');
      expect(output).toContain('Hint (near matches in catalog): UNKNOWN_MPN_V1');
    } finally {
      await cleanup();
    }
  });
});


