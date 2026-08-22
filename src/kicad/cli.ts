import { execa, ExecaError } from 'execa';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeReport, type CheckReport } from './report.js';
import { PreflightError, isNotFoundError } from '../util/preflight.js';

export class KicadCliMissingError extends PreflightError {
  constructor(platform = process.platform) {
    const isWin = platform === 'win32';
    const isMac = platform === 'darwin';

    const locationHint = isWin
      ? 'ensure kicad-cli.exe is on PATH (typically in C:\\Program Files\\KiCad\\<version>\\bin)'
      : isMac
        ? 'ensure the kicad-cli binary is on PATH (on macOS it ships inside KiCad.app/Contents/MacOS)'
        : 'ensure the kicad-cli binary is on PATH (typically /usr/bin/kicad-cli)';

    const envHint = isWin
      ? 'or set COPPERHEAD_KICAD_CLI="C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe"'
      : isMac
        ? 'or set COPPERHEAD_KICAD_CLI=/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
        : 'or set COPPERHEAD_KICAD_CLI=/usr/bin/kicad-cli';

    super(
      'kicad-cli not found on PATH',
      'copperhead verifies every mutation with kicad-cli ERC/DRC; without it no edit can be checked, so no run can start',
      [
        'install KiCad ≥ 8: https://www.kicad.org/download/',
        locationHint,
        envHint,
        'confirm with "kicad-cli version", then rerun',
      ],
    );
    this.name = 'KicadCliMissingError';
  }
}

/**
 * `COPPERHEAD_KICAD_CLI` points somewhere that does not exist. Distinct from
 * KicadCliMissingError because the advice is the opposite: the override was
 * seen and rejected, so telling the user to set it would be nonsense.
 */
export class KicadCliBadOverrideError extends PreflightError {
  constructor(configured: string, platform = process.platform) {
    const isWin = platform === 'win32';
    const isMac = platform === 'darwin';

    const checkHint = isWin
      ? `check the path in PowerShell/cmd: Test-Path "${configured}"`
      : `check the path: ls -l "${configured}"`;

    const locationHint = isWin
      ? 'on Windows the binary typically lives at C:\\Program Files\\KiCad\\<version>\\bin\\kicad-cli.exe'
      : isMac
        ? 'on macOS the binary lives at /Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
        : 'on Linux the binary typically lives at /usr/bin/kicad-cli';

    const confirmHint = isWin
      ? 'confirm with "& \'$env:COPPERHEAD_KICAD_CLI\' version", then rerun'
      : 'confirm with "$COPPERHEAD_KICAD_CLI version", then rerun';

    super(
      `COPPERHEAD_KICAD_CLI points to a path that does not exist: ${configured}`,
      'the override wins over PATH, so falling back silently would run a different binary than the one you named and make the failure impossible to diagnose',
      [
        checkHint,
        locationHint,
        'or unset COPPERHEAD_KICAD_CLI to fall back to PATH',
        confirmHint,
      ],
    );
    this.name = 'KicadCliBadOverrideError';
  }
}

/** Well-known install locations when `kicad-cli` is not on PATH (macOS app bundle). */
const MACOS_FALLBACK_BINARIES = [
  '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli',
  '/Applications/KiCad-10.0/KiCad.app/Contents/MacOS/kicad-cli',
  '/Applications/KiCad-9.0/KiCad.app/Contents/MacOS/kicad-cli',
  '/Applications/KiCad-8.0/KiCad.app/Contents/MacOS/kicad-cli',
];

const DEFAULT_WIN_ROOTS = [
  process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'KiCad') : 'C:/Program Files/KiCad',
  'C:/Program Files/KiCad',
  'C:/Program Files (x86)/KiCad',
];

/**
 * Return default fallback candidate paths for macOS and Windows standard KiCad installations.
 * On Windows, version-numbered directories (e.g. 10.0, 9.0, 8.0) under the KiCad root
 * are probed in descending numerical order, mirroring symlib.ts.
 */
export function defaultFallbackBinaries(winRoots: readonly string[] = DEFAULT_WIN_ROOTS): string[] {
  const candidates: string[] = [...MACOS_FALLBACK_BINARIES];
  const seenRoots = new Set<string>();

  for (const winRoot of winRoots) {
    const normalized = path.normalize(winRoot).toLowerCase();
    if (seenRoots.has(normalized)) continue;
    seenRoots.add(normalized);

    if (!existsSync(winRoot)) continue;
    try {
      const entries = readdirSync(winRoot, { withFileTypes: true });
      const versions = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

      for (const version of versions) {
        candidates.push(
          path.join(winRoot, version, 'bin', 'kicad-cli.exe'),
          path.join(winRoot, version, 'bin', 'kicad-cli.cmd'),
          path.join(winRoot, version, 'bin', 'kicad-cli.bat'),
          path.join(winRoot, version, 'bin', 'kicad-cli'),
        );
      }
      candidates.push(
        path.join(winRoot, 'bin', 'kicad-cli.exe'),
        path.join(winRoot, 'bin', 'kicad-cli.cmd'),
        path.join(winRoot, 'bin', 'kicad-cli.bat'),
        path.join(winRoot, 'bin', 'kicad-cli'),
      );
    } catch {
      // not readable / not a directory; skip
    }
  }

  return candidates;
}

let fallbackBinariesOverride: readonly string[] | null = null;
let fallbackWinRootsOverride: readonly string[] | null = null;

let cachedBinary: string | null | undefined;

/**
 * Resolve the kicad-cli executable: `COPPERHEAD_KICAD_CLI` > PATH name
 * (`kicad-cli`). On PATH miss, `runKicad` falls back to macOS KiCad.app paths
 * and Windows standard installation paths.
 */
export function resolveKicadCli(): string {
  if (cachedBinary !== undefined) {
    if (cachedBinary === null) throw new KicadCliMissingError();
    return cachedBinary;
  }
  const fromEnv = envOverride();
  if (fromEnv) {
    cachedBinary = fromEnv;
    return fromEnv;
  }
  cachedBinary = 'kicad-cli';
  return cachedBinary;
}

/**
 * The `COPPERHEAD_KICAD_CLI` override, or null when unset. Set-but-missing is
 * a hard error rather than a silent fallthrough to PATH: the user told us
 * which binary to run, and quietly running a different one (or reporting
 * "not found on PATH" with advice to set the variable they already set) is
 * the worst possible answer.
 */
function envOverride(): string | null {
  const fromEnv = process.env.COPPERHEAD_KICAD_CLI?.trim();
  if (!fromEnv) return null;
  if (!existsSync(fromEnv)) throw new KicadCliBadOverrideError(fromEnv);
  return fromEnv;
}

/**
 * After ENOENT on PATH, retry with known install paths (macOS app bundles, Windows standard paths).
 *
 * Deliberately does not re-read `COPPERHEAD_KICAD_CLI`: this is reached only
 * when resolveKicadCli() cached the bare PATH name, which in turn happens only
 * when the override was unset (set-but-missing throws there instead), so an
 * override re-check here could never fire.
 */
function fallbackAfterMissing(): string {
  const candidates =
    fallbackBinariesOverride ?? defaultFallbackBinaries(fallbackWinRootsOverride ?? undefined);
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedBinary = candidate;
      return candidate;
    }
  }
  cachedBinary = null;
  throw new KicadCliMissingError();
}

async function runKicad(args: string[], opts?: { reject?: boolean }): Promise<Awaited<ReturnType<typeof execa>>> {
  let bin = resolveKicadCli();
  let res = await execa(bin, args, { reject: false });
  if (res.failed && isNotFoundError(res)) {
    if (bin === 'kicad-cli') {
      bin = fallbackAfterMissing();
      res = await execa(bin, args, { reject: false });
    } else {
      throw new KicadCliMissingError();
    }
  }
  if (res.failed && isNotFoundError(res)) {
    throw new KicadCliMissingError();
  }
  if (opts?.reject === false) return res;
  if (res.failed) {
    throw Object.assign(new Error(res.stderr || res.stdout || `kicad-cli exited ${res.exitCode}`), res);
  }
  return res;
}

/** Test helper: clear the resolved-binary cache. */
export function resetKicadCliCache(): void {
  cachedBinary = undefined;
}

/**
 * Test helper: point the app-bundle / binary probe at fixture paths, or call with no
 * argument to restore the default dynamic list.
 */
export function setKicadFallbackBinaries(paths?: readonly string[]): void {
  fallbackBinariesOverride = paths ?? null;
  fallbackWinRootsOverride = null;
}

/**
 * Test helper: point the Windows installation discovery probe at fixture roots, or call
 * with no argument to restore the default search roots.
 */
export function setKicadFallbackWinRoots(roots?: readonly string[]): void {
  fallbackWinRootsOverride = roots ?? null;
  fallbackBinariesOverride = null;
}

export async function kicadCliVersion(): Promise<string> {
  const res = await runKicad(['version']);
  return String(res.stdout ?? '').trim();
}

async function runCheck(
  kind: 'erc' | 'drc',
  filePath: string,
  extraArgs: string[] = [],
): Promise<CheckReport> {
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-'));
  const out = path.join(dir, `${kind}.json`);
  const sub = kind === 'erc' ? ['sch', 'erc'] : ['pcb', 'drc'];
  try {
    const res = await runKicad(
      [...sub, '--format', 'json', '--exit-code-violations', '--output', out, ...extraArgs, filePath],
      { reject: false },
    );
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(out, 'utf8'));
    } catch {
      // No report on disk means kicad-cli bailed before checking — usually the
      // design file itself failed to load (syntax/schema corruption). The
      // raw readFile ENOENT told the agent nothing actionable; kicad-cli's
      // own output at least names the failure.
      const detail = [res.stderr, res.stdout].filter(Boolean).join('\n').trim();
      throw new Error(
        `kicad-cli ${kind} produced no report — the ${kind === 'erc' ? 'schematic' : 'board'} file likely fails to load in KiCad. kicad-cli output: ${detail || '(none)'}`,
      );
    }
    return normalizeReport(raw, kind);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function runErc(schPath: string): Promise<CheckReport> {
  return runCheck('erc', schPath);
}

/**
 * Cheap loadability probe for a KiCad file: asks kicad-cli for a throwaway
 * export and reports the failure text if the file won't load. Text edits on
 * s-expression sources can silently corrupt the file; catching that at edit
 * time (with KiCad's own error) beats an opaque failure at ERC/DRC time.
 * Returns null when the file loads.
 */
/**
 * Only schematics and boards have a cheap standalone load probe. Project
 * files and symbol/footprint libraries do not: feeding them to a sch/pcb
 * export "probe" would reject perfectly good files.
 */
export function isProbeableKicadFile(p: string): boolean {
  return /\.kicad_(sch|pcb)$/.test(p);
}

export async function kicadLoadError(filePath: string): Promise<string | null> {
  if (!isProbeableKicadFile(filePath)) return null;
  const isSch = filePath.endsWith('.kicad_sch');
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-validate-'));
  const args = isSch
    ? ['sch', 'export', 'netlist', '--output', path.join(dir, 'probe.net'), filePath]
    : ['pcb', 'export', 'pos', '--output', path.join(dir, 'probe.pos'), filePath];
  try {
    const res = await runKicad(args, { reject: false });
    if (res.exitCode === 0) return null;
    return [res.stderr, res.stdout].filter(Boolean).join('\n').trim() || `kicad-cli exited ${res.exitCode}`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function runDrc(pcbPath: string): Promise<CheckReport> {
  return runCheck('drc', pcbPath);
}

export interface FabExportResult {
  produced: string[];
  failed: { artifact: string; reason: string }[];
}

/**
 * Export the fabrication package (SPEC §2.5 outputs): gerbers + drill, DXF and
 * STEP outline, SVG renders. Each artifact fails independently with a reason so
 * a missing STEP exporter never sinks the rest of the package.
 */
export async function exportFab(pcbPath: string, schPath: string | null, outDir: string): Promise<FabExportResult> {
  const result: FabExportResult = { produced: [], failed: [] };
  const jobs: { artifact: string; args: string[] }[] = [
    { artifact: 'gerbers', args: ['pcb', 'export', 'gerbers', '--output', path.join(outDir, 'gerbers'), pcbPath] },
    { artifact: 'drill', args: ['pcb', 'export', 'drill', '--output', path.join(outDir, 'gerbers'), pcbPath] },
    { artifact: 'outline.dxf', args: ['pcb', 'export', 'dxf', '--output', path.join(outDir, 'outline.dxf'), '--layers', 'Edge.Cuts', pcbPath] },
    { artifact: 'board.step', args: ['pcb', 'export', 'step', '--output', path.join(outDir, 'board.step'), pcbPath] },
    { artifact: 'board.svg', args: ['pcb', 'export', 'svg', '--output', path.join(outDir, 'board.svg'), '--layers', 'F.Cu,B.Cu,Edge.Cuts', pcbPath] },
  ];
  if (schPath) {
    jobs.push({ artifact: 'schematic.svg', args: ['sch', 'export', 'svg', '--output', path.join(outDir, 'renders'), schPath] });
  }
  for (const job of jobs) {
    try {
      await runKicad(job.args);
      result.produced.push(job.artifact);
    } catch (err) {
      if (err instanceof KicadCliMissingError) throw err;
      result.failed.push({ artifact: job.artifact, reason: String((err as ExecaError).stderr ?? (err as Error).message).slice(0, 200) });
    }
  }
  return result;
}

/** Export an SVG render of a schematic or board; returns the output directory. */
export async function exportSvg(kind: 'sch' | 'pcb', filePath: string, outDir: string): Promise<string> {
  const args =
    kind === 'sch'
      ? ['sch', 'export', 'svg', '--output', outDir, filePath]
      : ['pcb', 'export', 'svg', '--output', path.join(outDir, 'board.svg'), '--layers', 'F.Cu,B.Cu,Edge.Cuts', filePath];
  try {
    await runKicad(args);
  } catch (err) {
    if (err instanceof KicadCliMissingError) throw err;
    throw err;
  }
  return outDir;
}
