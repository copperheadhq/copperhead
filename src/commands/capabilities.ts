import { createRequire } from 'node:module';
import type { Command } from 'commander';
import {
  kicadCliVersion,
  execBoundedProcess,
  type BoundedProcessResult,
} from '../kicad/cli.js';

/**
 * Protocol identifier for the Copperhead CLI-to-consumer boundary (Issue #258).
 * Breaking wire or semantic changes increment the protocol major.
 * Additive enhancements retain the major version.
 */
export const COPPERHEAD_RUN_PROTOCOL = 'copperhead-run/1';

/**
 * The protocol major version supported by this build of Copperhead.
 */
export const SUPPORTED_PROTOCOL_MAJOR = 1;

/**
 * Protocol features implemented and supported on the wire in this build.
 * A capability is only listed here once its CLI flags, wire transports, and
 * handling are fully implemented and verified in this codebase.
 * In Phase 0 (capability handshake), no Phase 1-4 stream features are active.
 */
export const IMPLEMENTED_PROTOCOL_FEATURES: readonly string[] = [];

/**
 * Default deadline for external tool subprocess version probes (milliseconds).
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 5000;

export interface ToolVersions {
  kicadCli: string | null;
  git: string | null;
  openspec: string | null;
  node: string;
}

export interface CapabilityReport {
  protocol: string;
  cli: string;
  commands: string[];
  features: string[];
  tools: ToolVersions;
}

export interface CapabilityDeps {
  nodeVersion?: string;
  cliVersion?: string;
  kicadVersion?: () => Promise<string | null>;
  gitVersion?: () => Promise<string | null>;
  openspecVersion?: () => Promise<string | null>;
  timeoutMs?: number;
}

function ownVersion(): string {
  const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };
  return version;
}

async function probeSafe<T>(fn: () => Promise<T> | T): Promise<T | null> {
  try {
    const res = await fn();
    return res ?? null;
  } catch {
    return null;
  }
}

/**
 * Parse and validate KiCad CLI version output.
 * Returns the normalized semantic version string, or null if the output is missing,
 * malformed, contains only warnings, or contains unparseable text.
 * Strictly anchored to prevent host filepaths or diagnostic output from leaking.
 */
export function parseKicadVersion(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(
      /^(?:kicad-cli\s+)?v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?(?:-[0-9A-Za-z](?:[0-9A-Za-z._-]*[0-9A-Za-z])?)?(?:\+[0-9A-Za-z](?:[0-9A-Za-z._-]*[0-9A-Za-z])?)?)$/i,
    );
    if (match) {
      return match[1]!;
    }
  }
  return null;
}

/**
 * Parse and validate Git version output.
 * Supports standard semantic versions as well as platform builds like `2.52.0.windows.1`.
 * Returns null for unparseable output, warnings, or missing version.
 */
export function parseGitVersion(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(
      /^git version\s+((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?(?:[.-][0-9A-Za-z]+)*)(?:\s+\([^)]*\))?$/i,
    );
    if (match) {
      return match[1]!;
    }
  }
  return null;
}

/**
 * Parse and validate OpenSpec CLI version output.
 * Returns the normalized version string or null for invalid/warning-only output.
 */
export function parseOpenspecVersion(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(
      /^(?:openspec\s+)?v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?(?:-[0-9A-Za-z](?:[0-9A-Za-z._-]*[0-9A-Za-z])?)?(?:\+[0-9A-Za-z](?:[0-9A-Za-z._-]*[0-9A-Za-z])?)?)$/i,
    );
    if (match) {
      return match[1]!;
    }
  }
  return null;
}

function parseSuccessfulProbe(
  res: BoundedProcessResult,
  parse: (raw: string) => string | null,
): string | null {
  if (res.failed || res.timedOut) return null;
  return parse(String(res.stdout ?? ''));
}

export function defaultDeps(timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): CapabilityDeps {
  return {
    nodeVersion: process.version,
    cliVersion: ownVersion(),
    timeoutMs,
    kicadVersion: async () => {
      const raw = await kicadCliVersion({ timeout: timeoutMs });
      return parseKicadVersion(raw);
    },
    gitVersion: async () => {
      const res = await execBoundedProcess('git', ['--version'], timeoutMs);
      return parseSuccessfulProbe(res, parseGitVersion);
    },
    openspecVersion: async () => {
      const res = await execBoundedProcess('openspec', ['--version'], timeoutMs);
      return parseSuccessfulProbe(res, parseOpenspecVersion);
    },
  };
}

export interface CollectCapabilitiesOptions {
  deps?: CapabilityDeps;
  program?: Command;
  commands?: string[];
  timeoutMs?: number;
}

/**
 * Extract public top-level commands from a Commander instance or explicit command array.
 * Phase 0 contract: advertises top-level primary command names only, sorted lexicographically.
 * Aliases (e.g. `verify` for `check`) and subcommands (e.g. `skill list`, `export bom`)
 * are excluded from the root command inventory and handled by their primary entry points.
 */
export function extractPublicCommands(program?: Command, explicitCommands?: string[]): string[] {
  if (explicitCommands) {
    return [...new Set(explicitCommands)].sort();
  }
  if (program && Array.isArray(program.commands) && program.commands.length > 0) {
    const names = program.commands
      .map((cmd) => cmd.name())
      .filter((name) => name !== 'help' && !name.startsWith('_'));
    return [...new Set(names)].sort();
  }
  return [];
}

/**
 * Collect Copperhead's versioned protocol and runtime capability descriptor.
 * Completely offline, network-free, credential-free, and repository-independent.
 */
export async function collectCapabilities(
  opts: CollectCapabilitiesOptions = {},
): Promise<CapabilityReport> {
  const timeout = opts.timeoutMs ?? opts.deps?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const defaults = defaultDeps(timeout);
  const nodeVersion = opts.deps?.nodeVersion ?? defaults.nodeVersion!;
  const cliVersion = opts.deps?.cliVersion ?? defaults.cliVersion!;
  const kicadProbe = opts.deps?.kicadVersion ?? defaults.kicadVersion!;
  const gitProbe = opts.deps?.gitVersion ?? defaults.gitVersion!;
  const openspecProbe = opts.deps?.openspecVersion ?? defaults.openspecVersion!;

  const [kicadCli, git, openspec] = await Promise.all([
    probeSafe(kicadProbe),
    probeSafe(gitProbe),
    probeSafe(openspecProbe),
  ]);

  const commands = extractPublicCommands(opts.program, opts.commands);

  return {
    protocol: COPPERHEAD_RUN_PROTOCOL,
    cli: cliVersion,
    commands,
    features: [...IMPLEMENTED_PROTOCOL_FEATURES],
    tools: {
      kicadCli,
      git,
      openspec,
      node: nodeVersion,
    },
  };
}

/**
 * Verify if a given protocol string is compatible with the expected protocol major.
 * Internal validation utility; consumers validate the reported protocol identifier directly.
 * Strict grammar: rejects leading zeros (e.g. `copperhead-run/01`), non-numeric minor suffixes
 * (e.g. `copperhead-run/1.anything`), non-matching majors, or foreign protocol prefixes.
 */
export function isProtocolCompatible(
  protocol: string,
  expectedMajor = SUPPORTED_PROTOCOL_MAJOR,
): boolean {
  if (!protocol || typeof protocol !== 'string') return false;
  const match = protocol.match(/^copperhead-run\/([1-9]\d*)(?:\.(0|[1-9]\d*))?$/);
  if (!match) return false;
  const major = Number(match[1]);
  return Number.isFinite(major) && major === expectedMajor;
}

/**
 * Assert that a capability document or protocol identifier is compatible.
 * Throws an actionable error if the protocol major differs or report is malformed.
 */
export function assertProtocolCompatible(
  report: unknown,
  expectedMajor = SUPPORTED_PROTOCOL_MAJOR,
): void {
  const protocol =
    report && typeof report === 'object' && 'protocol' in report && typeof report.protocol === 'string'
      ? report.protocol
      : undefined;
  if (!protocol || !isProtocolCompatible(protocol, expectedMajor)) {
    const received = protocol ?? String(report);
    throw new Error(
      `Unsupported protocol version "${received}". Expected copperhead-run/${expectedMajor}.`,
    );
  }
}

/**
 * Format capability report for human terminal inspection.
 */
export function formatCapabilities(report: CapabilityReport): string {
  const lines = [
    `Protocol:    ${report.protocol}`,
    `CLI Version: ${report.cli}`,
    `Commands:    ${report.commands.join(', ')}`,
    `Features:    ${report.features.length > 0 ? report.features.join(', ') : 'none'}`,
    `Tools:`,
    `  node:      ${report.tools.node}`,
    `  kicad-cli: ${report.tools.kicadCli ?? 'none (not found / not installed)'}`,
    `  git:       ${report.tools.git ?? 'none (not found / not installed)'}`,
    `  openspec:  ${report.tools.openspec ?? 'none (not found / not installed)'}`,
  ];
  return lines.join('\n');
}
