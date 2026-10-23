import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { redactSecrets } from '../util/redact.js';

const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const STATE_RELATIVE_PATH = '.copperhead/brief-reconciliation.json';
let atomicWriteSequence = 0;

export interface BriefRefusal {
  briefSha256: string;
  id: string;
  change: string;
  rationale: string;
}

export interface BriefReconciliationRecord {
  schemaVersion: 1;
  briefPath: string;
  sha256: string;
  gitBlob: string;
  refusals: BriefRefusal[];
}

export interface BriefFreshness {
  status: 'current' | 'stale' | 'unknown' | 'legacy' | 'not-applicable';
  reasonCode?: 'legacy-origin-without-reconciliation' | 'legacy-external-origin' | 'legacy-brief-without-origin' | 'invalid-origin' | 'invalid-record';
  ok: boolean;
  path: string | null;
  reconciledSha256: string | null;
  originSha256: string | null;
  currentSha256: string | null;
  refused: { briefSha256: string; id: string; change: string; rationale: string }[];
  detail?: string;
}

export interface BriefChange {
  id: string;
  before: string;
  after: string;
}

export interface BriefComparison {
  status: 'current' | 'stale' | 'unknown' | 'legacy';
  path: string | null;
  baseline: 'reconciled' | 'origin' | null;
  currentSha256: string | null;
  baselineSha256: string | null;
  items: BriefChange[];
  currentText?: string;
  refusals: BriefRefusal[];
  detail?: string;
}

interface OriginRecord {
  briefPath: string;
  sha256: string;
}

interface ReadResult<T> {
  value: T | null;
  detail?: string;
}

function hashText(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n?/g, '\n')).digest('hex');
}

function originHashMatches(text: string, originSha256: string): boolean {
  const lf = text.replace(/\r\n?/g, '\n');
  return [lf, text, lf.replace(/\n/g, '\r\n')].some(
    (form) => createHash('sha256').update(form).digest('hex') === originSha256,
  );
}

function gitOptions(repoRoot: string) {
  return { cwd: repoRoot, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } };
}

function insideRepoPath(repoRoot: string, relativePath: string): string | null {
  if (!relativePath || relativePath.startsWith('external:')) return null;
  const portablePath = relativePath.replaceAll('\\', '/');
  if (path.isAbsolute(relativePath) || path.posix.isAbsolute(portablePath) || /^[A-Za-z]:\//.test(portablePath)) return null;
  if (portablePath.split('/').some((part) => part === '..' || part === '.')) return null;
  const absolute = path.resolve(repoRoot, portablePath);
  const relative = path.relative(path.resolve(repoRoot), absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

async function readRepoFile(repoRoot: string, relativePath: string): Promise<ReadResult<{ text: string; path: string }>> {
  const safePath = insideRepoPath(repoRoot, relativePath);
  if (!safePath) return { value: null, detail: 'brief path is external or outside the repository' };
  try {
    const rootReal = await realpath(repoRoot);
    const absolute = path.join(repoRoot, safePath);
    const fileReal = await realpath(absolute);
    const expectedFile = path.resolve(rootReal, safePath);
    if (fileReal !== expectedFile) return { value: null, detail: 'brief path uses a symlink and is not trackable' };
    const resolved = path.relative(rootReal, fileReal);
    if (!resolved || resolved.startsWith('..') || path.isAbsolute(resolved)) {
      return { value: null, detail: 'brief path resolves outside the repository' };
    }
    return { value: { text: await readFile(fileReal, 'utf8'), path: safePath } };
  } catch {
    return { value: null, detail: 'brief file is missing or unreadable' };
  }
}

async function readOrigin(repoRoot: string, docsDir: string): Promise<ReadResult<OriginRecord>> {
  const file = path.join(repoRoot, docsDir, 'BRIEF.sha256');
  if (!existsSync(file)) return { value: null };
  const relativePath = path.relative(repoRoot, file).split(path.sep).join('/');
  const originFile = await readRepoFile(repoRoot, relativePath);
  if (!originFile.value) return { value: null, detail: originFile.detail ?? 'origin brief provenance is unreadable' };
  const rawBriefPath = /^brief:[ \t]*(.+?)[ \t]*$/m.exec(originFile.value.text)?.[1]?.trim();
  const briefPath = rawBriefPath?.startsWith('external:') ? rawBriefPath : rawBriefPath?.replaceAll('\\', '/');
  const sha256 = /^sha256:[ \t]*([0-9a-f]{64})[ \t]*$/im.exec(originFile.value.text)?.[1]?.toLowerCase();
  if (!briefPath || !sha256) return { value: null, detail: 'origin brief provenance is malformed' };
  return { value: { briefPath, sha256 } };
}

function parseRecord(value: unknown): BriefReconciliationRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<BriefReconciliationRecord>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.briefPath !== 'string' ||
    typeof record.sha256 !== 'string' ||
    !SHA256_RE.test(record.sha256) ||
    typeof record.gitBlob !== 'string' ||
    !GIT_OID_RE.test(record.gitBlob) ||
    !Array.isArray(record.refusals)
  ) {
    return null;
  }
  const refusals: BriefRefusal[] = [];
  for (const entry of record.refusals) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof (entry as BriefRefusal).briefSha256 !== 'string' ||
      !SHA256_RE.test((entry as BriefRefusal).briefSha256) ||
      typeof (entry as BriefRefusal).id !== 'string' ||
      !/^B[1-9]\d*$/.test((entry as BriefRefusal).id) ||
      typeof (entry as BriefRefusal).change !== 'string' ||
      typeof (entry as BriefRefusal).rationale !== 'string' ||
      !(entry as BriefRefusal).rationale.trim()
    ) {
      return null;
    }
    refusals.push({
      briefSha256: (entry as BriefRefusal).briefSha256,
      id: (entry as BriefRefusal).id,
      change: (entry as BriefRefusal).change,
      rationale: (entry as BriefRefusal).rationale,
    });
  }
  return {
    schemaVersion: 1,
    briefPath: record.briefPath.replaceAll('\\', '/'),
    sha256: record.sha256,
    gitBlob: record.gitBlob,
    refusals,
  };
}

async function readRecord(repoRoot: string): Promise<ReadResult<BriefReconciliationRecord>> {
  const file = path.join(repoRoot, STATE_RELATIVE_PATH);
  if (!existsSync(file)) return { value: null };
  try {
    const rootReal = await realpath(repoRoot);
    const fileReal = await realpath(file);
    const relative = path.relative(rootReal, fileReal);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return { value: null, detail: 'brief reconciliation record resolves outside the repository' };
    }
    const parsed = JSON.parse(await readFile(fileReal, 'utf8')) as unknown;
    const record = parseRecord(parsed);
    if (!record || !insideRepoPath(repoRoot, record.briefPath)) {
      return { value: null, detail: 'brief reconciliation record is malformed' };
    }
    const baseline = await gitBlob(repoRoot, record.gitBlob);
    if (!baseline || hashText(baseline) !== record.sha256) {
      return { value: null, detail: 'recorded brief baseline is unavailable or corrupt locally; Git lazy fetching is disabled to keep check network-free' };
    }
    return { value: record };
  } catch {
    return { value: null, detail: 'brief reconciliation record is unreadable' };
  }
}

async function gitBlob(repoRoot: string, oid: string): Promise<string | null> {
  try {
    const { stdout } = await execa('git', ['cat-file', 'blob', oid], { ...gitOptions(repoRoot), stripFinalNewline: false });
    return stdout;
  } catch {
    return null;
  }
}

async function blobAtCommit(repoRoot: string, commit: string, relativePath: string): Promise<{ oid: string; text: string } | null> {
  try {
    const { stdout } = await execa('git', ['ls-tree', '-z', commit, '--', `:(literal)${relativePath}`], gitOptions(repoRoot));
    const entry = stdout.split('\0').find(Boolean);
    if (!entry) return null;
    const tab = entry.indexOf('\t');
    const [mode, type, oid] = entry.slice(0, tab).split(' ');
    if (mode === '040000' || type !== 'blob' || !GIT_OID_RE.test(oid ?? '')) return null;
    const text = await gitBlob(repoRoot, oid!);
    return text === null ? null : { oid: oid!, text };
  } catch {
    return null;
  }
}

async function headBlob(repoRoot: string, relativePath: string): Promise<{ oid: string; text: string } | null> {
  return blobAtCommit(repoRoot, 'HEAD', relativePath);
}

async function recoverOriginBlob(
  repoRoot: string,
  relativePath: string,
  expectedSha256: string,
): Promise<{ oid: string; text: string } | null> {
  const safePath = insideRepoPath(repoRoot, relativePath);
  if (!safePath) return null;
  try {
    const { stdout } = await execa('git', ['log', '--all', '--format=%H', '--', `:(literal)${safePath}`], gitOptions(repoRoot));
    for (const commit of stdout.split('\n').filter(Boolean)) {
      const blob = await blobAtCommit(repoRoot, commit, safePath);
      if (blob && originHashMatches(blob.text, expectedSha256)) return blob;
    }
  } catch {
    return null;
  }
  return null;
}

function changedBlocks(before: string, after: string): BriefChange[] {
  const oldLines = before.replace(/\r\n?/g, '\n').split('\n');
  const newLines = after.replace(/\r\n?/g, '\n').split('\n');
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  if ((oldCount + 1) * (newCount + 1) > 4_000_000) {
    throw new Error('brief is too large for a deterministic in-memory comparison');
  }
  const width = newCount + 1;
  const lcs = new Uint32Array((oldCount + 1) * width);
  for (let i = oldCount - 1; i >= 0; i--) {
    for (let j = newCount - 1; j >= 0; j--) {
      const index = i * width + j;
      lcs[index] =
        oldLines[i] === newLines[j]
          ? 1 + lcs[(i + 1) * width + j + 1]!
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const blocks: { before: string[]; after: string[] }[] = [];
  let current: { before: string[]; after: string[] } | null = null;
  const flush = (): void => {
    if (current) blocks.push(current);
    current = null;
  };
  let i = 0;
  let j = 0;
  while (i < oldCount || j < newCount) {
    if (i < oldCount && j < newCount && oldLines[i] === newLines[j]) {
      flush();
      i++;
      j++;
    } else {
      current ??= { before: [], after: [] };
      if (i < oldCount && (j >= newCount || lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) {
        current.before.push(oldLines[i++]!);
      } else if (j < newCount) {
        current.after.push(newLines[j++]!);
      }
    }
  }
  flush();
  if (!blocks.length && before.replace(/\r\n?/g, '\n') !== after.replace(/\r\n?/g, '\n')) {
    blocks.push({ before: ['(line-ending-only change)'], after: ['(line-ending-only change)'] });
  }
  return blocks.map((block, index) => ({
    id: `B${index + 1}`,
    before: block.before.join('\n'),
    after: block.after.join('\n'),
  }));
}

export async function inspectBriefFreshness(repoRoot: string, docsDir: string): Promise<BriefFreshness> {
  const origin = await readOrigin(repoRoot, docsDir);
  const stateFile = path.join(repoRoot, STATE_RELATIVE_PATH);
  const hasState = existsSync(stateFile);
  const noRefusals: BriefFreshness['refused'] = [];
  if (origin.detail) {
    return { status: 'unknown', ok: false, reasonCode: 'invalid-origin', path: null, reconciledSha256: null, originSha256: null, currentSha256: null, refused: noRefusals, detail: origin.detail };
  }
  const record = await readRecord(repoRoot);
  if (hasState && !record.value) {
    return {
      status: 'unknown',
      ok: false,
      reasonCode: 'invalid-record',
      path: null,
      reconciledSha256: null,
      originSha256: origin.value?.sha256 ?? null,
      currentSha256: null,
      refused: noRefusals,
      detail: record.detail ?? 'brief reconciliation record is invalid',
    };
  }
  if (record.value) {
    if (!origin.value || (!origin.value.briefPath.startsWith('external:') && record.value.briefPath !== origin.value.briefPath)) {
      return { status: 'unknown', ok: false, reasonCode: 'invalid-record', path: record.value.briefPath, reconciledSha256: record.value.sha256, originSha256: origin.value?.sha256 ?? null, currentSha256: null, refused: record.value.refusals, detail: 'origin brief provenance is missing or does not match the reconciliation record' };
    }
    const current = await readRepoFile(repoRoot, record.value.briefPath);
    if (!current.value) {
      return { status: 'unknown', ok: false, path: record.value.briefPath, reconciledSha256: record.value.sha256, originSha256: origin.value?.sha256 ?? null, currentSha256: null, refused: record.value.refusals, detail: current.detail };
    }
    const currentSha256 = hashText(current.value.text);
    const status = currentSha256 === record.value.sha256 ? 'current' : 'stale';
    return {
      status,
      ok: status === 'current',
      path: record.value.briefPath,
      reconciledSha256: record.value.sha256,
      originSha256: origin.value?.sha256 ?? null,
      currentSha256,
      refused: record.value.refusals,
      ...(status === 'stale' ? { detail: 'brief changed since its last reconciliation; run copperhead sync --brief' } : {}),
    };
  }
  if (origin.value) {
    if (origin.value.briefPath.startsWith('external:')) {
      const conventionalPath = path.posix.join(docsDir.split(path.sep).join('/'), 'BRIEF.md');
      const conventional = await readRepoFile(repoRoot, conventionalPath);
      if (!conventional.value && existsSync(path.join(repoRoot, conventionalPath))) {
        return { status: 'unknown', ok: false, reasonCode: 'invalid-origin', path: conventionalPath, reconciledSha256: null, originSha256: origin.value.sha256, currentSha256: null, refused: noRefusals, detail: conventional.detail ?? 'repository-local brief is not trackable' };
      }
      if (conventional.value) {
        const currentSha256 = hashText(conventional.value.text);
        const differs = !originHashMatches(conventional.value.text, origin.value.sha256);
        return {
          status: 'legacy',
          ok: true,
          reasonCode: 'legacy-external-origin',
          path: conventionalPath,
          reconciledSha256: null,
          originSha256: origin.value.sha256,
          currentSha256,
          refused: noRefusals,
          detail: differs
            ? `repository-local brief differs from its external origin; run copperhead create --brief ${conventionalPath} to establish a tracked baseline`
            : `legacy external brief origin has no reconciliation record; run copperhead create --brief ${conventionalPath} to establish a tracked baseline`,
        };
      }
      return { status: 'legacy', ok: true, reasonCode: 'legacy-external-origin', path: null, reconciledSha256: null, originSha256: origin.value.sha256, currentSha256: null, refused: noRefusals, detail: `legacy external brief origin has no reconciliation record; copy it to ${conventionalPath}, then run copperhead create --brief ${conventionalPath} to establish a tracked baseline` };
    }
    const current = await readRepoFile(repoRoot, origin.value.briefPath);
    if (!current.value) {
      return { status: 'unknown', ok: false, reasonCode: 'invalid-origin', path: origin.value.briefPath, reconciledSha256: null, originSha256: origin.value.sha256, currentSha256: null, refused: noRefusals, detail: current.detail ?? 'origin brief is unavailable locally' };
    }
    const currentSha256 = hashText(current.value.text);
    if (!originHashMatches(current.value.text, origin.value.sha256)) {
      return { status: 'stale', ok: false, path: origin.value.briefPath, reconciledSha256: null, originSha256: origin.value.sha256, currentSha256, refused: noRefusals, detail: 'brief changed from its immutable origin; run copperhead sync --brief' };
    }
    return {
      status: 'legacy',
      ok: true,
      reasonCode: 'legacy-origin-without-reconciliation',
      path: origin.value.briefPath,
      reconciledSha256: null,
      originSha256: origin.value.sha256,
      currentSha256,
      refused: noRefusals,
      detail: `legacy origin has no last-reconciled record; rerun copperhead create --brief ${origin.value.briefPath} to establish the baseline`,
    };
  }
  const conventionalPath = path.posix.join(docsDir.split(path.sep).join('/'), 'BRIEF.md');
  const conventional = await readRepoFile(repoRoot, conventionalPath);
  if (conventional.value) {
    return { status: 'legacy', ok: true, reasonCode: 'legacy-brief-without-origin', path: conventionalPath, reconciledSha256: null, originSha256: null, currentSha256: conventional.value ? hashText(conventional.value.text) : null, refused: noRefusals, detail: 'brief has no origin or reconciliation record; complete create to establish tracked provenance' };
  }
  if (existsSync(path.join(repoRoot, conventionalPath))) {
    return { status: 'unknown', ok: false, reasonCode: 'invalid-origin', path: conventionalPath, reconciledSha256: null, originSha256: null, currentSha256: null, refused: noRefusals, detail: conventional.detail ?? 'repository-local brief is not trackable' };
  }
  return { status: 'not-applicable', ok: true, path: null, reconciledSha256: null, originSha256: null, currentSha256: null, refused: noRefusals };
}

export async function compareBrief(repoRoot: string, docsDir: string): Promise<BriefComparison> {
  const origin = await readOrigin(repoRoot, docsDir);
  if (origin.detail) return { status: 'unknown', path: null, baseline: null, currentSha256: null, baselineSha256: null, items: [], refusals: [], detail: origin.detail };
  const stateFile = path.join(repoRoot, STATE_RELATIVE_PATH);
  const hasState = existsSync(stateFile);
  const record = await readRecord(repoRoot);
  if (hasState && !record.value) return { status: 'unknown', path: null, baseline: null, currentSha256: null, baselineSha256: null, items: [], refusals: [], detail: record.detail ?? 'brief reconciliation record is invalid' };
  if (!record.value && origin.value?.briefPath.startsWith('external:')) {
    return { status: 'legacy', path: null, baseline: null, currentSha256: null, baselineSha256: origin.value.sha256, items: [], refusals: [], detail: 'external origin brief cannot be compared locally; move it into the repository and complete create to establish a tracked baseline' };
  }
  if (!record.value && !origin.value) {
    const conventionalPath = path.posix.join(docsDir.split(path.sep).join('/'), 'BRIEF.md');
    const conventional = await readRepoFile(repoRoot, conventionalPath);
    if (conventional.value) return { status: 'legacy', path: conventionalPath, baseline: null, currentSha256: hashText(conventional.value.text), baselineSha256: null, items: [], currentText: conventional.value.text, refusals: [], detail: 'brief has no origin or reconciliation record; complete create to establish tracked provenance' };
    return { status: 'unknown', path: null, baseline: null, currentSha256: null, baselineSha256: null, items: [], refusals: [], detail: 'immutable origin brief provenance is missing' };
  }
  const briefPath = record.value?.briefPath ?? origin.value!.briefPath;
  const current = await readRepoFile(repoRoot, briefPath);
  if (!current.value) return { status: 'unknown', path: briefPath.startsWith('external:') ? null : briefPath, baseline: null, currentSha256: null, baselineSha256: record.value?.sha256 ?? origin.value?.sha256 ?? null, items: [], refusals: record.value?.refusals ?? [], detail: current.detail };
  const currentSha256 = hashText(current.value.text);
  let baseline: { oid: string; text: string } | null = null;
  let baselineKind: BriefComparison['baseline'] = null;
  let baselineSha256: string | null = null;
  if (record.value) {
    if (!origin.value || (!origin.value.briefPath.startsWith('external:') && record.value.briefPath !== origin.value.briefPath)) return { status: 'unknown', path: briefPath, baseline: null, currentSha256, baselineSha256: record.value.sha256, items: [], refusals: record.value.refusals, detail: 'origin brief provenance is missing or does not match the reconciliation record' };
    baseline = await gitBlob(repoRoot, record.value.gitBlob).then((text) => text === null ? null : { oid: record.value!.gitBlob, text });
    baselineKind = 'reconciled';
    baselineSha256 = record.value.sha256;
  } else {
    if (!origin.value) return { status: 'unknown', path: briefPath, baseline: null, currentSha256, baselineSha256: null, items: [], refusals: [], detail: 'immutable origin brief provenance is missing' };
    if (origin.value.briefPath.startsWith('external:')) return { status: 'legacy', path: null, baseline: null, currentSha256, baselineSha256: origin.value.sha256, items: [], refusals: [], detail: 'external origin brief cannot be compared locally; move it into the repository and complete create to establish a tracked baseline' };
    baseline = await recoverOriginBlob(repoRoot, origin.value.briefPath, origin.value.sha256);
    baselineKind = 'origin';
    baselineSha256 = origin.value.sha256;
  }
  if (!baseline || (baselineKind === 'origin' ? !originHashMatches(baseline.text, baselineSha256!) : hashText(baseline.text) !== baselineSha256)) {
    return { status: 'unknown', path: briefPath, baseline: baselineKind, currentSha256, baselineSha256, items: [], refusals: record.value?.refusals ?? [], detail: 'recorded brief baseline is unavailable from local Git history; lazy fetching is disabled to keep check network-free' };
  }
  let items: BriefChange[];
  try {
    items = changedBlocks(baseline.text, current.value.text);
  } catch (err) {
    return { status: 'unknown', path: briefPath, baseline: baselineKind, currentSha256, baselineSha256, items: [], refusals: record.value?.refusals ?? [], detail: (err as Error).message };
  }
  if (!record.value && items.length === 0) {
    return { status: 'legacy', path: briefPath, baseline: 'origin', currentSha256, baselineSha256, items, refusals: [], currentText: current.value.text, detail: 'legacy origin matches the brief but has no reconciliation record; complete create to establish the initial baseline' };
  }
  return {
    status: currentSha256 === baselineSha256 ? 'current' : 'stale',
    path: briefPath,
    baseline: baselineKind,
    currentSha256,
    baselineSha256,
    items,
    currentText: current.value.text,
    refusals: record.value?.refusals ?? [],
    ...(items.length || currentSha256 === baselineSha256 ? {} : { detail: 'brief hashes differ only in line-ending representation' }),
  };
}

export async function trackedCurrentBrief(
  repoRoot: string,
  relativePath: string,
  expectedSha256: string,
  opts: { allowWorktreeChange?: boolean } = {},
): Promise<{ gitBlob: string; text: string } | null> {
  const current = await readRepoFile(repoRoot, relativePath);
  if (!current.value || hashText(current.value.text) !== expectedSha256) return null;
  const blob = await headBlob(repoRoot, current.value.path);
  if (!blob) return null;
  if (hashText(blob.text) === expectedSha256) return { gitBlob: blob.oid, text: current.value.text };
  if (!opts.allowWorktreeChange) return null;

  // Stage only after the agent has passed its finish gates. This yields the
  // exact blob Git will commit, including any configured clean filters. Refuse
  // filters that change the brief bytes because the freshness hash is over the
  // user's current text, and check must be able to verify that same identity.
  await execa('git', ['add', '--', current.value.path], { cwd: repoRoot });
  const { stdout: stagedEntries } = await execa('git', ['ls-files', '--stage', '-z', '--', current.value.path], { cwd: repoRoot });
  const stagedEntry = stagedEntries.split('\0').find((entry) => entry.endsWith(`\t${current.value!.path}`));
  const stagedOid = stagedEntry?.match(/^[0-7]+ ([0-9a-f]{40}|[0-9a-f]{64}) 0\t/)?.[1];
  if (!stagedOid) return null;
  const stagedText = await gitBlob(repoRoot, stagedOid);
  if (stagedText === null || hashText(stagedText) !== expectedSha256) return null;
  return { gitBlob: stagedOid, text: current.value.text };
}

export async function initialReconciliationRecord(
  repoRoot: string,
  docsDir: string,
  briefMeta: { path: string; sha256: string },
): Promise<BriefReconciliationRecord | null> {
  if (briefMeta.path.startsWith('external:')) return null;
  const safePath = insideRepoPath(repoRoot, briefMeta.path);
  const origin = await readOrigin(repoRoot, docsDir);
  if (!safePath || !origin.value) return null;
  if (!origin.value.briefPath.startsWith('external:')) {
    const originBrief = await readRepoFile(repoRoot, safePath);
    if (!originBrief.value || !originHashMatches(originBrief.value.text, origin.value.sha256)) return null;
    if (origin.value.briefPath !== safePath) return null;
  }
  const current = await trackedCurrentBrief(repoRoot, safePath, briefMeta.sha256);
  if (!current) return null;
  return { schemaVersion: 1, briefPath: safePath, sha256: briefMeta.sha256, gitBlob: current.gitBlob, refusals: [] };
}

export async function writeReconciliationRecord(repoRoot: string, record: BriefReconciliationRecord): Promise<void> {
  if (!insideRepoPath(repoRoot, record.briefPath) || !SHA256_RE.test(record.sha256) || !GIT_OID_RE.test(record.gitBlob)) {
    throw new Error('refusing to write invalid brief reconciliation state');
  }
  const absolute = path.join(repoRoot, STATE_RELATIVE_PATH);
  const dir = path.dirname(absolute);
  await mkdir(dir, { recursive: true });
  const rootReal = await realpath(repoRoot);
  const dirReal = await realpath(dir);
  const relativeDir = path.relative(rootReal, dirReal);
  if (!relativeDir || relativeDir.startsWith('..') || path.isAbsolute(relativeDir)) throw new Error('brief reconciliation state path resolves outside the repository');
  const safeRecord: BriefReconciliationRecord = {
    ...record,
    briefPath: insideRepoPath(repoRoot, record.briefPath)!,
    refusals: record.refusals.map((entry) => ({ ...entry, rationale: redactSecrets(entry.rationale) })),
  };
  const temp = `${absolute}.tmp-${process.pid}-${atomicWriteSequence++}`;
  try {
    await writeFile(temp, `${JSON.stringify(safeRecord, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temp, absolute);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function loadReconciliationRecord(repoRoot: string): Promise<BriefReconciliationRecord | null> {
  const result = await readRecord(repoRoot);
  return result.value;
}

export function briefSha256(text: string): string {
  return hashText(text);
}

export function addDeclinedOutcomes(
  prior: BriefRefusal[],
  briefSha256: string,
  outcomes: { id: string; outcome: 'applied' | 'declined'; change: string; rationale: string }[],
): BriefRefusal[] {
  return [
    ...prior,
    ...outcomes
      .filter((outcome) => outcome.outcome === 'declined')
      .map((outcome) => ({ briefSha256, id: outcome.id, change: redactSecrets(outcome.change), rationale: redactSecrets(outcome.rationale.trim()) })),
  ];
}

export function formatBriefComparison(report: BriefComparison): string {
  if (report.status === 'unknown') {
    return `brief reconciliation: unknown${report.detail ? ` (${report.detail})` : ''}`;
  }
  if (report.status === 'legacy') {
    return `brief reconciliation: legacy${report.detail ? ` (${report.detail})` : ''}`;
  }
  if (!report.items.length) {
    return `brief reconciliation: ${report.status}; no changed blocks`;
  }
  const lines = [
    `brief reconciliation: ${report.items.length} changed block(s) at ${report.path ?? 'unknown path'} (${report.baseline} baseline ${report.baselineSha256?.slice(0, 12) ?? 'unknown'} → current ${report.currentSha256?.slice(0, 12) ?? 'unknown'})`,
  ];
  for (const item of report.items) {
    lines.push(`\n${item.id}:`);
    lines.push('  before:');
    lines.push(...(item.before ? item.before.split('\n').map((line) => `    - ${line}`) : ['    (none)']));
    lines.push('  after:');
    lines.push(...(item.after ? item.after.split('\n').map((line) => `    + ${line}`) : ['    (none)']));
  }
  return lines.join('\n');
}
