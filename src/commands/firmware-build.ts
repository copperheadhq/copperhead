import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { resolveInRepo } from '../util/paths.js';
import { ensureIgnored } from '../util/git.js';

/** Supplied by the operator's CLI, never selected by model tool arguments. */
export interface FirmwareToolchain {
  idfRoot: string;
  toolsRoot: string;
  reproducible?: boolean;
}
interface FileHash { path: string; sha256: string; bytes: number }
interface BuildReceipt {
  version: 1;
  ok: boolean;
  toolchain: FirmwareToolchain;
  sdkFingerprint: string;
  sources: FileHash[];
  outputs: FileHash[];
  attempts: { directory: string; exitCode: number; log: string; startedAt: string; finishedAt: string; command: string[] }[];
  reproducible: boolean;
  reason: string | null;
}
const digest = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const receiptPath = '.copperhead/firmware-build/receipt.json';

async function safeFile(root: string, rel: string): Promise<Buffer> {
  const p = resolveInRepo(root, rel);
  const actualRoot = await realpath(root);
  const actual = await realpath(p);
  if (!actual.startsWith(actualRoot + path.sep) || (await lstat(p)).isSymbolicLink()) {
    throw new Error(`firmware build input/output escapes repository or is a symlink: ${rel}`);
  }
  return readFile(p);
}

async function safeDirectory(root: string, rel: string): Promise<string> {
  const absolute = resolveInRepo(root, rel);
  let p = path.resolve(root);
  for (const name of path.relative(p, absolute).split(path.sep).filter(Boolean)) {
    p = path.join(p, name);
    if (existsSync(p)) {
      const item = await lstat(p);
      if (item.isSymbolicLink() || !item.isDirectory()) throw new Error(`Build directory is not a real repository directory: ${p}`);
    } else await mkdir(p);
  }
  return absolute;
}

async function sources(root: string, docs: string): Promise<FileHash[]> {
  const files: FileHash[] = [];
  if ((await lstat(resolveInRepo(root, 'firmware'))).isSymbolicLink()) throw new Error('Firmware source directory must not be a symlink.');
  async function walk(rel: string): Promise<void> {
    for (const entry of await readdir(resolveInRepo(root, rel), { withFileTypes: true })) {
      const name = path.posix.join(rel, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`firmware source symlink is unsupported: ${name}`);
      if (entry.isDirectory()) {
        if (!['build', '.git', 'managed_components'].includes(entry.name)) await walk(name);
      } else if (entry.isFile()) {
        const b = await safeFile(root, name);
        files.push({ path: name, sha256: digest(b), bytes: b.length });
      }
    }
  }
  await walk('firmware');
  const pinout = path.posix.join(docs, 'PINOUT.md');
  const b = await safeFile(root, pinout);
  files.push({ path: pinout, sha256: digest(b), bytes: b.length });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function identity(toolchain: FirmwareToolchain): Promise<{ toolchain: FirmwareToolchain; fingerprint: string }> {
  const normalized = { idfRoot: await realpath(toolchain.idfRoot), toolsRoot: await realpath(toolchain.toolsRoot), reproducible: toolchain.reproducible ?? false };
  const idf = await readFile(path.join(normalized.idfRoot, 'tools/idf.py'));
  const activation = await readFile(path.join(normalized.idfRoot, 'export.sh'));
  return { toolchain: normalized, fingerprint: digest(Buffer.concat([idf, activation])) };
}

/** Source/binary freshness is required on both finish and the normal resume path. */
export async function firmwareBuildGap(root: string, docs: string, toolchain: FirmwareToolchain): Promise<string | null> {
  try {
    const receipt = JSON.parse((await safeFile(root, receiptPath)).toString()) as BuildReceipt;
    const current = await identity(toolchain);
    if (receipt.version !== 1 || !receipt.ok || JSON.stringify(receipt.toolchain) !== JSON.stringify(current.toolchain) || receipt.sdkFingerprint !== current.fingerprint) {
      return 'ESP-IDF build evidence is missing, failed or from a different toolchain; call build_firmware.';
    }
    if (JSON.stringify(receipt.sources) !== JSON.stringify(await sources(root, docs))) return 'Firmware/PINOUT inputs changed after compilation; call build_firmware again.';
    if (!receipt.outputs.length) return 'Build produced no binary evidence; call build_firmware.';
    if (receipt.attempts.length !== (toolchain.reproducible ? 2 : 1) || receipt.attempts.some(a => a.exitCode !== 0)) return 'Build attempt evidence is incomplete or failed; call build_firmware.';
    const artifactSets: Record<string, string>[] = [];
    for (const attempt of receipt.attempts) {
      if (!/^\.copperhead\/firmware-build\/[\w-]+\/attempt-[12]$/.test(attempt.directory)) return 'Build attempt path is invalid; call build_firmware.';
      const prefix = attempt.directory + '/build/';
      const items = receipt.outputs.filter(item => item.path.startsWith(prefix));
      const names = items.map(item => item.path.slice(prefix.length));
      if (!names.includes('bootloader/bootloader.bin') || !names.includes('partition_table/partition-table.bin') ||
          !names.some(n => !n.includes('/') && n.endsWith('.elf')) || !names.some(n => !n.includes('/') && n.endsWith('.bin'))) return 'Required ELF/application/bootloader/partition binaries are missing; call build_firmware.';
      artifactSets.push(Object.fromEntries(items.map(item => [item.path.slice(prefix.length), item.sha256]).sort(([a], [b]) => a!.localeCompare(b!))));
    }
    for (const item of receipt.outputs) {
      const b = await safeFile(root, item.path);
      if (!b.length || b.length !== item.bytes || digest(b) !== item.sha256) return 'Build binaries are missing, empty or changed; call build_firmware.';
    }
    if (toolchain.reproducible && (!receipt.reproducible || JSON.stringify(artifactSets[0]) !== JSON.stringify(artifactSets[1]))) return 'Two independent builds did not produce identical binaries; configure reproducibility and call build_firmware.';
    return null;
  } catch (error) {
    return `No current successful ESP-IDF build evidence: ${(error as Error).message}. Call build_firmware.`;
  }
}

/** Keep only this tool's managed compiler intermediates out of stage commits.
 * Existing tracked copies are untracked without deleting bytes or rewriting history.
 */
export async function prepareFirmwareBuildArtifacts(root: string): Promise<void> {
  const ignore = resolveInRepo(root, '.gitignore');
  if (existsSync(ignore)) await safeFile(root, '.gitignore');
  await ensureIgnored(root, ['.copperhead/firmware-build/']);
  if (!(await readFile(ignore, 'utf8')).split('\n').includes('.copperhead/firmware-build/')) {
    throw new Error('Cannot ignore managed firmware build artifacts; correct .gitignore permissions before resuming.');
  }
  const tracked = await execa('git', ['ls-files', '--', '.copperhead/firmware-build'], { cwd: root });
  if (tracked.stdout.trim()) await execa('git', ['rm', '-r', '--cached', '--ignore-unmatch', '--', '.copperhead/firmware-build'], { cwd: root });
}

/** Only activate the installed SDK and run idf.py build; never install or flash. */
export async function buildFirmware(root: string, docs: string, configured: FirmwareToolchain): Promise<{ ok: boolean; text: string }> {
  if (process.platform === 'win32') throw new Error('This explicit ESP-IDF adapter requires a POSIX shell; default firmware behavior is unchanged.');
  if (!existsSync(resolveInRepo(root, 'firmware/CMakeLists.txt'))) throw new Error('Write the real ESP-IDF firmware/CMakeLists.txt before building.');
  const current = await identity(configured);
  const input = await sources(root, docs);
  const base = `.copperhead/firmware-build/${randomUUID()}`;
  const receipt: BuildReceipt = { version: 1, ok: false, toolchain: current.toolchain, sdkFingerprint: current.fingerprint,
    sources: input, outputs: [], attempts: [], reproducible: false, reason: null };
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|API_KEY|^(CODEX|CLAUDE|OPENAI|ANTHROPIC)_/.test(key)) delete env[key];
  delete env.LD_LIBRARY_PATH;
  delete env.DYLD_LIBRARY_PATH;
  Object.assign(env, { IDF_PATH: current.toolchain.idfRoot, IDF_TOOLS_PATH: current.toolchain.toolsRoot, IDF_COMPONENT_MANAGER: '0', PYTHONNOUSERSITE: '1' });
  const hashes: Record<string, string>[] = [];
  try {
    for (let n = 1; n <= (configured.reproducible ? 2 : 1); n++) {
      const rel = `${base}/attempt-${n}`;
      const directory = resolveInRepo(root, rel);
      await safeDirectory(root, `${rel}/source`);
      for (const item of input) {
        const destination = path.join(directory, 'source', item.path);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, await safeFile(root, item.path));
      }
      const project = path.join(directory, 'source/firmware');
      const build = path.join(directory, 'build');
      const log = `${rel}/build.log`;
      // Paths enter through env, not interpolated shell code. No tool arguments
      // can choose an executable, add flags, install dependencies or flash.
      const command = ['bash', '-c', 'source "$IDF_PATH/export.sh" >/dev/null && python "$IDF_PATH/tools/idf.py" --version && exec python "$IDF_PATH/tools/idf.py" -B "$COPPERHEAD_BUILD_DIRECTORY" build'];
      const startedAt = new Date().toISOString();
      const result = await execa(command[0]!, command.slice(1), {
        cwd: project, env: { ...env, COPPERHEAD_BUILD_DIRECTORY: build }, all: true, reject: false, timeout: 600_000, maxBuffer: 16 * 1024 * 1024,
      });
      await writeFile(resolveInRepo(root, log), result.all ?? '');
      receipt.attempts.push({ directory: rel, exitCode: result.exitCode ?? -1, log, startedAt, finishedAt: new Date().toISOString(), command });
      if (result.exitCode !== 0 || result.timedOut) {
        receipt.reason = `ESP-IDF build failed${result.timedOut ? ' (timeout)' : ''}; inspect ${log}.\n${(result.all ?? '').slice(-12000)}`;
        break;
      }
      const bins = (await readdir(build)).filter(name => /\.(bin|elf)$/.test(name));
      bins.push('bootloader/bootloader.bin', 'partition_table/partition-table.bin');
      if (!bins.some(name => name.endsWith('.elf')) || !bins.some(name => name.endsWith('.bin') && !name.includes('/'))) throw new Error('Successful compiler exit produced no application ELF/bin.');
      const map: Record<string, string> = {};
      for (const name of bins.sort()) {
        const filename = path.posix.join(rel, 'build', name);
        const b = await safeFile(root, filename);
        if (!b.length) throw new Error(`Empty build output: ${filename}`);
        map[name] = digest(b);
        receipt.outputs.push({ path: filename, sha256: map[name]!, bytes: b.length });
      }
      hashes.push(map);
    }
    if (!receipt.reason && hashes.length === (configured.reproducible ? 2 : 1)) {
      receipt.reproducible = hashes.length === 2 && JSON.stringify(hashes[0]) === JSON.stringify(hashes[1]);
      if (configured.reproducible && !receipt.reproducible) receipt.reason = 'Two real independent builds differ. Enable SDK reproducible build configuration and a fixed PROJECT_VER; no reproducibility success is claimed.';
      else receipt.ok = true;
    }
    if (JSON.stringify(input) !== JSON.stringify(await sources(root, docs))) { receipt.ok = false; receipt.reason = 'Live firmware/PINOUT changed during the build; re-run against stable inputs.'; }
  } catch (error) { receipt.ok = false; receipt.reason = (error as Error).message; }
  await safeDirectory(root, '.copperhead/firmware-build');
  await writeFile(resolveInRepo(root, receiptPath), JSON.stringify(receipt, null, 2) + '\n');
  return { ok: receipt.ok, text: receipt.ok ? `ESP-IDF build passed${receipt.reproducible ? '; two independent builds produced identical ELF/bin outputs' : ''}. Source/binary hashes and real logs: ${receiptPath}` : `Build NOT verified: ${receipt.reason}\nEvidence: ${receiptPath}` };
}
