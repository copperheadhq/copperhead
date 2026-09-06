import type { ToolSchema } from '../agent/types.js';
import type { RunContext } from '../agent/context.js';
import type { ToolResult, ViewHint } from '../agent/envelope.js';

export interface CatalogTool {
  kind: 'tool';
  name: string;
  version: number;
  viewHint: ViewHint;
  schema: ToolSchema;
  gate: (ctx: RunContext) => boolean;
  /** Own gate as declared, before the registry applies the tools-conjunction. */
  ownGate: (ctx: RunContext) => boolean;
  handler: (ctx: RunContext, args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface CatalogSkill {
  kind: 'skill';
  name: string;
  version: number;
  viewHint: ViewHint;
  schema: ToolSchema;
  gate: (ctx: RunContext) => boolean;
  ownGate: (ctx: RunContext) => boolean;
  /** False when `gate` was omitted and should default to the tools-conjunction. */
  gateProvided: boolean;
  tools: string[];
  prompt: (ctx: RunContext, args: Record<string, unknown>) => string;
  isComplete: (ctx: RunContext, args: Record<string, unknown>) => Promise<boolean> | boolean;
  maxTurns?: number;
}

export type CatalogEntry = CatalogTool | CatalogSkill;

export interface ToolInit {
  schema: ToolSchema;
  version: number;
  viewHint: ViewHint;
  gate: (ctx: RunContext) => boolean;
  handler: (ctx: RunContext, args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface SkillInit {
  schema: ToolSchema;
  version: number;
  viewHint: ViewHint;
  tools: string[];
  prompt: (ctx: RunContext, args: Record<string, unknown>) => string;
  isComplete: (ctx: RunContext, args: Record<string, unknown>) => Promise<boolean> | boolean;
  maxTurns?: number;
  gate?: (ctx: RunContext) => boolean;
}

/** Identity helper: freeze defaults and tag the tier. */
export function defineTool(def: ToolInit): CatalogTool {
  return {
    kind: 'tool',
    name: def.schema.name,
    version: def.version,
    viewHint: def.viewHint,
    schema: def.schema,
    gate: def.gate,
    ownGate: def.gate,
    handler: def.handler,
  };
}

/**
 * Identity helper. When `gate` is omitted the skill is available only if every
 * declared tool's gate is true (applied by the registry at list-time).
 */
export function defineSkill(def: SkillInit): CatalogSkill {
  const ownGate = def.gate ?? ((_ctx: RunContext) => true);
  return {
    kind: 'skill',
    name: def.schema.name,
    version: def.version,
    viewHint: def.viewHint,
    schema: def.schema,
    gate: ownGate,
    ownGate,
    gateProvided: def.gate !== undefined,
    tools: def.tools,
    prompt: def.prompt,
    isComplete: def.isComplete,
    ...(def.maxTurns !== undefined ? { maxTurns: def.maxTurns } : {}),
  };
}
