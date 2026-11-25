/**
 * The create pipeline's routing step (ADR 0009): after the model has placed
 * the parts, route the board through the wrapped engines, apply the selected
 * candidate, and record the evidence in docs/LAYOUT.md. The model never routes.
 * create-only: this module reaches the engines; `check` reads the evidence
 * through src/pcb/evidence.ts instead.
 */
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { CopperheadConfig } from '../config.js';
import { routeBoard, type RouteRun } from './engines/route.js';
import { boardHash, writeEvidence, evidenceContract, type LayoutEvidence, type ContractVerdict } from './evidence.js';

export interface LayoutStageResult {
  evidence: LayoutEvidence;
  verdict: ContractVerdict;
  /** true when the selected candidate was written over the board file. */
  applied: boolean;
}

/** Route the configured board and write the evidence. Returns the contract verdict for the board as it now stands. */
export async function routeForCreate(repoRoot: string, config: CopperheadConfig, log: (line: string) => void, opts: { runDir?: string } = {}): Promise<LayoutStageResult | null> {
  if (!config.board) return null;
  const boardPath = path.join(repoRoot, config.board);
  if (!existsSync(boardPath)) return null;
  const pcb = config.pcb ?? {};
  const budget = pcb.budgetSeconds ?? 600;
  const runDir = opts.runDir ?? path.join(repoRoot, '.copperhead', 'runs', new Date().toISOString().replace(/[:.]/g, '-'), 'layout');
  await mkdir(runDir, { recursive: true });
  const res = await routeBoard({
    repoRoot, boardPath, runDir, ...(pcb.routers ? { routers: pcb.routers } : {}), mode: pcb.mode ?? 'single', seed: 0, limits: { engineSeconds: budget, wallSeconds: budget },
    ...(pcb.profile ? { profile: pcb.profile } : {}), ...(pcb.scoring ? { scoring: pcb.scoring } : {}), ...(pcb.maxParallelEngines ? { maxParallel: pcb.maxParallelEngines } : {}),
    policy: { network: pcb.allowRemoteEngines ? 'required' : 'optional', allowHarnessEngines: pcb.allowHarnessEngines ?? false, denyLicenses: [] },
    log,
  });
  const selected = res.ranking.selected ? res.candidates.find((c) => c.engineId === res.ranking.selected) : undefined;
  let applied = false;
  if (selected && (res.outcome.status === 'PASS' || res.outcome.status === 'PARTIAL')) {
    await copyFile(selected.pcbPath, boardPath);
    applied = true;
  }
  const evidence = await evidenceFromRun(repoRoot, boardPath, res);
  const verdict = await recordEvidence(repoRoot, config.docs, boardPath, evidence);
  return { evidence, verdict, applied };
}

/** Build the evidence record for a finished routing run, hashing the board as it stands now (after any apply). */
export async function evidenceFromRun(repoRoot: string, boardPath: string, res: RouteRun): Promise<LayoutEvidence> {
  const selected = res.ranking.selected ? res.candidates.find((c) => c.engineId === res.ranking.selected) : undefined;
  const boardText = await readFile(boardPath, 'utf8');
  const proPath = boardPath.replace(/\.kicad_pcb$/, '.kicad_pro');
  const projectText = existsSync(proPath) ? await readFile(proPath, 'utf8') : undefined;
  const snapshot = JSON.parse(await readFile(path.join(res.runDir, 'snapshot.json'), 'utf8')) as { hash: string };
  const owed = selected ? selected.verify.diagnostics.filter((d) => d.code === 'conn.unrouted').flatMap((d) => d.entityReferences.slice(0, 1)) : [];
  return {
    version: 1,
    writtenAt: new Date().toISOString(),
    boardHash: boardHash(boardText, boardPath, projectText),
    snapshotHash: snapshot.hash,
    runDir: path.relative(repoRoot, res.runDir),
    status: res.outcome.status,
    summary: res.outcome.summary,
    selected: res.ranking.selected ?? null,
    engines: res.invocations.map((i) => ({ id: i.engineId, version: i.provenance.engineVersion })),
    // verify metrics (completion, shorts, DRC) plus the routing metrics the run wrote beside the candidate (wirelength, vias, bends, PCBWorld set)
    metrics: selected ? { ...Object.fromEntries(Object.entries(selected.verify.metrics).filter((kv): kv is [string, number] => typeof kv[1] === 'number')), ...(await candidateMetrics(selected.pcbPath)) } : {},
    owed: [...new Set(owed)],
    diagnostics: (selected ? selected.verify.diagnostics : res.outcome.diagnostics).filter((d) => d.severity === 'error').map((d) => ({ code: d.code, severity: d.severity, entityReferences: d.entityReferences, message: d.message })),
  };
}

/** Write the evidence section into docs/LAYOUT.md (creating the doc if needed) and return the contract verdict. */
export async function recordEvidence(repoRoot: string, docsDir: string, boardPath: string, evidence: LayoutEvidence): Promise<ContractVerdict> {
  const layoutDoc = path.join(repoRoot, docsDir, 'LAYOUT.md');
  await mkdir(path.dirname(layoutDoc), { recursive: true });
  const current = existsSync(layoutDoc) ? await readFile(layoutDoc, 'utf8') : '# Layout\n';
  await writeFile(layoutDoc, writeEvidence(current, evidence), 'utf8');
  const proPath = boardPath.replace(/\.kicad_pcb$/, '.kicad_pro');
  return evidenceContract(await readFile(layoutDoc, 'utf8'), await readFile(boardPath, 'utf8'), boardPath, existsSync(proPath) ? await readFile(proPath, 'utf8') : undefined);
}

/** The contract as it stands on disk, without routing. */
export async function layoutContract(repoRoot: string, config: CopperheadConfig): Promise<ContractVerdict | null> {
  if (!config.board) return null;
  const boardPath = path.join(repoRoot, config.board);
  if (!existsSync(boardPath)) return null;
  const layoutDoc = path.join(repoRoot, config.docs, 'LAYOUT.md');
  const proPath = boardPath.replace(/\.kicad_pcb$/, '.kicad_pro');
  return evidenceContract(existsSync(layoutDoc) ? await readFile(layoutDoc, 'utf8') : null, await readFile(boardPath, 'utf8'), boardPath, existsSync(proPath) ? await readFile(proPath, 'utf8') : undefined);
}

async function candidateMetrics(pcbPath: string): Promise<Record<string, number>> {
  const p = path.join(path.dirname(pcbPath), 'metrics.json');
  if (!existsSync(p)) return {};
  try {
    const m = JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(m).filter((kv): kv is [string, number] => typeof kv[1] === 'number'));
  } catch {
    return {};
  }
}
