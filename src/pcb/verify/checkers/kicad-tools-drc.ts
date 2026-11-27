/**
 * kicad-tools `kct check` as a supplementary, process-mode checker (ADR 0002).
 * Advisory beside KiCad DRC: its findings map to `drc.kct.<rule>` at the
 * severity it reports, except `connectivity`, which becomes a quality warning
 * because it disagrees with KiCad on zone-connected nets. Absent `kct` is
 * NOT_APPLICABLE, never a failure.
 */
import { execa } from 'execa';
import { rect } from '../../ir/geometry.js';
import { mmToNm } from '../../ir/units.js';
import type { FabricationProfile } from '../profiles/index.js';
import { make, statusOf, type CheckResult, type Diagnostic } from '../diagnostic.js';

export const KCT_CHECKER = { id: 'kicad-tools-check', version: '0.20.0' };

interface KctViolation {
  rule_id?: string;
  type?: string;
  severity?: string;
  message?: string;
  location?: [number, number] | null;
  items?: string[];
  nets?: string[];
}

export async function checkWithKicadTools(pcbPath: string, profile: FabricationProfile, opts: { kct?: string; timeoutMs?: number } = {}): Promise<CheckResult> {
  const bin = opts.kct ?? process.env.COPPERHEAD_KCT ?? 'kct';
  const res = await execa(bin, ['check', pcbPath, '--format', 'json', '--mfr', profile.kicadToolsMfr], { reject: false, timeout: opts.timeoutMs ?? 120_000 });
  if (res.failed && /ENOENT/.test(String((res as { code?: string }).code ?? res.shortMessage ?? ''))) {
    return { checker: KCT_CHECKER, status: 'NOT_APPLICABLE', diagnostics: [], metrics: {}, evidence: [{ kind: 'note', note: `kct not found (${bin}); pip install kicad-tools==0.20.0 to enable the supplementary checker` }] };
  }
  let parsed: { violations?: KctViolation[]; summary?: Record<string, number> };
  try {
    parsed = JSON.parse(res.stdout) as typeof parsed;
  } catch {
    return { checker: KCT_CHECKER, status: 'UNKNOWN', diagnostics: [], metrics: {}, evidence: [{ kind: 'note', note: `kct check produced no JSON: ${(res.stderr || res.stdout).slice(0, 200)}` }] };
  }
  const d: Diagnostic[] = [];
  for (const v of parsed.violations ?? []) {
    const rule = v.rule_id ?? v.type ?? 'unknown';
    const sev = v.severity === 'error' ? 'error' : v.severity === 'warning' ? 'warning' : 'info';
    const code = rule === 'connectivity' ? 'quality.kct.connectivity' : `drc.kct.${rule}`;
    const region = v.location ? rect(mmToNm(v.location[0]), mmToNm(v.location[1]), mmToNm(0.1), mmToNm(0.1)) : undefined;
    d.push(make(KCT_CHECKER, code, { severity: rule === 'connectivity' ? 'warning' : sev, entityIds: [], entityReferences: [...(v.items ?? []), ...(v.nets ?? [])], ...(region ? { region } : {}), message: v.message ?? rule, suggestedActions: [] }));
  }
  return { checker: KCT_CHECKER, status: statusOf(d), diagnostics: d, metrics: { kct_errors: parsed.summary?.errors ?? 0, kct_warnings: parsed.summary?.warnings ?? 0 }, evidence: [{ kind: 'kct-check', note: `mfr ${profile.kicadToolsMfr}` }] };
}
