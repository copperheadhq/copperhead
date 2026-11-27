/**
 * Engine plugin contracts (RFC 11 §8.1, §9.1, §10.1; implementation spec §6.2).
 * Every placer, router, and checker connects through these; nothing else
 * writes copper or coordinates. JSON Schemas for the job and result shapes are
 * generated from this file into schemas/pcb/ (npm run schemas) so wrappers in
 * other languages validate against the same contract.
 */
import type { BoardSnapshot, ResourceLimits } from '../ir/snapshot.js';

export type { ResourceLimits };
import type { PlacedComponent, TrackSegment, TrackArc, Via, PcbDesign, ZoneFill } from '../ir/types.js';
import type { Polygon } from '../ir/geometry.js';
import type { Diagnostic, CheckResult } from '../verify/diagnostic.js';
import type { FabricationProfile } from '../verify/profiles/index.js';

export type EngineKind = 'placer' | 'router' | 'checker';
export type Determinism = 'deterministic' | 'seeded' | 'nondeterministic';
export type ExecutionMode = 'library' | 'process' | 'container' | 'remote';
export type NetworkRequirement = 'none' | 'optional' | 'required';

export const ENGINE_SCHEMA_VERSION = '1.0' as const;

export interface PlacerCapabilities {
  bottomSide: boolean;
  rotation: boolean;
  arbitraryOutline: boolean;
  /** Relative constraint kinds the engine honours natively (e.g. "near", "grouped", "region"). */
  relativeConstraints: string[];
  fixedComponents: boolean;
  congestionAwareness: boolean;
  layoutReuse: boolean;
}

export interface RouterCapabilities {
  /** Fewest copper layers the engine routes on at all (OrthoRoute routes on inner layers only: 4). */
  minLayers?: number;
  maxLayers?: number;
  differentialPairs: boolean;
  lengthMatching: boolean;
  pushAndShove: boolean;
  partialRouting: boolean;
  preserveExistingRoutes: boolean;
  arbitraryAngles: boolean;
  blindBuriedVias: boolean;
  copperZones: boolean;
}

export interface CheckerCapabilities {
  /** Rule domains the checker speaks for (RFC 11 §10.2). */
  domains: string[];
}

export interface EngineRequirements {
  binaries?: string[];
  env?: string[];
  python?: string;
  java?: string;
}

export interface EngineManifest {
  id: string;
  kind: EngineKind;
  version: string;
  adapterVersion: string;
  /** SPDX identifier. */
  license: string;
  inputSchemaVersions: string[];
  outputSchemaVersions: string[];
  determinism: Determinism;
  executionMode: ExecutionMode;
  networkRequirement: NetworkRequirement;
  /** Reference implementations: ineligible for production jobs (RFC 11 §3.1). */
  harnessOnly: boolean;
  requires: EngineRequirements;
  capabilities: PlacerCapabilities | RouterCapabilities | CheckerCapabilities;
  /** Constraint classes (optionally `class.parameter`) the engine honours. */
  supportedConstraints: string[];
}


export interface WeightedObjective {
  metric: string;
  weight: number;
}

export interface RuntimeMetrics {
  wallSeconds: number;
  engineSeconds?: number;
  peakMemoryMb?: number;
}

export interface EngineProvenance {
  engineId: string;
  engineVersion: string;
  adapterVersion: string;
  /** What actually ran: binary path, arguments, and the environment keys passed through. */
  invocation?: { binary: string; args: string[]; envKeys: string[] };
  seed: number;
  exitCode?: number;
  startedAt: string;
  finishedAt: string;
}

export type EngineStatus = 'complete' | 'partial' | 'failed' | 'unsupported';

export interface PlacementJob {
  runId: string;
  snapshot: BoardSnapshot;
  movableComponentIds: string[];
  constraints: unknown[];
  objectives: WeightedObjective[];
  seed: number;
  limits: ResourceLimits;
}

export interface PlacementResult {
  status: EngineStatus;
  placements: PlacedComponent[];
  unplacedComponentIds: string[];
  diagnostics: Diagnostic[];
  runtime: RuntimeMetrics;
  provenance: EngineProvenance;
}

export interface LayerStrategy {
  /** false = no new tracks on this layer. */
  active?: boolean;
  preferredDirection?: 'horizontal' | 'vertical';
}

export interface RoutingStrategy {
  /** Autorouter passes (Freerouting `-mp`). */
  passes?: number;
  /** Width for every net in the job's scope, overriding the class width (staged power routing). */
  trackWidthNm?: number;
  /** Clearance to route to when larger than the rule: margin the engine would not leave on its own. */
  clearanceNm?: number;
  /** Per copper layer id: layer-preference constraints mapped onto the engine's layer settings. */
  layers?: Record<string, LayerStrategy>;
  /** Engine-specific knobs, validated by the adapter (e.g. kct strategy). */
  [key: string]: string | number | boolean | undefined | Record<string, LayerStrategy>;
}

export interface RoutingJob {
  runId: string;
  snapshot: BoardSnapshot;
  scope: { netIds: string[] | null; region: Polygon | null; preserveExistingRoutes: boolean };
  strategy: RoutingStrategy;
  hardConstraints: unknown[];
  objectives: WeightedObjective[];
  seed: number;
  limits: ResourceLimits;
}

export interface RoutingResult {
  status: EngineStatus;
  segments: TrackSegment[];
  arcs: TrackArc[];
  vias: Via[];
  /** Zone fills the engine produced itself (kicad-tools fills the pour it adds); informational. */
  fills?: ZoneFill[];
  unroutedNetIds: string[];
  diagnostics: Diagnostic[];
  runtime: RuntimeMetrics;
  provenance: EngineProvenance;
}

/** What the runner hands an engine beside the job: an isolated directory and a logger. */
export interface RunContext {
  /** Per-invocation directory the engine may write into; the source project is elsewhere and read-only. */
  workDir: string;
  /** Path of the exported board for this job (a copy; engines that read `.kicad_pcb` use it). */
  boardPath: string;
  /** Path of the project file beside it, when one exists. */
  projectPath?: string;
  log: (line: string) => void;
  progress?: (fraction: number, note?: string) => void;
  /** Aborts long runs; adapters check it between phases and kill their processes on abort. */
  signal?: AbortSignal;
}

export interface PlacerPlugin {
  manifest(): Promise<EngineManifest>;
  place(job: PlacementJob, context: RunContext): Promise<PlacementResult>;
  cancel?(runId: string): Promise<void>;
}

export interface RouterPlugin {
  manifest(): Promise<EngineManifest>;
  estimate?(job: RoutingJob): Promise<{ engineSeconds: number; wallSeconds: number }>;
  route(job: RoutingJob, context: RunContext): Promise<RoutingResult>;
  cancel?(runId: string): Promise<void>;
}

export interface CandidateSnapshot {
  snapshot: BoardSnapshot;
  design: PcbDesign;
  fills: ZoneFill[];
  pcbPath: string;
  profile: FabricationProfile;
}

export interface CheckerPlugin {
  manifest(): Promise<EngineManifest>;
  check(candidate: CandidateSnapshot): Promise<CheckResult>;
}

export type EnginePlugin = PlacerPlugin | RouterPlugin | CheckerPlugin;
