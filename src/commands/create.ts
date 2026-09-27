import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadConfig, resolveCompatSettings } from '../config.js';
import { bootstrapKicadProject, markCreateOrigin } from '../kicad/bootstrap.js';
import { exportNetlist, exportSvg, runDrc, runErc } from '../kicad/cli.js';
import { FootprintResolver, formatMissingFootprints, missingFootprints } from '../kicad/footprints.js';
import {
  boardFootprints,
  boardMatchesNetlist,
  MissingFootprintsError,
  padNetMismatches,
  parseNetlist,
  populateBoard,
} from '../kicad/populate.js';
import { formatViolations } from '../kicad/report.js';
import { bomFootprintRows } from '../memory/bom-table.js';
import type { MissingFootprint } from '../kicad/footprints.js';
import { listSymbols } from '../kicad/sexp.js';
import { checkLegibility } from '../kicad/legibility.js';
import { draftSchematicToText, defaultIntentPath } from '../kicad/draft/draft.js';
import { isDirty, commitAll, changedFiles, fileAtCommit, headCommit } from '../util/git.js';
import type { CompatSettings, CopperheadConfig } from '../config.js';
import { checkDrift } from '../memory/drift.js';
import { runAgentLoop, makeProvider, type BudgetExhaustedStats } from '../agent/loop.js';
import { diagnoseStageFailure, transcriptExcerpt, withTimeout, symbolAvailabilityFacts, type StageDiagnosis } from '../agent/recovery.js';
import type { Provider } from '../agent/types.js';
import type { RunMetaInput } from '../agent/runmeta.js';
import { fmtDuration, fmtTokens, type ProgressRenderer } from '../agent/render.js';
import { copper, dim, ok, stageLine, warn } from '../agent/theme.js';
import { openspecInit } from '../openspec/cli.js';
import { sweepStaleTempDirs, pruneHistoryDir } from '../util/tmp.js';
import { bomSymbolDossier } from '../kicad/dossier.js';
import { symbolSearchDirs } from '../kicad/symlib.js';
import { isDraftQualityHeading } from '../kicad/fab.js';
import { assertDiskSpace, DEFAULT_MIN_FREE_BYTES } from '../util/preflight.js';
import { runCheck } from './check.js';
import { emitCreateJlcpcbBom } from './export.js';

/**
 * Mode A (`copperhead create`, SPEC §2.5): staged pipeline, each stage a
 * do-loop run with a stage prompt and gate. Stage completion is inferred from
 * repo state, which makes the pipeline resumable for free (design D10).
 * Run-to-completion: gates are quality checks the agent must satisfy, not
 * stops that wait for a human (unless --interactive).
 */
interface Stage {
  name: string;
  /** true when repo state shows the stage is already done (resume support). */
  isComplete: (repoRoot: string, docs: string) => Promise<boolean> | boolean;
  /** `docs` is the configured docs dir, so a prompt names the exact path its gate reads (#310). */
  prompt: (brief: string, docs: string) => string;
}

const docExists = (repoRoot: string, rel: string) => existsSync(path.join(repoRoot, rel));

async function docHasContent(repoRoot: string, rel: string, marker: string): Promise<boolean> {
  const p = path.join(repoRoot, rel);
  if (!existsSync(p)) return false;
  return (await readFile(p, 'utf8')).includes(marker);
}

// Heading-aware variant of docHasContent: matches any Markdown heading whose
// text contains `word`, ignoring heading level, leading numbering ("3."), and
// trailing decoration ("Budgets and constraints (...)"). Stage prompts don't
// dictate exact heading text, so a literal `.includes('## Budgets')` produces
// false negatives against valid docs titled e.g. "## 3. Budgets and constraints".
/** The layout document has its Draft quality heading, numbered or not (#327). */
async function docHasDraftQuality(repoRoot: string, rel: string): Promise<boolean> {
  const p = path.join(repoRoot, rel);
  if (!existsSync(p)) return false;
  return (await readFile(p, 'utf8')).split(/\r?\n/).some(isDraftQualityHeading);
}

async function docHasHeading(repoRoot: string, rel: string, word: string): Promise<boolean> {
  const p = path.join(repoRoot, rel);
  if (!existsSync(p)) return false;
  const re = new RegExp(`^#{1,6}\\s.*\\b${word}\\b`, 'im');
  return re.test(await readFile(p, 'utf8'));
}

export async function writeBriefHash(
  repoRoot: string,
  docsDir: string,
  briefMeta: { path: string; sha256: string },
): Promise<void> {
  const file = path.join(repoRoot, docsDir, 'BRIEF.sha256');

  await mkdir(path.dirname(file), { recursive: true });

  try {
    await writeFile(
      file,
      `brief: ${briefMeta.path}
sha256: ${briefMeta.sha256}
`,
      {
        encoding: 'utf8',
        flag: 'wx',
      },
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'EEXIST') throw err;
  }
}

/**
 * Returns true when a directory exists and contains at least one file
 * matching the optional glob-style extension list (case-insensitive).
 * No extension list = any file.
 */
async function dirHasFiles(dirPath: string, exts?: string[]): Promise<boolean> {
  if (!existsSync(dirPath)) return false;
  async function walk(dir: string): Promise<boolean> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (await walk(path.join(dir, entry.name))) return true;
      } else if (!exts || exts.some((e) => entry.name.toLowerCase().endsWith(e))) {
        return true;
      }
    }
    return false;
  }
  return walk(dirPath);
}

export const STAGES: Stage[] = [
  {
    name: 'spec-seed',
    isComplete: async (root, docs) => {
      // The init scaffold writes SPEC.md with a "## Budgets" heading and an
      // HTML comment placeholder — that alone must not count as complete.
      // Require the heading AND at least one non-comment, non-blank line
      // of real budget content beneath it (a filled section vs. an empty placeholder).
      const p = path.join(root, docs, 'SPEC.md');
      if (!existsSync(p)) return false;
      const text = await readFile(p, 'utf8');
      const heading = /^(#{1,6})\s.*\bBudgets?\b.*$/im.exec(text);
      if (!heading) return false;
      // The section runs to the next heading of the SAME OR SHALLOWER depth, not to
      // the next heading of any depth (I17): a real spec routinely splits its budgets
      // into subsections — "## 3. Electrical budgets" followed immediately by
      // "### 3.1 Input and rails" — which leaves the parent's own body empty and read
      // as an unfilled placeholder. Subheadings are part of the section, not its end.
      const depth = heading[1]!.length;
      const afterHeadingLine = text.slice(heading.index + heading[0].length);
      const nextSection = afterHeadingLine.search(new RegExp(`^#{1,${depth}}\\s`, 'm'));
      const section = nextSection >= 0 ? afterHeadingLine.slice(0, nextSection) : afterHeadingLine;
      // Strip HTML comments (single or multi-line); headings inside the section are
      // structure, not content, so a section of nothing but subheadings still fails.
      const cleanSection = section.replace(/<!--[\s\S]*?-->/g, '');
      const realLines = cleanSection
        .split('\n')
        .filter((l) => l.trim().length > 0 && !/^#{1,6}\s/.test(l.trim()));
      return realLines.length > 0;
    },
    prompt: (brief) =>
      `Stage 1 of the create pipeline: seed the requirements. From the product brief below, write docs/SPEC.md (what the device is, top-level constraints and budgets). Every budget you state must also be recorded with record_constraint. Anything the brief does not state: propose a sensible default and flag it ASSUMED. If an openspec/ workspace exists, also seed openspec/specs/ with per-capability requirements using Given/When/Then scenarios.\n\nBrief:\n${brief}`,
  },
  {
    name: 'architecture',
    isComplete: async (root, docs) => {
      // init scaffolds SUBSYSTEMS.md with boilerplate description text and auto-generated
      // "## Sheet X" headings containing "- Ref: Value" symbol bullets.
      // Require at least one level-2+ heading (## section) AND at least one real prose
      // line beneath it (excluding boilerplate and auto-generated symbol bullets).
      const p = path.join(root, docs, 'SUBSYSTEMS.md');
      if (!existsSync(p)) return false;
      const text = await readFile(p, 'utf8');
      // Must have at least one level-2+ (##) section heading
      if (!/^#{2,6}\s/m.test(text)) return false;
      // Filter out headings, scaffold description, and auto-generated symbol bullets (- Ref: Value or - Ref?: Value)
      const contentLines = text.split('\n').filter((l) => {
        const trimmed = l.trim();
        if (!trimmed || trimmed.startsWith('#')) return false;
        if (trimmed.includes('Per-sheet values and reasoning')) return false;
        if (/^-\s+(?:[A-Za-z]+\d+[A-Za-z]*|[A-Za-z]*\?):/.test(trimmed)) return false; // auto-generated refdes symbol bullet (e.g. - R1: 10k, - U?: ESP32, - ?: 10k)
        return true;
      });
      return contentLines.length > 0;
    },
    prompt: () =>
      'Stage 2: architecture. Write docs/SUBSYSTEMS.md: the block diagram in prose, one section per subsystem (power, MCU, connectivity, UI, ...), with the reasoning and key values for each. Respect every budget in SPEC.md.',
  },
  {
    name: 'part-selection',
    isComplete: async (root, docs) => {
      // init scaffolds BOM.md with a table pre-filled with UNVERIFIED MPNs
      // extracted from the schematic. Require at least one row whose MPN
      // column is NOT the UNVERIFIED placeholder — i.e. a real part was chosen.
      const p = path.join(root, docs, 'BOM.md');
      if (!existsSync(p)) return false;
      const text = await readFile(p, 'utf8');
      // Find table rows (lines starting with |) that are not the header or separator
      const rows = text.split('\n').filter(
        (l) => l.startsWith('|') && !l.includes('---') && !l.toLowerCase().includes('refdes'),
      );
      if (!rows.length) return false;
      // At least one row must have a non-UNVERIFIED MPN (4th column)
      return rows.some((row) => {
        const cols = row.split('|').map((c) => c.trim());
        const mpn = cols[4] ?? ''; // 0=empty, 1=Refdes, 2=Value, 3=Footprint, 4=MPN
        return mpn && !mpn.toUpperCase().startsWith('UNVERIFIED');
      }) && !(await bomFootprintMisses(root, docs))?.missing.some(modelFixable);
      // ^ every footprint resolves, except a library the user must install
      // (that stops the run before the schematic stage, #314)
    },
    prompt: () =>
      'Stage 3: part selection. Write docs/BOM.md with the fixed table format (| Refdes | Value | Footprint | MPN | Rationale |). The Value column holds the COMPONENT VALUE and nothing else — "4.7uF", "1M", "500mAh Li-Po", "STM32F103C8T6" — because stage 4 draws it on the sheet as that part\'s Value field, where a description ("1S Li-Po cell, 500 mAh, bare leads") collides with neighbouring symbols and fails the legibility gate. Put the prose in the Rationale column instead; that is the column for it, and nothing draws it. One row per refdes: a grouped row ("SW3-SW16", "C5-C8") is not a BOM row and the schematic stage cannot match it. Every MPN you introduce is flagged UNVERIFIED with a datasheet-verifiable justification. Check leakage/quiescent current of every part against the power budget. The design must be capturable with the KiCad symbol libraries installed on THIS machine: run search_symbols for every IC, module, connector and other active part before committing it to the BOM, and if a part has no installed symbol, pick one that has — stage 4 draws only from installed symbols, and a BOM row it cannot resolve makes the whole run unwinnable. Existence is not enough: confirm the chosen symbol with symbol_pins so the pin numbers you wire in stage 4 are real. Multi-unit symbols (gate packs, dual opamps) are fine — the engine places each unit separately under the one refdes, and net endpoints use plain package pin numbers. The Footprint column holds an exact installed KiCad footprint id (Lib:Name): call check_footprints on every Footprint cell before finishing and use only ids it reports OK (it lists the closest installed ids on a miss). The board is built from exactly these ids — nothing is substituted later — and a footprint that is not installed stops the run for the user to install it. Run check_drift before finishing.',
  },
  {
    name: 'schematic',
    isComplete: async (root) => {
      const config = await loadConfig(root);
      if (!config.schematic) return false;
      const p = path.join(root, config.schematic);
      if (!existsSync(p)) return false;
      // Mere file existence is not completion: bootstrapping leaves a blank
      // sheet on disk (a hand-scaffolded project, or the future fix for #19),
      // and skipping this stage over a blank sheet cascades — layout and
      // outputs then run against nothing. The stage's contract is "build the
      // schematic from BOM.md", so completion means symbols exist AND the
      // BOM/PINOUT tables agree with them (drift-clean); anything less keeps
      // the stage active on the next resume so partial capture continues.
      if (!(await listSymbols(p)).length) return false;
      if ((await checkDrift(root, config.docs, config.schematic)).length !== 0) return false;
      // ERC-clean is part of "done" (F2 / verification-gated-out on the resume
      // path). Symbols + drift-clean can still hold on a schematic with
      // unconnected pins — e.g. a run hard-killed mid-capture after BOM/PINOUT
      // went clean but before ERC passed. Without this check, resume would treat
      // it as complete and commitResumedStage would commit an ERC-failing
      // schematic, advancing the pipeline against unverified work. Returning
      // false here keeps the stage active so it re-runs, fixes ERC, and commits
      // through the normal finish gate.
      if (!(await runErc(p)).ok) return false;
      // Legibility is the one stage-4 output no electrical gate sees (AC-16.22):
      // an ERC-clean sheet with text over symbol bodies passes everything above
      // while being unreviewable. Error-severity findings keep the stage active;
      // advisories never block.
      const legibility = await checkLegibility(p, {
        docsDir: path.join(root, config.docs),
        ...(config.legibility ? { config: config.legibility } : {}),
      });
      if (legibility.counts.error !== 0) return false;
      // Drafting mode: the schematic must match a re-draft of the current IR
      // (AC-16.20) — an intent edited after the last draft_schematic call means
      // the sheet on disk no longer reflects the design and the stage stays
      // active until a re-draft.
      const intentRel = defaultIntentPath(config.schematic);
      if (existsSync(path.join(root, intentRel))) {
        // With a footprint resolver, so the pin/pad checks (#314, #325) run at
        // completion too: a sheet drafted against a mismatched footprint is sent
        // back to this stage instead of populating a board with floating pads.
        const dry = await draftSchematicToText({
          repoRoot: root,
          schematic: config.schematic,
          intentPath: intentRel,
          docsDir: config.docs,
          footprints: await FootprintResolver.create({ projectDir: path.dirname(p) }),
        });
        if (!dry.ok) return false;
        if (dry.text !== (await readFile(p, 'utf8'))) return false;
      }
      return true;
    },
    prompt: () =>
      'Stage 4: schematic. An empty KiCad project has already been scaffolded and wired into .copperhead/config.json. You author INTENT, never geometry: write the netlist-intent IR and call draft_schematic — the deterministic engine computes every coordinate, wire, label, power symbol, and group box, and the sheet it draws satisfies the drafting standard by construction (captioned group boxes per SUBSYSTEMS.md subsystem, left-to-right flow, rails up and grounds down, net labels between groups, filled title block). The IR (schematic.intent.json) is JSON: {"version": 1, "parts": [{"ref", "libId", "value", "footprint", "group"}], "nets": [{"name", "pins": ["REF.PIN", …], "kind"?}], "noConnect": ["REF.PIN", …], "hints"?: {"groupOrder"?, "paper"?, "date"?}}. Build it from BOM.md (same refdes and values — validation cross-checks and refuses mismatches) and SUBSYSTEMS.md (every non-power part names one subsystem heading as its group). Use exact canonical KiCad lib_ids (e.g. Device:R) and REAL pin numbers from the library: the pin dossier below (when present) already lists every BOM part\'s installed symbol and its real pins — work from it and from symbol_pins rather than reading .kicad_sym files, and validation lists a part\'s actual pins when you name one that does not exist. Name nets as a reader expects: a bus or interface shares a prefix (I2S_BCLK, I2S_DIN, I2S_LRCLK; SPI_…; BTN_…) so the drawing colours the family together, differential pairs end in +/- or P/N, and part values carry their unit (F, H, R). Declare every deliberately unused pin in noConnect; power rails are recognized from pin types automatically (override with "kind" only when the inference is wrong — the draft report lists every net\'s resolved class). Pass the full IR as intent_json to draft_schematic; the report embeds the legibility findings and the score for the fresh sheet. To repair ANY finding (ERC, legibility, validation), fix the IR and call draft_schematic again — edit_file is refused on the drafted sheet. Text-collision findings scale with TEXT LENGTH: a net label, part value, or SUBSYSTEMS heading that is shorter draws a smaller box, so renaming a colliding net (and updating PINOUT.md) or tightening a long heading is a real repair lever; paper size and declaration order are not (placement is grid-derived). When the draft is clean run run_erc and check_drift, update PINOUT.md to match the IR\'s pin assignments, and finish.',
  },
  {
    name: 'layout-draft',
    isComplete: async (root, docs) => {
      // The LAYOUT.md marker alone is not enough: `copperhead init` scaffolds
      // LAYOUT.md with the literal "## Draft quality" heading. And "a board
      // with a footprint" was not enough either (#314): the board must carry
      // exactly the schematic's parts, each with its schematic footprint, so
      // an outline-only board or a partial one never passes (AC-15.38).
      const config = await loadConfig(root);
      if (!config.board || !config.schematic) return false;
      if (!(await boardMatchesSchematic(root, config)).ok) return false;
      if (await layoutDocGap(root, docs)) return false;
      // DRC-clean is part of "done", as ERC is for the schematic stage: a run
      // killed after Draft quality was written but before a clean run_drc must
      // not resume as complete and get its board committed unverified
      return boardDrcOk(root, config.board);
    },
    prompt: (_brief, docs) => {
      // posix: this path is shown to the model, and must read the same on Windows
      const layoutDoc = path.posix.join(docs, 'LAYOUT.md');
      // a docs dir of "." makes the root file the document itself; only then is a root
      // LAYOUT.md the right place, so the warning must not contradict the path
      const where = layoutDoc === 'LAYOUT.md'
        ? '(at the repository root)'
        : '(that exact repo-relative path; a LAYOUT.md anywhere else, including the repository root, is not read)';
      return (
        `Stage 5: first-draft layout. Every schematic part is already on the board with its exact library footprint, pad nets assigned, packed on a grid inside the outline (the populate step did this from the schematic before your first turn; a board it has just written passed DRC and starts fully unrouted, and when the stage resumes on a board populated earlier, run run_drc first to see where it stands). Your job is placement and routing, not geometry: move and rotate each part with move_footprint (never hand-edit a footprint's (at …): KiCad stores pad angles as absolute, so a hand rotation leaves the pads facing the old way and shorts them), and resize the Edge.Cuts outline to the brief's envelope. Everything else on the board is an anchored edit_file on the .kicad_pcb, and that is expected, not a workaround: tracks, vias, zones, the outline, and the (at …) inside a part's Reference or Value property (the label's own position, not the footprint's), which is how a silkscreen overlap is fixed. Rules: connectors on edges, decoupling at IC pins, ESD at connectors, keepouts honored. Never add, delete, or rewrite a footprint, pad, or net — the stage gate compares every footprint and pad net against the schematic and fails on any difference. Route power and short critical nets; leave the rest as ratsnest. Run run_drc after each batch of moves: it must be clean, and it reports unrouted connections as a count, not a failure — leaving nets as ratsnest is allowed, but a run that ends with more unrouted connections than the board started with fails, since that means a connection was broken — and findings inside a single library footprint (its own pads and holes) as a separate list you cannot fix and must not try to: name them in Draft quality. The populated board counts as this stage's edit, so finishing needs a clean run_drc, run_erc, and check_drift even if you move nothing. Then write the "## Draft quality" section in ${layoutDoc} ${where}: exactly what is fine, how many connections are still unrouted, and what a human or specialist tool should redo. Non-optimal is acceptable; unlabeled non-optimal is not.`
      );
    },
  },
  {
    name: 'outputs',
    isComplete: async (root) => {
      // An empty outputs/ dir (e.g. from a failed export run) must not count
      // as complete. Require at least one Gerber file (any .gbr variant).
      return dirHasFiles(path.join(root, 'outputs'), ['.gbr', '.gtl', '.gbl', '.gbs', '.gbo', '.gbp', '.gbd', '.gto', '.gts', '.gml']);
    },
    prompt: () =>
      'Stage 6: outputs package. Export into outputs/: gerbers+drill (JLC profile), DXF and STEP outline, SVG renders (export_svg), and an ordering BOM.csv generated from BOM.md (refdes, MPN, qty). Every export must succeed.',
  },
  {
    name: 'firmware',
    isComplete: async (root) => {
      // An empty firmware/ dir must not count. Require at least one source file.
      return dirHasFiles(path.join(root, 'firmware'), ['.c', '.h', '.cpp', '.hpp', '.py', '.rs', '.ino', '.s']);
    },
    prompt: () =>
      'Stage 7: firmware scaffold. Generate firmware/ for the chosen MCU HAL: pins.h generated from PINOUT.md (single source of truth), driver stubs, and one working happy path. If the vendor toolchain is available, the build must pass; if not, note "not compiled here" explicitly in DEVPLAN.md.',
  },
  {
    name: 'devplan',
    isComplete: async (root, docs) => {
      // init does NOT scaffold DEVPLAN.md, but a blank file must not count.
      // Require at least one ## section heading AND at least one content line.
      const p = path.join(root, docs, 'DEVPLAN.md');
      if (!existsSync(p)) return false;
      const text = await readFile(p, 'utf8');
      if (!/^#{1,6}\s/m.test(text)) return false;
      const contentLines = text.split('\n').filter(
        (l) => l.trim() && !l.trim().startsWith('#'),
      );
      return contentLines.length > 0;
    },
    prompt: () =>
      'Stage 8: DEVPLAN.md. Write docs/DEVPLAN.md: bring-up steps in order, test points and what to meter first, risk list, and the prototype order plan.',
  },
];

export interface CreateOptions {
  repoRoot: string;
  briefPath: string;
  model: string;
  interactive?: boolean;
  /** Forwarded to each stage's run (attended continue-on-exhaustion prompt). */
  onBudgetExhausted?: (stats: BudgetExhaustedStats) => Promise<number>;
  log: (s: string) => void;
  renderer?: ProgressRenderer;
  /** Command-level metadata; stage and brief identity are filled in per stage. */
  meta?: Omit<RunMetaInput, 'stage' | 'brief'>;
}

/**
 * Stage 6 emits the JLCPCB assembly BOM deterministically alongside the agent's
 * outputs package (create-pipeline delta). Called whenever the outputs stage is
 * confirmed complete — on the pass that finishes it and on any later resume — so
 * the file tracks the current BOM.md.
 */
async function emitJlcpcbAfterOutputs(stageName: string, opts: CreateOptions): Promise<void> {
  if (stageName !== 'outputs') return;
  const out = await emitCreateJlcpcbBom(opts.repoRoot);
  if (out) opts.log(stageLine('outputs', `emitted ${out} (JLCPCB assembly BOM)`, 'ok'));
}

/**
 * The generic "contract not met" line names no defect. For the schematic stage
 * the most common gap after the electrical gates go green is legibility, so
 * name the finding counts by kind — the resume then starts on the actual work
 * instead of rediscovering it.
 */
/**
 * The board against the schematic netlist (#314): the same (ref, footprint)
 * pairs, and every pad on the schematic's net (AC-15.38). Any failure to read
 * either side reads as a mismatch, never as a pass.
 */
async function boardMatchesSchematic(
  root: string,
  config: CopperheadConfig,
): Promise<{ ok: boolean; detail: string }> {
  if (!config.board || !config.schematic) return { ok: false, detail: 'no board or schematic configured' };
  const boardPath = path.join(root, config.board);
  if (!existsSync(boardPath)) return { ok: false, detail: `${config.board} does not exist` };
  try {
    const netlist = parseNetlist(await exportNetlist(path.join(root, config.schematic)));
    const boardText = await readFile(boardPath, 'utf8');
    const cmp = boardMatchesNetlist(boardFootprints(boardText), netlist.parts);
    const nets = cmp.ok ? padNetMismatches(boardText, netlist) : [];
    if (cmp.ok && !nets.length) return { ok: true, detail: '' };
    const parts = [
      cmp.missing.length && `missing ${cmp.missing.join(', ')}`,
      cmp.extra.length && `extra ${cmp.extra.join(', ')}`,
      cmp.changed.length && `footprint changed on ${cmp.changed.join(', ')}`,
      nets.length && `pad nets differ on ${nets.slice(0, 8).join(', ')}${nets.length > 8 ? ', …' : ''}`,
    ].filter(Boolean);
    return { ok: false, detail: `the board does not match the schematic: ${parts.join('; ')}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

/** The board passes DRC (a board KiCad cannot load does not). */
async function boardDrcOk(root: string, board: string): Promise<boolean> {
  try {
    return (await runDrc(path.join(root, board))).ok;
  } catch {
    return false;
  }
}

/**
 * Before the schematic stage (AC-15.32): every BOM.md footprint must be
 * installed. Returns the stop message, or null to proceed. A missing BOM
 * table is left to the stage itself.
 */
async function bomFootprintMisses(
  root: string,
  docs: string,
): Promise<{ missing: MissingFootprint[]; searched: string[] } | null> {
  const bomPath = path.join(root, docs, 'BOM.md');
  if (!existsSync(bomPath)) return null;
  const rows = bomFootprintRows(await readFile(bomPath, 'utf8'));
  if (!rows.length) return null;
  const config = await loadConfig(root);
  const anchor = config.board ?? config.schematic;
  const resolver = await FootprintResolver.create({ projectDir: anchor ? path.dirname(path.join(root, anchor)) : root });
  const missing = await missingFootprints(rows.map((r) => ({ ref: r.refdes, footprint: r.footprint })), resolver);
  return { missing, searched: resolver.searched };
}

/**
 * A miss the model can fix in BOM.md: a mistyped or invented name, a
 * non-id cell, an unassigned footprint, or a library nickname whose footprint
 * is installed under another library by that exact name. A library that is
 * simply not installed is the user's to install, and stops the run; the
 * ranked guesses a miss may carry (`fuzzy`) are shown there, not acted on.
 */
const modelFixable = (m: MissingFootprint): boolean => m.why !== 'no-library' || (m.near.length > 0 && !m.fuzzy);

async function bomFootprintStop(root: string, config: CopperheadConfig): Promise<string | null> {
  const r = await bomFootprintMisses(root, config.docs);
  return r?.missing.length ? formatMissingFootprints(r.missing, r.searched, 'the schematic stage') : null;
}

/**
 * Before each layout-draft attempt (AC-15.36): put the schematic's parts on
 * the board. Returns the stop message when the board cannot be populated
 * faithfully, or null to run the stage. Idempotent on an already-populated
 * board, so a retry or a resume re-checks without rewriting. A board this
 * step wrote must pass DRC before the agent's first turn (AC-15.43): the
 * agent may move parts but not repair footprints, so a populated board that
 * fails is a stop, not a task. The caller restores the pre-stage board.
 */
async function populateStop(opts: CreateOptions): Promise<string | null> {
  const config = await loadConfig(opts.repoRoot);
  if (!config.board || !config.schematic) return 'no board or schematic is configured; the schematic stage did not scaffold one';
  try {
    const r = await populateBoard({ repoRoot: opts.repoRoot, schematic: config.schematic, board: config.board });
    // An already-populated board gets the same DRC: it may be a committed
    // attempt's (verified, and cheap to confirm) or the board of a run killed
    // between the populate write and its DRC, which the resume commit sweeps
    // into HEAD unverified.
    if (!r.unchanged) {
      opts.log(
        stageLine(
          'layout-draft',
          `placed ${r.placed.length} footprint(s) from the schematic on ${config.board} (${r.nets} nets, unrouted` +
            `${r.outline.grown ? `; outline grown to ${r.outline.width} x ${r.outline.height} mm to fit` : ''})`,
          'ok',
        ),
      );
    }
    const drc = await runDrc(path.join(opts.repoRoot, config.board));
    if (drc.ok) return null;
    // KiCad resolves footprints through its library tables only; copperhead
    // also finds the stock install without them, so a library no table lists
    // (every one, on a fresh headless install with no global fp-lib-table)
    // populates fine and then fails here
    const unlisted = drc.violations.some((v) => v.type === 'lib_footprint_issues')
      ? "\nKiCad's library tables do not list the libraries these parts come from, though copperhead found them installed. " +
        "Add them to your global fp-lib-table (or, if you have none, copy KiCad's default table, the template/fp-lib-table file " +
        'in its install, into your KiCad config folder), then re-run.'
      : '';
    const left = r.unchanged
      ? `${config.board} was populated before this run and is left as it is; fix the findings, or remove its footprints so the next run populates it afresh`
      : `${config.board} is restored to the last verified board`;
    return `the populated board fails DRC before any placement, so ${left}:\n${formatViolations(drc)}${unlisted}`;
  } catch (e) {
    if (e instanceof MissingFootprintsError) return formatMissingFootprints(e.missing, e.searched, 'the layout-draft stage');
    return `could not put the schematic's parts on the board: ${(e as Error).message}`;
  }
}

/**
 * What is wrong with the layout document, or null when it has its Draft quality
 * section. Names the path the gate reads, and the stray root file when that is the
 * cause (#310): a model that can see the section in its own LAYOUT.md cannot find
 * a gap reported as just "LAYOUT.md".
 */
export async function layoutDocGap(root: string, docs: string): Promise<string | null> {
  const layoutDoc = path.posix.join(docs, 'LAYOUT.md');
  if (await docHasDraftQuality(root, layoutDoc)) return null;
  const stray = layoutDoc !== 'LAYOUT.md' && (await docHasDraftQuality(root, 'LAYOUT.md'));
  return (
    `${layoutDoc} has no "## Draft quality" section` +
    (stray ? `; the section was written to LAYOUT.md at the repository root, which this stage does not read: put it in ${layoutDoc}` : '')
  );
}

async function contractGapDetail(stageName: string, root: string, config: CopperheadConfig): Promise<string> {
  const generic = 'the run finished but the stage completion contract is not met — no usable artifact was produced';
  if (stageName === 'part-selection') {
    const r = await bomFootprintMisses(root, config.docs);
    const fixable = r?.missing.filter(modelFixable) ?? [];
    if (fixable.length) {
      return (
        `the part-selection contract is not met: ${fixable.length} BOM.md footprint(s) do not resolve to an installed footprint — ` +
        fixable.map((m) => `${m.ref} ${m.footprint || '(none)'}${m.near.length ? ` (installed: ${m.near.slice(0, 3).join(', ')})` : ''}`).join('; ') +
        '; call check_footprints on every Footprint cell and use exact installed ids'
      );
    }
  }
  if (stageName === 'layout-draft') {
    const fresh = await loadConfig(root);
    const m = await boardMatchesSchematic(root, fresh);
    if (!m.ok) {
      return `the layout-draft contract is not met: ${m.detail}; restore the populated footprints (never add or rewrite them) and move them instead`;
    }
    const docGap = await layoutDocGap(root, fresh.docs);
    return docGap
      ? `the layout-draft contract is not met: ${docGap}`
      : 'the layout-draft contract is not met: the board does not pass DRC; run run_drc and fix what it reports before finishing';
  }
  if (stageName !== 'schematic' || !config.schematic) return generic;
  const p = path.join(root, config.schematic);
  if (!existsSync(p)) return generic;
  try {
    const report = await checkLegibility(p, {
      docsDir: path.join(root, config.docs),
      ...(config.legibility ? { config: config.legibility } : {}),
    });
    if (report.counts.error > 0) {
      const byKind = new Map<string, number>();
      for (const f of report.findings.filter((f) => f.severity === 'error')) {
        byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
      }
      const counts = [...byKind].map(([k, n]) => `${k}: ${n}`).join(', ');
      return `the schematic stage contract is not met: ${report.counts.error} error-severity legibility finding(s) remain (${counts}); resume to reconcile them`;
    }
  } catch {
    // fall through: an unreadable schematic already fails earlier contract steps
  }
  return generic;
}

/** Stages whose output is a KiCad file worth rendering to an image (5.4). */
const KICAD_STAGES = new Set(['schematic', 'layout-draft', 'outputs']);

/** True for a path copperhead itself manages inside the pipeline. Used to decide
 *  whether a resumed stage's uncommitted work is safe to auto-commit (2.4): only
 *  when the ENTIRE dirty set is copperhead's, never sweeping up a user's own WIP. */
export function isManagedPath(f: string, config: CopperheadConfig): boolean {
  // config.docs defaults to `docs/` (trailing slash), so normalize before
  // building the prefix — otherwise the check becomes `startsWith('docs//')` and
  // every doc reads as foreign, making commitResumedStage never commit its own
  // work (it always bails as "non-copperhead changes").
  const docsDir = config.docs.replace(/\/+$/, '');
  return (
    f === docsDir ||
    f.startsWith(`${docsDir}/`) ||
    f.startsWith('.copperhead/') ||
    f.startsWith('openspec/') ||
    f.startsWith('outputs/') ||
    f.startsWith('firmware/') ||
    f.startsWith('sym-lib-cache/') ||
    f === '.gitignore' ||
    path.basename(f) === 'sym-lib-table' ||
    path.basename(f) === 'schematic.intent.json' ||
    /\.(kicad_sch|kicad_pcb|kicad_pro|kicad_prl|kicad_dru)$/.test(f)
  );
}

/**
 * When resuming past an already-complete stage whose artifact is present but
 * UNCOMMITTED (e.g. a prior invocation stopped on a session limit mid-pipeline),
 * commit it now so a later stage's failure — whose rollback is `git reset --hard`
 * + `git clean -fd` — cannot wipe the completed work from the tree (2.4, I13).
 * Strictly gated: only when every dirty path is copperhead-managed, so a user's
 * unrelated working changes are never swept into a copperhead commit; if any
 * foreign path is dirty, leave the whole thing for the human and say so.
 */
async function commitResumedStage(opts: CreateOptions, config: CopperheadConfig, stageName: string): Promise<boolean> {
  if (!(await isDirty(opts.repoRoot))) return true;
  const dirty = await changedFiles(opts.repoRoot, 'HEAD');
  const foreign = dirty.filter((f) => !isManagedPath(f, config));
  if (foreign.length) {
    opts.log(
      stageLine(
        stageName,
        `already-complete work is uncommitted, but the tree also has non-copperhead changes ` +
          `(${foreign.slice(0, 3).join(', ')}${foreign.length > 3 ? ', …' : ''}); leaving it uncommitted so nothing of yours is swept up`,
        'warn',
      ),
    );
    return false;
  }
  try {
    const sha = await commitAll(opts.repoRoot, `copperhead: resume — commit completed stage ${stageName}`);
    opts.log(
      stageLine(
        stageName,
        `committed already-complete work ${sha.slice(0, 10)} so a later rollback cannot wipe it (2.4)`,
        'ok',
      ),
    );
    return true;
  } catch (e) {
    opts.log(stageLine(stageName, `could not commit resumed work (${(e as Error).message})`, 'err'));
    return false;
  }
}

/**
 * After a KiCad-touching stage completes, render the current schematic and board
 * to SVG in that stage's run dir (`.copperhead/runs/<id>/artifacts/`) (5.4).
 * Every text/ERC/drift gate can be satisfied by a design that is visibly wrong or
 * even empty, and nothing else in the run ever *looks* at the board; a per-stage
 * render closes that gap cheaply and deterministically, with no extra tokens. It
 * is the natural input for an optional later vision acceptance pass. Best-effort:
 * a render failure is logged, never fatal — the design is already committed.
 */
async function renderStageArtifacts(opts: CreateOptions, stageName: string, transcriptDir: string): Promise<void> {
  if (!KICAD_STAGES.has(stageName) || !transcriptDir) return;
  const config = await loadConfig(opts.repoRoot);
  const targets: Array<{ kind: 'sch' | 'pcb'; file: string }> = [];
  if (config.schematic && existsSync(path.join(opts.repoRoot, config.schematic))) {
    targets.push({ kind: 'sch', file: config.schematic });
  }
  if (config.board && existsSync(path.join(opts.repoRoot, config.board))) {
    targets.push({ kind: 'pcb', file: config.board });
  }
  if (!targets.length) return;
  const artifactsDir = path.join(transcriptDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  let rendered = 0;
  for (const { kind, file } of targets) {
    try {
      await exportSvg(kind, path.join(opts.repoRoot, file), artifactsDir);
      rendered++;
    } catch (e) {
      opts.log(stageLine(stageName, `could not render ${kind} SVG (${(e as Error).message})`, 'warn'));
    }
  }
  if (rendered) {
    opts.log(
      stageLine(
        stageName,
        `rendered ${rendered} SVG artifact(s) into ${path.relative(opts.repoRoot, artifactsDir)}/`,
        'ok',
      ),
    );
  }
}

/**
 * Ask the model, on a fresh tool-less turn, whether a failed stage should be
 * retried and how. Wrapped in the watchdog timeout and hardened to fail safe:
 * any error or hang resolves to "abort" so recovery never itself becomes the
 * thing that hangs the pipeline.
 */
async function diagnose(input: {
  model: string;
  timeoutMs: number;
  stageName: string;
  stageGoal: string;
  failure: string;
  transcriptDir: string;
  attempt: number;
  maxAttempts: number;
  /** Compatible-endpoint settings, so a `compat` run can diagnose itself. */
  compat?: CompatSettings | undefined;
}): Promise<StageDiagnosis> {
  let provider: Provider | undefined;
  try {
    provider = await makeProvider(input.model, false, input.compat);
    const p = provider;
    const excerpt = await transcriptExcerpt(input.transcriptDir);
    return await withTimeout(
      async () => {
        // Fact-check symbol-availability claims before the model judges them: a
        // refusal narrating "library not installed" is adjudicated from the
        // machine's actual libraries, not from the narration (I15/#197). Inside
        // the watchdog, so a wedged filesystem scan cannot outlive timeoutMs.
        const symbolFacts = await symbolAvailabilityFacts(`${input.failure}\n${excerpt}`).catch(() => '');
        return diagnoseStageFailure(p, {
          stageName: input.stageName,
          stageGoal: input.stageGoal,
          failure: input.failure,
          excerpt,
          attempt: input.attempt,
          maxAttempts: input.maxAttempts,
          ...(symbolFacts ? { symbolFacts } : {}),
        });
      },
      input.timeoutMs,
      () => p.close?.(),
    );
  } catch (e) {
    return { verdict: 'abort', reason: `diagnosis unavailable: ${(e as Error).message}` };
  } finally {
    await provider?.close?.();
  }
}

/** One row of the end-of-run per-stage cost summary (5.2). A `resumed` stage was
 *  already complete on entry (skipped past), so it has no cost of its own. */
interface StageCost {
  name: string;
  resumed: boolean;
  wallMs: number;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  cacheHits: number;
}

/** Quote a path/value for a copy-pasteable resume command (5.3). */
function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The single command that resumes this pipeline, reconstructed from the run's
 *  own options so the operator never has to remember the flags (5.3). */
function resumeCommand(opts: CreateOptions): string {
  const parts = ['copperhead'];
  const repo = path.resolve(opts.repoRoot);
  if (repo !== process.cwd()) parts.push('--repo', shellQuote(repo));
  // Absolute --brief so the command resolves the same from any cwd; a relative
  // path would break when resumed from a different directory (F6).
  parts.push('create', '--brief', shellQuote(path.resolve(opts.briefPath)), '--model', shellQuote(opts.model));
  if (opts.interactive) parts.push('--interactive');
  return parts.join(' ');
}

/**
 * On any pipeline stop, print the exact command to resume and which stage it
 * will resume at, so the operator never has to reconstruct it (5.3). Stage
 * completion is inferred from repo state, so resuming is just re-running the
 * same command — the earlier completed stages are skipped automatically.
 */
function logResumePoint(opts: CreateOptions, stage: Stage, index: number): void {
  opts.log('');
  opts.log(
    warn(`⏸  stopped at stage ${index + 1}/${STAGES.length} (${stage.name}). To resume from here, run:`),
  );
  opts.log(copper(`     ${resumeCommand(opts)}`));
  opts.log(
    dim(
      `   (${index} stage(s) already complete are detected from repo state and skipped; it resumes at ${stage.name}.)`,
    ),
  );
}

/**
 * Print the final per-stage cost table (5.2): stage → wall, turns, out-tokens,
 * cache-hit%. Makes the expensive stages obvious at a glance and lets the effect
 * of tuning be tracked across runs. Right-aligned numeric columns; resumed
 * stages show "—" (they cost nothing this run).
 */
function printCostTable(opts: CreateOptions, costs: StageCost[]): void {
  if (!costs.length) return;
  const pct = (hits: number, turns: number): string => (turns ? `${Math.round((hits / turns) * 100)}%` : '—');
  const header = { stage: 'Stage', wall: 'Wall', turns: 'Turns', out: 'Out tok', cache: 'Cache' };
  const rows = costs.map((c) => ({
    stage: c.name,
    wall: c.resumed ? '—' : fmtDuration(c.wallMs),
    turns: c.resumed ? '—' : String(c.turns),
    out: c.resumed ? '—' : fmtTokens(c.tokensOut),
    cache: c.resumed ? '—' : pct(c.cacheHits, c.turns),
  }));
  const ran = costs.filter((c) => !c.resumed);
  const total =
    ran.length &&
    ({
      stage: 'TOTAL',
      wall: fmtDuration(ran.reduce((a, c) => a + c.wallMs, 0)),
      turns: String(ran.reduce((a, c) => a + c.turns, 0)),
      out: fmtTokens(ran.reduce((a, c) => a + c.tokensOut, 0)),
      cache: pct(
        ran.reduce((a, c) => a + c.cacheHits, 0),
        ran.reduce((a, c) => a + c.turns, 0),
      ),
    } as const);
  const all = [header, ...rows, ...(total ? [total] : [])];
  const w = {
    stage: Math.max(...all.map((r) => r.stage.length)),
    wall: Math.max(...all.map((r) => r.wall.length)),
    turns: Math.max(...all.map((r) => r.turns.length)),
    out: Math.max(...all.map((r) => r.out.length)),
    cache: Math.max(...all.map((r) => r.cache.length)),
  };
  const line = (r: typeof header): string =>
    `  ${r.stage.padEnd(w.stage)}  ${r.wall.padStart(w.wall)}  ${r.turns.padStart(w.turns)}  ${r.out.padStart(w.out)}  ${r.cache.padStart(w.cache)}`;
  const rule = `  ${'-'.repeat(w.stage)}  ${'-'.repeat(w.wall)}  ${'-'.repeat(w.turns)}  ${'-'.repeat(w.out)}  ${'-'.repeat(w.cache)}`;
  opts.log('');
  opts.log(copper('Per-stage cost summary'));
  opts.log(dim(line(header)));
  opts.log(dim(rule));
  for (const r of rows) opts.log(line(r));
  if (total) {
    opts.log(dim(rule));
    opts.log(boldTotal(line(total)));
  }
}

function boldTotal(s: string): string {
  // TOTAL row: keep digits readable, accent only the label when color is on.
  return s.replace(/^(\s*)TOTAL/, (_, sp: string) => `${sp}${copper('TOTAL')}`);
}

/** Sum the cost of the stages that actually ran this invocation (resumed stages
 *  cost nothing). Shared by the cumulative line and the end-of-run report (5.6). */
function ranTotals(stageCosts: StageCost[]): {
  wallMs: number;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  cacheHits: number;
} {
  const ran = stageCosts.filter((c) => !c.resumed);
  return {
    wallMs: ran.reduce((a, c) => a + c.wallMs, 0),
    turns: ran.reduce((a, c) => a + c.turns, 0),
    tokensIn: ran.reduce((a, c) => a + c.tokensIn, 0),
    tokensOut: ran.reduce((a, c) => a + c.tokensOut, 0),
    cacheHits: ran.reduce((a, c) => a + c.cacheHits, 0),
  };
}

const cachePct = (hits: number, turns: number): number => (turns ? Math.round((hits / turns) * 100) : 0);

/**
 * The running whole-run total, printed at each stage's end (5.6). A create board
 * is built over many invocations and each stage's `summary.md` covers only that
 * stage; this line accrues the pipeline total so the operator sees the true cost
 * grow instead of adding up per-stage numbers by hand. On the last stage it is
 * the grand total.
 */
function logCumulative(opts: CreateOptions, stageCosts: StageCost[]): void {
  const t = ranTotals(stageCosts);
  if (!t.turns && !t.wallMs) return; // nothing has actually run yet (all resumed)
  opts.log(
    dim(
      `pipeline so far: ${stageCosts.length}/${STAGES.length} stages · ${fmtDuration(t.wallMs)} · ` +
        `${fmtTokens(t.tokensOut)} out tokens · ${cachePct(t.cacheHits, t.turns)}% cache hits`,
    ),
  );
}

/**
 * Aggregate the per-stage costs into a durable end-of-run report (5.6):
 * `.copperhead/runs/REPORT.md` (human) and `report.json` (machine, stable schema
 * for diffing successive boards). One row per stage — wall, turns, in/out tokens,
 * cache-hit%, status — plus a total row and a slowest / most-expensive callout so
 * the bottleneck is obvious. This is the only artifact that makes the big token
 * levers measurable *across* runs; without it, tuning is anecdote. Best-effort:
 * a write failure is logged, never fatal.
 */
async function writeRunReport(opts: CreateOptions, stageCosts: StageCost[]): Promise<void> {
  if (!stageCosts.length) return;
  const runsDir = path.join(opts.repoRoot, '.copperhead', 'runs');
  const t = ranTotals(stageCosts);
  const ran = stageCosts.filter((c) => !c.resumed);
  const slowest = ran.length ? ran.reduce((a, b) => (b.wallMs > a.wallMs ? b : a)) : null;
  const priciest = ran.length ? ran.reduce((a, b) => (b.tokensOut > a.tokensOut ? b : a)) : null;

  const report = {
    generatedAtMs: Date.now(),
    stageCount: STAGES.length,
    ran: ran.length,
    resumed: stageCosts.length - ran.length,
    stages: stageCosts.map((c) => ({
      name: c.name,
      resumed: c.resumed,
      wallMs: c.wallMs,
      turns: c.turns,
      tokensIn: c.tokensIn,
      tokensOut: c.tokensOut,
      cacheHits: c.cacheHits,
      cacheHitPct: c.resumed ? null : cachePct(c.cacheHits, c.turns),
    })),
    total: { ...t, cacheHitPct: cachePct(t.cacheHits, t.turns) },
    slowestStage: slowest ? { name: slowest.name, wallMs: slowest.wallMs } : null,
    mostExpensiveStage: priciest ? { name: priciest.name, tokensOut: priciest.tokensOut } : null,
  };

  const row = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  const lines = [
    '# Copperhead run report',
    '',
    'Per-stage cost of the create pipeline, regenerated at the end of every run.',
    'Resumed stages were already complete on entry and cost nothing this run.',
    '',
    row(['Stage', 'Wall', 'Turns', 'In', 'Out', 'Cache', 'Status']),
    row(['---', '---:', '---:', '---:', '---:', '---:', '---']),
    ...stageCosts.map((c) =>
      c.resumed
        ? row([c.name, '—', '—', '—', '—', '—', 'resumed'])
        : row([
            c.name,
            fmtDuration(c.wallMs),
            String(c.turns),
            fmtTokens(c.tokensIn),
            fmtTokens(c.tokensOut),
            `${cachePct(c.cacheHits, c.turns)}%`,
            'ran',
          ]),
    ),
    row([
      '**Total**',
      fmtDuration(t.wallMs),
      String(t.turns),
      fmtTokens(t.tokensIn),
      fmtTokens(t.tokensOut),
      `${cachePct(t.cacheHits, t.turns)}%`,
      '',
    ]),
    '',
  ];
  if (slowest && priciest) {
    lines.push(
      `Slowest stage: **${slowest.name}** (${fmtDuration(slowest.wallMs)}). ` +
        `Most expensive: **${priciest.name}** (${fmtTokens(priciest.tokensOut)} out tokens).`,
      '',
    );
  }

  try {
    await mkdir(runsDir, { recursive: true });
    await writeFile(path.join(runsDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    await writeFile(path.join(runsDir, 'REPORT.md'), lines.join('\n'), 'utf8');
    opts.log(`wrote run report: ${path.relative(opts.repoRoot, path.join(runsDir, 'REPORT.md'))} (+ report.json)`);
  } catch (err) {
    opts.log(`warning: could not write run report (${(err as Error).message})`);
  }
}

export async function runCreate(opts: CreateOptions): Promise<{ ok: boolean; completed: string[] }> {
  const brief = await readFile(path.resolve(opts.briefPath), 'utf8');
  // Hashed from the content already in hand: a brief edited mid-pipeline shows
  // up as a different sha256 in the next stage's metadata (AC-8.1).
  const resolvedBrief = path.resolve(opts.briefPath);
  const relativeBrief = path.relative(opts.repoRoot, resolvedBrief);
  const briefPath =
    relativeBrief.startsWith('..') || path.isAbsolute(relativeBrief)
      ? `external:${path.basename(resolvedBrief)}`
      : relativeBrief;
  const briefMeta = {
    path: briefPath,
    sha256: createHash('sha256').update(brief).digest('hex'),
  };
  const config = await loadConfig(opts.repoRoot);
  // Fail fast on a nearly-full disk (4.1): a create run writes fab outputs and
  // KiCad local history and can otherwise fill the disk mid-stage, failing with
  // an opaque ENOSPC only after doing expensive work. Threshold overridable via
  // COPPERHEAD_MIN_FREE_MB; an unknown reading (unsupported platform) skips it.
  const minFreeMb = Number(process.env.COPPERHEAD_MIN_FREE_MB);
  const minFree = Number.isFinite(minFreeMb) && minFreeMb >= 0 ? minFreeMb * 1024 * 1024 : DEFAULT_MIN_FREE_BYTES;
  await assertDiskSpace(opts.repoRoot, minFree);
  // Reclaim scratch dirs leaked by earlier runs whose cleanup was skipped (a
  // watchdog SIGKILL or hard abort bypasses the per-call `finally`). Age-gated,
  // so a concurrent run's fresh dirs are never touched; best-effort, so it never
  // blocks a run (I8).
  const swept = await sweepStaleTempDirs(Date.now());
  if (swept.length) opts.log(dim(`startup: reclaimed ${swept.length} stale temp dir(s) from earlier runs`));
  // Cap the gitignored .history/ so KiCad local history cannot grow unbounded
  // across a long run and fill the disk (4.1, I8). Best-effort; keeps the newest.
  const pruned = await pruneHistoryDir(opts.repoRoot);
  if (pruned) opts.log(dim(`startup: pruned ${pruned} old .history/ entrie(s) to cap local-history growth`));
  const initialized = await openspecInit(opts.repoRoot);
  if (!initialized.ok) {
    opts.log(`OpenSpec initialization failed:\n${initialized.output}`);
    return { ok: false, completed: [] };
  }
  // Stamp the repo create-produced before any stage runs: the marker scopes the
  // legibility finish gate and the fab release gate, and it must hold on
  // resumed runs whose project predates the marker (bootstrapKicadProject
  // no-ops on those, so it cannot be the only writer).
  await markCreateOrigin(opts.repoRoot);
  const completed: string[] = [];
  const stageCosts: StageCost[] = [];

  for (const [i, stage] of STAGES.entries()) {
    // The schematic stage is the first to touch KiCad files, but the agent
    // cannot create them (write_file refuses KiCad files; edit_file needs an
    // existing file). Scaffold a minimal empty project and wire config just
    // before the stage runs, so there is a schematic to populate and the stage
    // contract can eventually be met. No-op once a project exists.
    if (stage.name === 'schematic') {
      // A footprint that is not installed stops the run for the user (#314):
      // no model turn can install a library, and a substitute package is
      // exactly the surrogate geometry this gate exists to keep off the board.
      // It runs before the scaffold, so the stop writes no KiCad file
      // (AC-15.32); a stage already complete is resumed past as before.
      const stop = await bomFootprintStop(opts.repoRoot, config);
      if (stop && !(await stage.isComplete(opts.repoRoot, config.docs))) {
        opts.log(stageLine(stage.name, `create stopped: ${stop}`, 'err'));
        logResumePoint(opts, stage, i);
        printCostTable(opts, stageCosts);
        await writeRunReport(opts, stageCosts);
        return { ok: false, completed };
      }
      const created = await bootstrapKicadProject(opts.repoRoot, brief);
      if (created) {
        opts.log(stageLine('schematic', `scaffolded empty KiCad project (${created} + board + project), wired into config`));
      }
    }
    if (await stage.isComplete(opts.repoRoot, config.docs)) {
      if (!(await commitResumedStage(opts, config, stage.name))) {
        // There is no snapshot for a resumed stage. Leave its work in place
        // and stop before a later stage can commit or roll it back.
        logResumePoint(opts, stage, i);
        printCostTable(opts, stageCosts);
        await writeRunReport(opts, stageCosts);
        return { ok: false, completed };
      }
      opts.log(stageLine(stage.name, 'already complete (resuming past it)', 'ok'));
      completed.push(stage.name);
      if (stage.name === 'spec-seed') {
        try {
          await writeBriefHash(opts.repoRoot, config.docs, briefMeta);
        } catch (err) {
          opts.log(
            `warning: could not record brief provenance (${(err as Error).message})`,
          );
        }
      }
      stageCosts.push({ name: stage.name, resumed: true, wallMs: 0, turns: 0, tokensIn: 0, tokensOut: 0, cacheHits: 0 });
      await emitJlcpcbAfterOutputs(stage.name, opts);
      continue;
    }
    // Auto-recovery loop: run the stage, and if it fails or ends without meeting
    // its contract, ask the model to diagnose whether another attempt is likely
    // to help. On "retry" the pipeline runs the stage again (with the diagnosis's
    // guidance prepended); on "abort", or once the retry budget is spent, it
    // stops and reports for a human — the loop keeps going by itself for the
    // recoverable cases without silently spinning on the dead-end ones.
    const stageTurns = config.stageMaxTurns?.[stage.name];
    const basePrompt = stage.prompt(brief, config.docs);
    let guidance = '';
    let stageDone = false;
    let stageTranscriptDir = '';
    // Cost accumulates across all attempts of the stage, so a stage that took a
    // retry to complete shows its true total in the summary (5.2).
    const stageStart = Date.now();
    const cost: StageCost = { name: stage.name, resumed: false, wallMs: 0, turns: 0, tokensIn: 0, tokensOut: 0, cacheHits: 0 };
    // Layout-draft writes the board before the agent runs (populate), outside
    // the run's own snapshot, so the stage keeps the pre-stage board itself:
    // every attempt starts from it, and a stage that does not complete (a
    // stop, an abort, exhausted retries, a thrown error) puts back the last
    // verified board, so no unverified board mutation outlives the stage
    // (AC-15.43). That is the pre-stage board, or the board an attempt
    // committed: a commit means that attempt's DRC passed, and putting the
    // older board back over it would leave the tree reverting HEAD.
    const layoutBoard = stage.name === 'layout-draft' ? (await loadConfig(opts.repoRoot)).board : undefined;
    const boardBefore = layoutBoard ? await readFile(path.join(opts.repoRoot, layoutBoard), 'utf8').catch(() => null) : null;
    const headBefore = layoutBoard ? await headCommit(opts.repoRoot).catch(() => null) : null;
    const restoreBoard = async (): Promise<void> => {
      if (layoutBoard && boardBefore !== null) await writeFile(path.join(opts.repoRoot, layoutBoard), boardBefore, 'utf8');
    };
    const restoreVerifiedBoard = async (): Promise<void> => {
      if (!layoutBoard) return;
      const head = await headCommit(opts.repoRoot).catch(() => null);
      const committed = head && head !== headBefore ? await fileAtCommit(opts.repoRoot, head, layoutBoard) : null;
      if (committed !== null) await writeFile(path.join(opts.repoRoot, layoutBoard), committed, 'utf8');
      else await restoreBoard();
    };
    try {
      for (let attempt = 1; ; attempt++) {
        // Re-scaffold before every attempt, not just once per stage. A previous
        // attempt that failed at the commit gate rolls the tree back
        // (restore(): `git reset --hard` + `git clean -fd`), which deletes the
        // still-untracked scaffold (config.json + the empty KiCad files). Without
        // this the retry would run against a missing schematic and cascade into a
        // worse failure than the one being recovered from. Idempotent: a no-op
        // whenever the project already exists.
        if (stage.name === 'schematic') {
          const rescaffolded = await bootstrapKicadProject(opts.repoRoot, brief);
          if (rescaffolded && attempt > 1) {
            opts.log(stageLine('schematic', 're-scaffolded empty KiCad project after rollback, wired into config'));
          }
        }
        if (stage.name === 'layout-draft') {
          // A retry starts from the last verified board (#327): the board an
          // earlier attempt committed when it still matches the schematic, so a
          // DRC-clean placement is not redone over a documentation gap; else the
          // pre-stage board, since the failed attempt may have left footprints
          // populate would refuse to touch. Populate is idempotent on a
          // populated board, so it only re-checks the committed one.
          if (attempt > 1) {
            await restoreVerifiedBoard();
            if (!(await boardMatchesSchematic(opts.repoRoot, await loadConfig(opts.repoRoot))).ok) await restoreBoard();
          }
          const populate = await populateStop(opts);
          if (populate) {
            opts.log(stageLine(stage.name, `create stopped: ${populate}`, 'err'));
            break;
          }
        }
        opts.log(
          stageLine(
            stage.name,
            `running${attempt > 1 ? ` (attempt ${attempt}/${config.maxStageRetries + 1})` : ''}`,
          ),
        );
        // The BOM freezes before this stage, so every part's real pins are
        // computable before the first turn — recomputed per attempt, since a
        // rolled-back retry can run against a different BOM than its
        // predecessor. Advisory only: any failure degrades to no block.
        let dossierBlock = '';
        if (stage.name === 'schematic') {
          try {
            const bomPath = path.join(opts.repoRoot, config.docs, 'BOM.md');
            if (existsSync(bomPath)) {
              // Bounded: a slow or wedged library scan must delay the stage by a
              // fixed cost at most — on timeout the stage simply runs dossier-less.
              const dossier = await withTimeout(
                async () => bomSymbolDossier(await readFile(bomPath, 'utf8'), await symbolSearchDirs()),
                60_000,
              );
              if (dossier) {
                dossierBlock =
                  '\n\n## Installed-symbol pin dossier (machine-verified)\nEach BOM part resolved against the KiCad libraries installed on THIS machine: the top name-match lib_id and its REAL pins (number=name/electrical-type). Confirm the match fits the BOM part; alternatives are listed. Passives (R/C/L) draw from their canonical Device symbols and are omitted. Use these pins for REF.PIN endpoints instead of reading .kicad_sym files; for any part not listed, call symbol_pins.\n' +
                  dossier;
              }
            }
          } catch {
            // the dossier is context, never a gate — the stage runs without it
          }
        }
        const res = await runAgentLoop({
          repoRoot: opts.repoRoot,
          model: opts.model,
          request: `create pipeline stage: ${stage.name}`,
          stagePrompt: guidance
            ? `${basePrompt}${dossierBlock}\n\n## Recovery guidance (a previous attempt did not complete this stage — do this differently)\n${guidance}`
            : `${basePrompt}${dossierBlock}`,
          interactive: opts.interactive ?? false,
          allowDirty: true, // stages build on each other's uncommitted state within the pipeline
          // the populated board is this stage's mutation too: finish needs a
          // passing DRC on it even when the agent never edits the board
          ...(layoutBoard ? { preTouched: [layoutBoard] } : {}),
          // #310: in layout-draft, finish checks the stage's own contract, so the agent
          // hears what is missing while its board still exists, not after the rollback.
          // Other stages keep ending at the post-run check: their gaps have no specific
          // message yet, and a generic one would only spend turns.
          ...(stage.name === 'layout-draft'
            ? {
                stageGate: async () =>
                  (await stage.isComplete(opts.repoRoot, config.docs)) ? null : contractGapDetail(stage.name, opts.repoRoot, config),
              }
            : {}),
          ...(stageTurns !== undefined ? { maxTurns: stageTurns } : {}),
          ...(opts.onBudgetExhausted ? { onBudgetExhausted: opts.onBudgetExhausted } : {}),
          log: opts.log,
          ...(opts.renderer ? { renderer: opts.renderer } : {}),
          meta: {
            ...opts.meta,
            command: 'create',
            stage: { name: stage.name, index: i + 1, total: STAGES.length },
            brief: briefMeta,
          },
        });

        // Fold this attempt's cost in. Defensive reads: a run that dies very early
        // (or a scripted test double) may omit stats — never let telemetry throw.
        cost.turns += res.stats?.turnsUsed ?? 0;
        cost.tokensIn += res.stats?.tokensIn ?? 0;
        cost.tokensOut += res.stats?.tokensOut ?? 0;
        cost.cacheHits += res.cacheHits ?? 0;
        stageTranscriptDir = res.transcriptDir; // last attempt's run dir (for SVG artifacts / report)

        // A successful run is not the same as a completed stage: an agent can
        // finish "done" with all gates green having only planned the work (seen
        // with the schematic stage: one header edit, ERC "clean" on an empty
        // sheet). Advancing anyway lets every later stage run against a design
        // that isn't there, so the completion contract is the real gate.
        // The run's own reason rides along: the diagnosis transcript excerpt holds
        // only assistant text and tool results, so without it a hung call or a turn
        // stopped at the hard cap reaches the diagnosis as a bare "provider-error".
        const failure =
          res.outcome !== 'success'
            ? `the run ended as "${res.outcome}" (${res.exitPath})${res.summary ? `: ${res.summary}` : ''}`
            : !(await stage.isComplete(opts.repoRoot, config.docs))
              ? await contractGapDetail(stage.name, opts.repoRoot, config)
              : null;
        if (!failure) {
          stageDone = true;
          break;
        }

        if (attempt > config.maxStageRetries) {
          opts.log(
            stageLine(
              stage.name,
              `${failure}; exhausted ${config.maxStageRetries} auto-retry(ies). Stopping for a human.`,
              'err',
            ),
          );
          break;
        }

        opts.log(stageLine(stage.name, `${failure}; asking the model whether to retry…`, 'warn'));
        const diagnosis = await diagnose({
          model: opts.model,
          timeoutMs: config.turnTimeoutMs,
          compat: resolveCompatSettings(config),
          stageName: stage.name,
          stageGoal: basePrompt,
          failure,
          transcriptDir: res.transcriptDir,
          attempt,
          maxAttempts: config.maxStageRetries + 1,
        });
        // Fold the diagnosis call's own tokens into the stage cost (F6): it is a
        // real model call made on behalf of this stage, so the cost table should
        // not under-report by omitting it.
        cost.tokensIn += diagnosis.usage?.inputTokens ?? 0;
        cost.tokensOut += diagnosis.usage?.outputTokens ?? 0;
        opts.log(
          stageLine(
            stage.name,
            `diagnosis → ${diagnosis.verdict} — ${diagnosis.reason}`,
            diagnosis.verdict === 'abort' ? 'err' : 'warn',
          ),
        );
        if (diagnosis.verdict === 'abort') {
          opts.log(stageLine(stage.name, 'recovery supervisor recommends stopping for a human.', 'err'));
          break;
        }
        guidance = diagnosis.guidance ?? `The previous attempt failed: ${failure}. ${diagnosis.reason}`;
      }
    } finally {
      if (!stageDone) await restoreVerifiedBoard();
    }

    cost.wallMs = Date.now() - stageStart;
    stageCosts.push(cost);

    if (!stageDone) {
      logResumePoint(opts, stage, i);
      printCostTable(opts, stageCosts);
      await writeRunReport(opts, stageCosts);
      return { ok: false, completed };
    }
    completed.push(stage.name);
    if (stage.name === 'spec-seed') {
      try {
        await writeBriefHash(opts.repoRoot, config.docs, briefMeta);
      } catch (err) {
        opts.log(
          `warning: could not record brief provenance (${(err as Error).message})`,
        );
      }
    }
    await renderStageArtifacts(opts, stage.name, stageTranscriptDir);
    await emitJlcpcbAfterOutputs(stage.name, opts);
    logCumulative(opts, stageCosts);
  }

  const check = await runCheck(opts.repoRoot, opts.log);
  opts.log(
    check.ok
      ? ok('create pipeline complete; all checks green')
      : warn('create pipeline complete with check failures'),
  );
  printCostTable(opts, stageCosts);
  await writeRunReport(opts, stageCosts);
  return { ok: check.ok, completed };
}
