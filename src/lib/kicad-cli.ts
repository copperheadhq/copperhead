import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from './logger';

const log = getLogger('kicad-cli');

export interface KicadCliConfig {
  kicadCliPath: string; // Path to kicad-cli executable, defaults to 'kicad-cli'
}

let config: KicadCliConfig = {
  kicadCliPath: 'kicad-cli', // Default to assuming it's in PATH
};

export function setKicadCliConfig(newConfig: Partial<KicadCliConfig>) {
  config = { ...config, ...newConfig };
  log.debug(`KiCad CLI config updated: ${JSON.stringify(config)}`);
}

export function getKicadCliPath(): string {
  return config.kicadCliPath;
}

export function runKicadCli(
  args: string[],
  cwd: string,
  options?: {
    input?: string;
    timeout?: number;
    ignoreErrors?: boolean;
    env?: Record<string, string>;
  },
): { stdout: string; stderr: string; exitCode: number } {
  const { input, timeout, ignoreErrors = false, env = {} } = options || {};
  const fullEnv = { ...process.env, ...env };

  log.debug(`Running KiCad CLI: ${config.kicadCliPath} ${args.join(' ')} in ${cwd}`);

  const result = spawnSync(config.kicadCliPath, args, {
    cwd,
    input,
    timeout,
    encoding: 'utf8',
    env: fullEnv,
    stdio: ['pipe', 'pipe', 'pipe'], // stdin, stdout, stderr
  });

  if (result.error) {
    log.error(`Failed to spawn KiCad CLI: ${result.error.message}`);
    throw new Error(`Failed to run KiCad CLI: ${result.error.message}`);
  }

  const stdout = result.stdout?.toString().trim() || '';
  const stderr = result.stderr?.toString().trim() || '';

  if (result.status !== 0 && !ignoreErrors) {
    log.error(`KiCad CLI command failed with exit code ${result.status}`);
    log.error(`STDOUT:\n${stdout}`);
    log.error(`STDERR:\n${stderr}`);
    throw new Error(`KiCad CLI command failed: ${config.kicadCliPath} ${args.join(' ')}\n${stderr}`);
  }

  if (result.signal) {
    log.warn(`KiCad CLI command terminated by signal: ${result.signal}`);
  }

  return { stdout, stderr, exitCode: result.status || 0 };
}

/**
 * Checks if kicad-cli is available and executable.
 * @returns true if kicad-cli is found and executable, false otherwise.
 */
export function checkKicadCliAvailability(): boolean {
  try {
    const result = runKicadCli(['--version'], process.cwd(), { timeout: 5000, ignoreErrors: true });
    if (result.exitCode === 0 && result.stdout.includes('KiCad')) {
      log.info(`kicad-cli found: ${result.stdout.split('\n')[0]}`);
      return true;
    }
    log.warn(`kicad-cli --version failed or did not return expected output. Exit code: ${result.exitCode}, Stdout: ${result.stdout}`);
    return false;
  } catch (error) {
    log.warn(`Error checking kicad-cli availability: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
