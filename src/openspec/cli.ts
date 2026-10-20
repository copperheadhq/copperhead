import { execa } from 'execa';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { isNotFoundError } from '../util/preflight.js';

/**
 * OpenSpec is driven as a subprocess, same pattern as kicad-cli (SPEC §2.6).
 * Never user-triggered; copperhead owns the propose → validate → archive flow.
 */

export interface OpenSpecResult {
  ok: boolean;
  output: string;
}


async function openspec(repo: string, args: string[]): Promise<OpenSpecResult> {
  try {
    const { stdout, stderr } = await execa('openspec', args, { cwd: repo });
    return { ok: true, output: [stdout, stderr].filter(Boolean).join('\n') };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: string; message: string; exitCode?: number };
    if (isNotFoundError(e)) {
      return { ok: false, output: 'openspec CLI not found on PATH (npm i -g @fission-ai/openspec)' };
    }
    return { ok: false, output: [e.stdout, e.stderr].filter(Boolean).join('\n') || e.message };
  }
}

export function hasOpenSpec(repo: string): boolean {
  return existsSync(path.join(repo, 'openspec'));
}

export async function openspecInit(repo: string): Promise<OpenSpecResult> {
  if (hasOpenSpec(repo)) return { ok: true, output: 'openspec/ already present' };
  return openspec(repo, ['init', '--no-interactive']);
}

export function openspecValidate(repo: string, changeId?: string): Promise<OpenSpecResult> {
  return openspec(repo, changeId ? ['validate', changeId] : ['validate']);
}

export function openspecArchive(repo: string, changeId: string): Promise<OpenSpecResult> {
  return openspec(repo, ['archive', changeId, '--yes']);
}
