/**
 * Freerouting adapter (issue #252): the first `RoutingEngine`, and the natural
 * default because it is local, offline, licence-compatible, and needs no account.
 * It shells out to `java -jar freerouting.jar -de board.dsn -do board.ses`, then
 * parses the session back through {@link parseSes}.
 *
 * Local-only by construction: this engine runs on the machine, so it may
 * eventually sit inside a `check`/gate path without breaking the network-free
 * contract (AC-2.1). Cloud routers (DeepPCB) stay opt-in and never here.
 *
 * Every failure mode is a distinct, named error rather than a swallowed catch:
 * a board must never be reported as routed when routing did not happen.
 */

import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CopperheadConfig } from '../../config.js';
import { emitDsn, parseSes, SesParseError, type SesParseOptions } from './dsn.js';
import type { BoardModel, DesignRules, RoutedBoard, RoutingEngine } from './types.js';

export const FREEROUTING_JAR_ENV = 'COPPERHEAD_FREEROUTING_JAR';

/** Why a routing run did not produce a routed board. */
export type FreeroutingFailureKind =
  | 'no-jar' // nothing configured, or the configured path does not exist
  | 'no-java' // java not on PATH (or the JRE is unusable)
  | 'process-failed' // java ran but Freerouting exited non-zero
  | 'no-output' // Freerouting exited clean but wrote no session file
  | 'malformed-ses' // the session file existed but did not parse as Specctra SES
  | 'empty-route'; // the session parsed but carried no tracks for a board with nets to route

/** Base class for every routing failure so callers can catch one type. */
export class FreeroutingError extends Error {
  constructor(
    public readonly kind: FreeroutingFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'FreeroutingError';
  }
}

/** No usable local jar configured — distinct so the tool message can say how to fix it. */
export class FreeroutingMissingError extends FreeroutingError {
  constructor(reason: string) {
    super(
      'no-jar',
      `${reason}. Configure the local jar via the ${FREEROUTING_JAR_ENV} environment variable or ` +
        `"routing.freeroutingJar" in .copperhead/config.json (needs a JRE 21+).`,
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

/** Confirm `java` is runnable, so a missing JRE is reported as its own failure. */
async function ensureJava(): Promise<void> {
  const probe = await execa('java', ['-version'], { reject: false });
  if (probe.failed) {
    throw new FreeroutingError(
      'no-java',
      `no usable Java runtime on PATH (java -version exited ${probe.exitCode}). ` +
        `Freerouting needs a JRE 21+; install one and re-run.`,
    );
  }
}

/** Number of pins across nets with at least two pins — the nets a router must touch. */
function routablePinCount(board: BoardModel): number {
  return board.nets.reduce((n, net) => (net.pins.length >= 2 ? n + net.pins.length : n), 0);
}

/** Route a placed board through a local Freerouting jar. */
export class FreeroutingRoutingEngine implements RoutingEngine {
  constructor(private readonly jarPath: string) {}

  async route(board: BoardModel, rules: DesignRules): Promise<RoutedBoard> {
    if (!this.jarPath) throw new FreeroutingMissingError('no Freerouting jar configured');
    if (!existsSync(this.jarPath)) throw new FreeroutingMissingError(`Freerouting jar not found at "${this.jarPath}"`);
    await ensureJava();

    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-route-'));
    const dsnPath = path.join(dir, 'board.dsn');
    const sesPath = path.join(dir, 'board.ses');
    try {
      await writeFile(dsnPath, emitDsn(board, rules), 'utf8');
      const res = await execa('java', ['-jar', this.jarPath, '-de', dsnPath, '-do', sesPath], { reject: false });
      if (res.failed) {
        throw new FreeroutingError(
          'process-failed',
          `freerouting exited ${res.exitCode}: ${(res.stderr || res.stdout || '(no output)').trim().slice(0, 400)}`,
        );
      }
      const ses = await readFile(sesPath, 'utf8').catch(() => null);
      if (ses === null) throw new FreeroutingError('no-output', 'freerouting ran but produced no .ses output');

      const parseOpts: SesParseOptions = { rules };
      let routed: RoutedBoard;
      try {
        routed = parseSes(ses, parseOpts);
      } catch (e) {
        if (e instanceof SesParseError) {
          throw new FreeroutingError('malformed-ses', e.message);
        }
        throw e;
      }

      // A board with routable nets that comes back with zero tracks was not
      // routed — treat it as a failure, not as "successfully routed, no copper".
      if (routed.tracks.length === 0 && routablePinCount(board) > 0) {
        throw new FreeroutingError(
          'empty-route',
          'freerouting produced a session with no routed tracks for a board that has nets to route',
        );
      }
      return routed;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
