/**
 * Freerouting adapter (issue #252): the first `RoutingEngine`, and the natural
 * default because it is local, offline, licence-compatible, and needs no account.
 * It shells out to `java -jar freerouting.jar -de board.dsn -do board.ses`, then
 * parses the session back through {@link parseSes}.
 *
 * Local-only by construction: this engine runs on the machine, so it may
 * eventually sit inside a `check`/gate path without breaking the network-free
 * contract (AC-2.1). Cloud routers (DeepPCB) stay opt-in and never here.
 */

import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CopperheadConfig } from '../../config.js';
import { emitDsn, parseSes } from './dsn.js';
import type { BoardModel, DesignRules, RoutedBoard, RoutingEngine } from './types.js';

export const FREEROUTING_JAR_ENV = 'COPPERHEAD_FREEROUTING_JAR';

export class FreeroutingMissingError extends Error {
  constructor(reason: string) {
    super(
      `${reason}. Configure the local jar via the ${FREEROUTING_JAR_ENV} environment variable or ` +
        `"routing.freeroutingJar" in .copperhead/config.json (needs a JRE).`,
    );
    this.name = 'FreeroutingMissingError';
  }
}

/**
 * Resolve the Freerouting jar: `COPPERHEAD_FREEROUTING_JAR` wins over
 * `config.routing.freeroutingJar`. Set-but-missing is a hard error (the operator
 * named a jar; silently running none would be the worst answer).
 */
export function resolveFreeroutingJar(config?: Pick<CopperheadConfig, 'routing'>, env = process.env): string {
  const jar = (env[FREEROUTING_JAR_ENV]?.trim() || config?.routing?.freeroutingJar?.trim() || '').trim();
  if (!jar) throw new FreeroutingMissingError('no Freerouting jar configured');
  if (!existsSync(jar)) throw new FreeroutingMissingError(`Freerouting jar not found at "${jar}"`);
  return jar;
}

/** Route a placed board through a local Freerouting jar. */
export class FreeroutingRoutingEngine implements RoutingEngine {
  constructor(private readonly jarPath: string) {}

  async route(board: BoardModel, rules: DesignRules): Promise<RoutedBoard> {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-route-'));
    const dsnPath = path.join(dir, 'board.dsn');
    const sesPath = path.join(dir, 'board.ses');
    try {
      await writeFile(dsnPath, emitDsn(board, rules), 'utf8');
      const res = await execa('java', ['-jar', this.jarPath, '-de', dsnPath, '-do', sesPath], { reject: false });
      if (res.failed) {
        throw new Error(`freerouting failed (exit ${res.exitCode}): ${res.stderr || res.stdout || '(no output)'}`);
      }
      const ses = await readFile(sesPath, 'utf8').catch(() => null);
      if (ses === null) throw new Error('freerouting produced no .ses output');
      return parseSes(ses);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
