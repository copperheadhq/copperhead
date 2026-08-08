import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  schematicPartsGate,
  formatPartsCheckpointReport,
  type PartsCheckpointReport,
} from '../src/commands/parts-gate.js';

// One installed library: two digit-sibling buffers. A BOM naming SN74LVC3G17
// is genuinely absent (the match ranking refuses digit-for-digit swaps), while
// the checkpoint's looser suggestion search offers both siblings to the human.
const LOGIC_LIB = `(kicad_symbol_lib (version 20251024) (generator test)
  (symbol "SN74LVC1G17" (pin_names (offset 1.016))
    (symbol "SN74LVC1G17_1_1"
      (pin input line (at -7.62 0 0) (length 2.54) (name "A") (number "2"))
      (pin output line (at 7.62 0 180) (length 2.54) (name "Y") (number "4"))
    )
  )
  (symbol "SN74LVC2G17" (pin_names (offset 1.016))
    (symbol "SN74LVC2G17_1_1"
      (pin input line (at -7.62 0 0) (length 2.54) (name "1A") (number "1"))
      (pin output line (at 7.62 0 180) (length 2.54) (name "1Y") (number "6"))
    )
  )
)`;

const bomTable = (rows: string[]): string =>
  ['| Refdes | Value | Footprint | MPN | Rationale |', '| --- | --- | --- | --- | --- |', ...rows].join('\n') + '\n';

const ABSENT_BOM = bomTable([
  '| U1 | buffer | Package_TO_SOT_SMD:X | SN74LVC3G17 | digit sibling of the stock parts |',
  '| U2 | ghost | Package_QFP:X | XYZQ9999ZZ | installed nowhere |',
]);

const RESOLVED_BOM = bomTable(['| U1 | buffer | Package_TO_SOT_SMD:X | SN74LVC1G17 | installed |']);

const NEVER_CHECKED_BOM = bomTable(['| Y1 | 8M | Crystal:X | | name too short to search |']);

describe('schematicPartsGate (stage-4 unresolvable-parts checkpoint)', () => {
  let libDir: string;
  let repo: string;
  const searchDirs = async (): Promise<string[]> => [libDir];

  const writeBom = async (content: string): Promise<void> => {
    await writeFile(path.join(repo, 'docs', 'BOM.md'), content, 'utf8');
  };

  beforeAll(async () => {
    libDir = await mkdtemp(path.join(tmpdir(), 'copperhead-partsgate-lib-'));
    await writeFile(path.join(libDir, 'Logic.kicad_sym'), LOGIC_LIB, 'utf8');
    repo = await mkdtemp(path.join(tmpdir(), 'copperhead-partsgate-repo-'));
    await mkdir(path.join(repo, 'docs'), { recursive: true });
  });

  afterAll(async () => {
    await rm(libDir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  });

  it('stops a stop-configured run on genuine absence, with candidates populated', async () => {
    await writeBom(ABSENT_BOM);
    const lines: string[] = [];
    const res = await schematicPartsGate({
      repoRoot: repo,
      docsDir: 'docs',
      mode: 'stop',
      log: (s) => lines.push(s),
      searchDirs,
    });
    expect(res.verdict).toBe('stop');
    const absent = res.report!.absent;
    expect(absent).toHaveLength(2);
    const sibling = absent.find((p) => p.query === 'SN74LVC3G17')!;
    expect(sibling.refs).toEqual(['U1']);
    expect(sibling.candidates).toContain('Logic:SN74LVC1G17');
    expect(sibling.candidates).toContain('Logic:SN74LVC2G17');
    const ghost = absent.find((p) => p.query === 'XYZQ9999ZZ')!;
    expect(ghost.candidates).toEqual([]);
    // The report block names both, suggestions for one, no-near-match for the other.
    const block = formatPartsCheckpointReport(res.report!);
    expect(block).toContain('U1 (SN74LVC3G17): nearest installed: ');
    expect(block).toContain('U2 (XYZQ9999ZZ): no near match installed');
  });

  it('proceeds with a warning on an unreadable library dir, in stop mode too', async () => {
    await writeBom(ABSENT_BOM);
    const lines: string[] = [];
    const res = await schematicPartsGate({
      repoRoot: repo,
      docsDir: 'docs',
      mode: 'stop',
      log: (s) => lines.push(s),
      searchDirs: async () => [path.join(libDir, 'nonexistent')],
    });
    expect(res.verdict).toBe('proceed');
    expect(lines.join('\n')).toContain('could not be verified');
  });

  it('proceeds when every searched part resolves', async () => {
    await writeBom(RESOLVED_BOM);
    const lines: string[] = [];
    const res = await schematicPartsGate({
      repoRoot: repo,
      docsDir: 'docs',
      mode: 'stop',
      log: (s) => lines.push(s),
      searchDirs,
    });
    expect(res.verdict).toBe('proceed');
    expect(lines.join('\n')).toContain('every searched BOM part resolves to an installed symbol');
  });

  it('never-checked parts never trigger the gate, and the report labels them', async () => {
    await writeBom(NEVER_CHECKED_BOM);
    let prompted = 0;
    const res = await schematicPartsGate({
      repoRoot: repo,
      docsDir: 'docs',
      mode: 'stop',
      onCheckpoint: async () => {
        prompted++;
        return 'stop';
      },
      log: () => {},
      searchDirs,
    });
    expect(res.verdict).toBe('proceed');
    expect(prompted).toBe(0);
    expect(res.report!.neverChecked.notSearched).toContain('Y1 (8M)');
    expect(formatPartsCheckpointReport(res.report!)).toContain('name too short to search');
  });

  it('re-check re-reads BOM.md: a fixed BOM shrinks the report and proceeds without re-prompting', async () => {
    await writeBom(ABSENT_BOM);
    const seen: PartsCheckpointReport[] = [];
    const res = await schematicPartsGate({
      repoRoot: repo,
      docsDir: 'docs',
      mode: 'stop',
      onCheckpoint: async (report) => {
        seen.push(report);
        // The human fixes the BOM in another terminal, then picks re-check.
        await writeBom(RESOLVED_BOM);
        return 'recheck';
      },
      log: () => {},
      searchDirs,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.absent).toHaveLength(2);
    expect(res.verdict).toBe('proceed');
  });

  it('a present human beats fail-fast, and cancel maps to stop', async () => {
    await writeBom(ABSENT_BOM);
    let prompted = 0;
    const res = await schematicPartsGate({
      repoRoot: repo,
      docsDir: 'docs',
      mode: 'stop',
      onCheckpoint: async () => {
        prompted++;
        return null; // Esc/Ctrl-C
      },
      log: () => {},
      searchDirs,
    });
    expect(prompted).toBe(1); // asked instead of the run just failing
    expect(res.verdict).toBe('stop');
  });

  it('continue proceeds to the agent', async () => {
    await writeBom(ABSENT_BOM);
    const res = await schematicPartsGate({
      repoRoot: repo,
      docsDir: 'docs',
      mode: 'stop',
      onCheckpoint: async () => 'continue',
      log: () => {},
      searchDirs,
    });
    expect(res.verdict).toBe('proceed');
  });

  it('agent mode with no prompt short-circuits: no scan is paid at all', async () => {
    await writeBom(ABSENT_BOM);
    let scanned = 0;
    const res = await schematicPartsGate({
      repoRoot: repo,
      docsDir: 'docs',
      mode: 'agent',
      log: () => {
        throw new Error('the default path must log nothing');
      },
      searchDirs: async () => {
        scanned++;
        return [libDir];
      },
    });
    expect(res.verdict).toBe('proceed');
    expect(res.report).toBeUndefined();
    expect(scanned).toBe(0);
  });
});
