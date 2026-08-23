/**
 * Fab release gate checks (OpenSpec: add-fab-release-gate).
 * Documentation presence is pure over file contents: LLM-free, network-free.
 */

/** Violation shape shared by the fab JSON report (`claim` / `actual` / optional location). */
export interface FabViolation {
  claim: string;
  actual: string;
  location?: string;
}

export interface FabCheckResult {
  status: 'pass' | 'warn' | 'fail';
  violations: FabViolation[];
}

export const DRAFT_QUALITY_HEADING = '## Draft quality';

/** Config marker: repos produced by `copperhead create` set `origin` to `"create"`. */
export const CREATE_ORIGIN = 'create';

/** Generator stamp carried by every schematic copperhead authors (the
 * bootstrap scaffold and every emitter draft). */
export const DRAFT_GENERATOR_MARKER = '(generator "copperhead-draft")';

/**
 * Is the schematic still copperhead-authored? True while the file carries the
 * generator stamp. A human taking the sheet over in KiCad re-saves it with
 * KiCad's own generator string, which is the deliberate one-way door out of
 * drafting mode: the edit guard lifts and the legibility finish gate stops
 * applying, because the drawing is no longer the engine's to defend.
 */
export function isEngineAuthoredSchematic(text: string): boolean {
  return text.slice(0, 400).includes(DRAFT_GENERATOR_MARKER);
}

/**
 * True when `.copperhead/config.json` marks the repo as create-produced.
 * Accepts the raw parsed object (or a loaded config that retained `origin`).
 */
export function isCreateProducedRepo(config: unknown): boolean {
  if (config === null || typeof config !== 'object') return false;
  return (config as { origin?: unknown }).origin === CREATE_ORIGIN;
}

/**
 * Body of `## Draft quality` through the next `##` heading, or `null` if the
 * heading is absent. HTML comments and whitespace alone do not count as filled
 * (init scaffolds the empty heading + a placeholder comment).
 */
export function draftQualitySection(layoutMd: string): string | null {
  const lines = layoutMd.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === DRAFT_QUALITY_HEADING) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;

  const body: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^##\s/.test(line.trim())) break;
    body.push(line);
  }
  return body.join('\n');
}

export function isFilledDraftQuality(sectionBody: string): boolean {
  const withoutComments = sectionBody.replace(/<!--[\s\S]*?-->/g, '');
  return withoutComments.trim().length > 0;
}

export interface DocumentationPresenceInput {
  /** Full LAYOUT.md text, or `null` when the file is missing. */
  layoutMd: string | null;
  /** Whether docs/DEVPLAN.md exists on disk. */
  devplanExists: boolean;
  /** From {@link isCreateProducedRepo}; only create repos require DEVPLAN.md. */
  isCreateRepo: boolean;
  /** Docs directory name used in violation locations (default `docs`). */
  docsDir?: string;
}

/**
 * Documentation-presence check for `check --fab` (task 1.5):
 * - LAYOUT.md must have a filled `## Draft quality` section
 * - create-produced repos must also have DEVPLAN.md
 *
 * Failures use the drift-report voice: file as location, claim `"release-ready"`.
 */
export function checkDocumentationPresence(input: DocumentationPresenceInput): FabCheckResult {
  const docs = (input.docsDir ?? 'docs').replace(/[/\\]+$/, '');
  const violations: FabViolation[] = [];
  const layoutLoc = `${docs}/LAYOUT.md`;
  const claim = 'release-ready';

  if (input.layoutMd === null) {
    violations.push({
      claim,
      actual: 'LAYOUT.md missing',
      location: layoutLoc,
    });
  } else {
    const section = draftQualitySection(input.layoutMd);
    if (section === null) {
      violations.push({
        claim,
        actual: `missing ${DRAFT_QUALITY_HEADING} section`,
        location: layoutLoc,
      });
    } else if (!isFilledDraftQuality(section)) {
      violations.push({
        claim,
        actual: `${DRAFT_QUALITY_HEADING} section is empty`,
        location: layoutLoc,
      });
    }
  }

  if (input.isCreateRepo && !input.devplanExists) {
    violations.push({
      claim,
      actual: 'missing',
      location: `${docs}/DEVPLAN.md`,
    });
  }

  return {
    status: violations.length === 0 ? 'pass' : 'fail',
    violations,
  };
}
