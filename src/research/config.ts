import type { CopperheadConfig, ResearchConfig } from '../config.js';

export const DEFAULT_RESEARCH_HOSTS = [
  'jlcsearch.tscircuit.com',
  'identity.nexar.com',
  'api.nexar.com',
  'api.search.brave.com',
  'wmsc.lcsc.com',
  '*.mouser.com',
  '*.digikey.com',
  '*.espressif.com',
];

export interface EffectiveResearchConfig {
  enabled: boolean;
  provider: 'jlcsearch' | 'nexar';
  searchProvider: 'none' | 'brave';
  allowHosts: string[];
  stalenessDays: number;
  maxPdfMB: number;
}

export function researchConfig(config: CopperheadConfig): EffectiveResearchConfig {
  const raw: ResearchConfig = config.research ?? {};
  return {
    enabled: raw.enabled === true,
    provider: raw.provider ?? 'jlcsearch',
    searchProvider: raw.searchProvider ?? 'none',
    allowHosts: raw.allowHosts?.length ? raw.allowHosts : DEFAULT_RESEARCH_HOSTS,
    stalenessDays: raw.stalenessDays ?? 30,
    maxPdfMB: raw.maxPdfMB ?? 10,
  };
}

function has(key: string, env: NodeJS.ProcessEnv): boolean {
  return typeof env[key] === 'string' && env[key]!.trim().length > 0;
}

export function researchPartToolGate(config: CopperheadConfig, env = process.env): boolean {
  const r = researchConfig(config);
  if (!r.enabled) return false;
  return r.provider === 'jlcsearch' || (has('NEXAR_CLIENT_ID', env) && has('NEXAR_CLIENT_SECRET', env));
}

export function researchSearchToolGate(config: CopperheadConfig, env = process.env): boolean {
  const r = researchConfig(config);
  return r.enabled && r.searchProvider === 'brave' && has('BRAVE_API_KEY', env);
}

export function researchDatasheetToolGate(config: CopperheadConfig): boolean {
  return researchConfig(config).enabled;
}

/** Backwards-compatible alias for callers that gate the part-research family. */
export function researchToolGate(config: CopperheadConfig, env = process.env): boolean {
  return researchPartToolGate(config, env);
}

export function researchEnabled(config: CopperheadConfig, env = process.env): boolean {
  void env;
  return researchConfig(config).enabled;
}

export function hostAllowed(hostname: string, allowHosts: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return allowHosts.some((pattern) => {
    const p = pattern.toLowerCase().trim().replace(/\.$/, '');
    if (p.startsWith('*.')) return host === p.slice(2) || host.endsWith(`.${p.slice(2)}`);
    return host === p;
  });
}
