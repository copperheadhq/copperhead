import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IntentPart, IntentNet } from './ir.js';

/**
 * Options for expanding a static circuit pattern reference into discrete Intent parts and nets.
 */
export interface ExpandPatternOptions {
  /**
   * Prefix prepended to all reference designators in the pattern (e.g. "PWR_" or "REG1_").
   * Example: with refPrefix "PWR_", part "U1" becomes "PWR_U1" and "C1" becomes "PWR_C1".
   */
  refPrefix?: string;

  /**
   * Suffix or instance identifier appended to all reference designators when refPrefix is omitted.
   * Example: with instanceId "1", part "U1" becomes "U1_1".
   */
  instanceId?: string;

  /**
   * Subsystem group override applied to all parts in the expanded pattern block.
   * If omitted, each part retains its default group defined in the pattern file.
   */
  group?: string;

  /**
   * Directory containing pattern JSON files. Defaults to `src/kicad/patterns/`.
   */
  patternsDir?: string;
}

export interface ExpandedPatternResult {
  parts: IntentPart[];
  nets: IntentNet[];
}

interface RawPatternPart {
  ref: string;
  libId: string;
  value: string;
  footprint?: string;
  group: string;
}

interface RawPatternNet {
  name: string;
  pins: string[];
  kind?: 'power' | 'ground' | 'signal';
}

interface RawPatternDoc {
  name: string;
  description: string;
  parts: RawPatternPart[];
  nets: RawPatternNet[];
}

/**
 * Default patterns directory resolved relative to this module:
 * src/kicad/draft/ -> src/kicad/patterns/
 */
function getDefaultPatternsDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, '..', 'patterns');
}

/**
 * Expand a named static circuit pattern into renumbered IntentPart and IntentNet arrays.
 *
 * Loads `src/kicad/patterns/<patternName>.json`, renames component reference designators
 * according to the provided prefix / instanceId, updates net endpoint pin references to match,
 * and returns the expanded { parts, nets } block.
 *
 * This is a pure, side-effect-free helper. It does not modify `SchematicIntent` schema
 * or read/write schematic files directly.
 *
 * @throws {Error} if the pattern name is invalid, file is missing, or pattern structure is invalid.
 */
export function expandPatternRef(
  patternName: string,
  options: ExpandPatternOptions = {},
): ExpandedPatternResult {
  if (typeof patternName !== 'string' || !patternName.trim()) {
    throw new Error('expandPatternRef: patternName must be a non-empty string');
  }

  // Ensure pattern name doesn't contain directory traversal characters
  const sanitizedName = path.basename(patternName.trim().replace(/\.json$/i, ''));
  const patternsDir = options.patternsDir ?? getDefaultPatternsDir();
  const patternFile = path.join(patternsDir, `${sanitizedName}.json`);

  if (!existsSync(patternFile)) {
    throw new Error(`expandPatternRef: pattern "${patternName}" not found at ${patternFile}`);
  }

  let rawContent: string;
  try {
    rawContent = readFileSync(patternFile, 'utf8');
  } catch (err) {
    throw new Error(`expandPatternRef: failed to read pattern file "${patternFile}": ${(err as Error).message}`);
  }

  let doc: RawPatternDoc;
  try {
    doc = JSON.parse(rawContent);
  } catch (err) {
    throw new Error(`expandPatternRef: failed to parse JSON in "${patternFile}": ${(err as Error).message}`);
  }

  if (typeof doc !== 'object' || doc === null || !Array.isArray(doc.parts) || !Array.isArray(doc.nets)) {
    throw new Error(`expandPatternRef: invalid pattern document in "${patternFile}": must have "parts" and "nets" arrays`);
  }

  // Build reference renumbering map
  const refMap = new Map<string, string>();
  const renumberedParts: IntentPart[] = [];

  for (const part of doc.parts) {
    if (typeof part.ref !== 'string' || !part.ref || typeof part.libId !== 'string' || typeof part.value !== 'string') {
      throw new Error(`expandPatternRef: pattern "${patternName}" contains invalid part entry: ${JSON.stringify(part)}`);
    }

    let newRef = part.ref;
    if (options.refPrefix !== undefined) {
      newRef = `${options.refPrefix}${part.ref}`;
    } else if (options.instanceId !== undefined) {
      newRef = `${part.ref}_${options.instanceId}`;
    }

    if (refMap.has(part.ref)) {
      throw new Error(`expandPatternRef: duplicate part ref "${part.ref}" in pattern "${patternName}"`);
    }
    refMap.set(part.ref, newRef);

    const renumberedPart: IntentPart = {
      ref: newRef,
      libId: part.libId,
      value: part.value,
      group: options.group ?? part.group,
    };

    if (part.footprint !== undefined && typeof part.footprint === 'string') {
      renumberedPart.footprint = part.footprint;
    }

    renumberedParts.push(renumberedPart);
  }

  // Rewrite net endpoint pin connections
  const rewrittenNets: IntentNet[] = [];

  for (const net of doc.nets) {
    if (typeof net.name !== 'string' || !net.name || !Array.isArray(net.pins)) {
      throw new Error(`expandPatternRef: pattern "${patternName}" contains invalid net entry: ${JSON.stringify(net)}`);
    }

    const rewrittenPins: string[] = [];
    for (const ep of net.pins) {
      if (typeof ep !== 'string') {
        throw new Error(`expandPatternRef: pattern "${patternName}" net "${net.name}" has non-string pin endpoint`);
      }
      const match = /^([^.]+)\.(.+)$/.exec(ep);
      if (!match) {
        throw new Error(`expandPatternRef: pattern "${patternName}" net "${net.name}" endpoint "${ep}" is not in REF.PIN format`);
      }
      const oldRef = match[1]!;
      const pinNum = match[2]!;
      const newRef = refMap.get(oldRef);
      if (!newRef) {
        throw new Error(`expandPatternRef: pattern "${patternName}" net "${net.name}" endpoint "${ep}" references unknown part "${oldRef}"`);
      }
      rewrittenPins.push(`${newRef}.${pinNum}`);
    }

    const rewrittenNet: IntentNet = {
      name: net.name,
      pins: rewrittenPins,
    };

    if (net.kind !== undefined) {
      rewrittenNet.kind = net.kind;
    }

    rewrittenNets.push(rewrittenNet);
  }

  return {
    parts: renumberedParts,
    nets: rewrittenNets,
  };
}
