import { catalog } from '../capabilities/index.js';
import type { CatalogEntry, CatalogSkill } from '../capabilities/define.js';
import type { RunContext } from './context.js';
import { PROTOCOL_VERSION } from './envelope.js';

export { PROTOCOL_VERSION };

export class ToolRegistry {
  private readonly byName = new Map<string, CatalogEntry>();

  constructor(entries: CatalogEntry[]) {
    for (const e of entries) {
      if (this.byName.has(e.name)) throw new Error(`duplicate catalog name "${e.name}"`);
      this.byName.set(e.name, e);
    }
    for (const e of entries) {
      if (e.kind === 'skill' && !e.gateProvided) {
        const conj = (ctx: RunContext) => this.conjunction(e.tools, ctx);
        e.gate = conj;
        e.ownGate = conj;
      }
    }
  }

  get protocolVersion(): number {
    return PROTOCOL_VERSION;
  }

  get(name: string): CatalogEntry | undefined {
    return this.byName.get(name);
  }

  all(): CatalogEntry[] {
    return [...this.byName.values()];
  }

  skills(): CatalogSkill[] {
    return this.all().filter((e): e is CatalogSkill => e.kind === 'skill');
  }

  /** True when every named tool exists and its gate is open. */
  conjunction(toolNames: string[], ctx: RunContext): boolean {
    return toolNames.every((n) => {
      const t = this.byName.get(n);
      return t?.kind === 'tool' && t.gate(ctx);
    });
  }

  /** Entries whose gate is open. Skills also require every declared tool's gate (D3). */
  list(ctx: RunContext): CatalogEntry[] {
    return this.all().filter((e) => {
      if (e.kind === 'skill' && (e.tools.includes('finish') || !this.conjunction(e.tools, ctx))) return false;
      return e.gate(ctx);
    });
  }
}

export const registry = new ToolRegistry(catalog);
