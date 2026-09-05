import path from 'node:path';
import { writeFile, mkdir, appendFile, readFile } from 'node:fs/promises';
import type { ToolSchema } from './types.js';
import { toolReadFile, toolWriteFile, toolEditFile, toolSearch } from './filetools.js';
import { resolveInRepo, isKicadFile } from '../util/paths.js';
import { runErc, runDrc, exportSvg, exportFab, kicadLoadError, isProbeableKicadFile } from '../kicad/cli.js';
import { formatViolations, type CheckReport } from '../kicad/report.js';
import { listSymbols, listNets } from '../kicad/sexp.js';
import { checkLegibility, formatLegibility } from '../kicad/legibility.js';
import { scoreSchematic, formatScore } from '../kicad/score.js';
import { draftSchematic, defaultIntentPath, formatSchematicDraftReport } from '../kicad/draft/draft.js';
import { verifySchematicSymbols, searchInstalledSymbols, symbolSearchDirs, resolveLibrarySymbol, comparePinNumbers } from '../kicad/symlib.js';
import { checkDrift } from '../memory/drift.js';
import { saveConstraint, classifyAffectsTarget, affectsTargetExists } from '../memory/constraints.js';
import { openspecValidate } from '../openspec/cli.js';
import { existsSync } from 'node:fs';
import type { CopperheadConfig } from '../config.js';
import { isEngineAuthoredSchematic } from '../kicad/fab.js';
import { ObligationsLedger } from './ledger.js';
import type { Transcript } from './transcript.js';

export interface FinishRequest {
  outcome: 'done' | 'refuse';
  summary: string;
}

/** Mutable state one run threads through every tool call. */
export interface RunContext {
  repoRoot: string;
  config: CopperheadConfig;
  transcript: Transcript;
  ledger: ObligationsLedger;
  runId: string;
  interactive: boolean;
  confirm: (question: string) => Promise<boolean>;
  editsUnlocked: boolean;
  changeId: string | null;
  proposalValidated: boolean;
  filesTouched: Set<string>;
  decisions: string[];
  lastErc: CheckReport | null;
  lastDrc: CheckReport | null;
  /** Last check_legibility counts; feeds the run summary's verification section. */
  lastLegibility: { error: number; advisory: number } | null;
  /** Last score composite (AC-16.21); recorded in the run summary. */
  lastScore: number | null;
  repairCycles: number;
  finishRequest: FinishRequest | null;
}

export interface ToolDef {
  schema: ToolSchema;
  /** Edit-tier tools are absent from the tool list until the proposal validates. */
  requiresUnlock: boolean;
  handler: (ctx: RunContext, args: Record<string, unknown>) => Promise<string>;
}

const str = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  if (typeof v !== 'string' || v === '') throw new Error(`missing required string arg "${key}"`);
  return v;
};

/**
 * Coerce a `read_file` line bound to a finite number, or `undefined` when it is
 * absent or cannot be one. Tool args arrive straight from `JSON.parse` of model
 * output with no schema coercion, so a stringified `"4"` is ordinary input; it
 * coerces to a partial read here, matching what `toolReadFile` already does with
 * `Math.max`/`Math.min`. Garbage (`"abc"`, `null`) drops the bound. Normalizing
 * once, then writing the result back into the call's args, keeps the history's
 * record of the call in step with what the tool actually did — history.ts's
 * `rangeOf` then only ever sees a finite number or an absent bound, so it cannot
 * model a partial read as a whole-file one and wrongly supersede real content.
 */
const lineBound = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// U+FFFD (the Unicode replacement character) is what a byte sequence becomes
// when UTF-8 decoding fails — most often a multibyte glyph (Ω, µ, ±, °) split
// across a streaming chunk boundary and decoded per-chunk upstream in the
// provider SDK (I2). It never appears in a legitimately authored PCB doc, so
// its presence in a content-bearing tool arg means the value arrived corrupted.
// Reject the call before it lands on disk so the model re-emits; the corruption
// is nondeterministic (it depends on where a chunk boundary fell), so the retry
// almost always comes through clean — far cheaper than shipping a mangled value
// like "5.1kΩ" → "5.1k�" into DECISIONS.md and only noticing on review.
const REPLACEMENT_CHAR = '�';
export function corruptionError(fields: Record<string, unknown>): string | null {
  const bad = Object.entries(fields)
    .filter(([, v]) => typeof v === 'string' && v.includes(REPLACEMENT_CHAR))
    .map(([k]) => k);
  if (!bad.length) return null;
  return `rejected: the ${bad.join(', ')} value contains U+FFFD (�), the replacement character that signals a UTF-8 decoding error — a special character (e.g. Ω, µ, ±, °) was likely mangled in transit. Re-send this exact call with the intended character written correctly, or spell it in ASCII (e.g. "ohm", "uF", "+/-", "deg").`;
}

function markTouched(ctx: RunContext, rel: string): void {
  ctx.filesTouched.add(rel);
  if (isKicadFile(rel)) {
    ctx.ledger.onKicadEdit(rel);
    if (rel.endsWith('.kicad_sch')) ctx.lastErc = null;
    if (rel.endsWith('.kicad_pcb')) ctx.lastDrc = null;
  } else if (rel.endsWith('.md')) {
    ctx.ledger.onDocEdit(rel);
  }
}

export const TOOLS: ToolDef[] = [
  {
    schema: {
      name: 'read_file',
      description: 'Read a repo-relative file, optionally a line range. Returns text (line-numbered when ranged).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'number' },
          end_line: { type: 'number' },
        },
        required: ['path'],
      },
    },
    requiresUnlock: false,
    handler: (ctx, args) => {
      // Normalize the line bounds in place, so the conversation records the
      // range the read actually used and history.ts sees only well-formed
      // numbers. Delete a dropped bound rather than leave a non-numeric value
      // behind for a later reader to misinterpret.
      const start = lineBound(args.start_line);
      const end = lineBound(args.end_line);
      if (start === undefined) delete args.start_line;
      else args.start_line = start;
      if (end === undefined) delete args.end_line;
      else args.end_line = end;
      return toolReadFile(ctx.repoRoot, str(args, 'path'), start, end);
    },
  },
  {
    schema: {
      name: 'search',
      description: 'Regex search over the repo (ripgrep-style). Optional glob filter, e.g. "**/*.kicad_sch".',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' }, glob: { type: 'string' } },
        required: ['pattern'],
      },
    },
    requiresUnlock: false,
    handler: async (ctx, args) => {
      const pattern = args.pattern;
      if (typeof pattern !== 'string' || pattern.trim() === '') {
        return 'error: search requires a non-empty regex in "pattern" (narrow by file with "glob", e.g. {"pattern": "GPIO", "glob": "**/*.md"}); to list files, use a broad pattern like "." with a glob';
      }
      const matches = await toolSearch(ctx.repoRoot, pattern, args.glob as string | undefined);
      if (!matches.length) return 'no matches';
      return matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join('\n');
    },
  },
  {
    schema: {
      name: 'list_symbols',
      description: 'List schematic symbols: ref, value, footprint, sheet.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    requiresUnlock: false,
    handler: async (ctx) => {
      if (!ctx.config.schematic) return 'no schematic configured';
      const syms = await listSymbols(path.join(ctx.repoRoot, ctx.config.schematic));
      return JSON.stringify(syms.map(({ ref, value, footprint, sheet }) => ({ ref, value, footprint, sheet })), null, 2);
    },
  },
  {
    schema: {
      name: 'list_nets',
      description: 'List net names found in the schematic.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    requiresUnlock: false,
    handler: async (ctx) => {
      if (!ctx.config.schematic) return 'no schematic configured';
      return JSON.stringify(await listNets(path.join(ctx.repoRoot, ctx.config.schematic)));
    },
  },
  {
    schema: {
      name: 'propose_change',
      description:
        'Write the OpenSpec change proposal for this run (the plan step). Must be called and validated before edit tools unlock.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'kebab-case change id' },
          why: { type: 'string' },
          what_changes: { type: 'string', description: 'markdown bullet list of changes' },
          tasks: { type: 'string', description: 'markdown checklist of implementation steps' },
        },
        required: ['id', 'why', 'what_changes', 'tasks'],
      },
    },
    requiresUnlock: false,
    handler: async (ctx, args) => {
      const id = str(args, 'id');
      const dir = resolveInRepo(ctx.repoRoot, path.join('openspec', 'changes', id));
      await mkdir(dir, { recursive: true });
      const auto = ctx.interactive ? '' : '\n> Marker: AUTO (autonomous mode; auto-approved, reviewable after the fact)\n';
      await writeFile(
        path.join(dir, 'proposal.md'),
        `# Proposal: ${id}\n${auto}\n## Why\n\n${str(args, 'why')}\n\n## What Changes\n\n${str(args, 'what_changes')}\n`,
        'utf8',
      );
      await writeFile(path.join(dir, 'tasks.md'), `# Tasks\n\n${str(args, 'tasks')}\n`, 'utf8');
      ctx.changeId = id;
      return `proposal written to openspec/changes/${id}/ — now call validate_change`;
    },
  },
  {
    schema: {
      name: 'validate_change',
      description: 'Validate the current change proposal; on success the edit tools unlock.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    requiresUnlock: false,
    handler: async (ctx) => {
      if (!ctx.changeId) return 'no proposal yet: call propose_change first';
      let ok: boolean;
      let detail: string;
      if (existsSync(path.join(ctx.repoRoot, 'openspec', 'config.yaml'))) {
        const res = await openspecValidate(ctx.repoRoot, ctx.changeId);
        ok = res.ok;
        detail = res.output;
      } else {
        // No OpenSpec workspace in the target repo: structural validation of the
        // proposal files themselves (the invariant is the gate, not the CLI).
        const dir = path.join(ctx.repoRoot, 'openspec', 'changes', ctx.changeId);
        ok = existsSync(path.join(dir, 'proposal.md')) && existsSync(path.join(dir, 'tasks.md'));
        detail = ok ? 'structural validation passed (no openspec workspace)' : 'proposal files missing';
      }
      if (!ok) return `validation FAILED:\n${detail}`;
      ctx.proposalValidated = true;
      if (ctx.interactive) {
        const approved = await ctx.confirm(`Proposal ${ctx.changeId} validated. Unlock edit tools and proceed?`);
        if (!approved) return 'proposal validated but human declined; edits remain locked';
      }
      ctx.editsUnlocked = true;
      await ctx.transcript.event('edit-tools-unlocked', { changeId: ctx.changeId });
      return `validation passed; edit tools are now unlocked`;
    },
  },
  {
    schema: {
      name: 'edit_file',
      description:
        'Exact-match anchored replace in an existing file. Requires a validated change proposal first (call propose_change then validate_change to unlock edits; both may be in the same reply, before this call). The anchor must be unique; widen it with surrounding lines if not. For renames, pass replace_all: true to replace every occurrence in one call.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    requiresUnlock: true,
    handler: async (ctx, args) => {
      const corrupt = corruptionError({ new_string: args.new_string });
      if (corrupt) return corrupt;
      const rel = str(args, 'path');
      const abs = resolveInRepo(ctx.repoRoot, rel);
      // Engine-drafted sheets are regenerated wholesale from the IR: a hand
      // edit would be destroyed by the next re-draft and would break the
      // byte-identical staleness check. Geometry repairs go through the IR
      // (design D5). Hand-drawn schematics never carry the draft generator
      // marker, so `do` on existing repos is untouched by this guard.
      if (rel.endsWith('.kicad_sch') && existsSync(abs)) {
        const head = (await readFile(abs, 'utf8')).slice(0, 400);
        if (isEngineAuthoredSchematic(head)) {
          return `refused: ${rel} is engine-drafted from ${defaultIntentPath(rel)}. Revise the intent (edit_file on the intent JSON) and call draft_schematic to regenerate the sheet; direct geometry edits would be lost on the next re-draft.`;
        }
      }
      // Text edits can corrupt an s-expression file in ways the editor cannot
      // see; a corrupted file then fails every later ERC/DRC with an opaque
      // error. Validate loadability with KiCad itself and roll the edit back
      // rather than letting the file drift unusable. Only schematics and
      // boards are probeable; .kicad_pro/.kicad_sym/.kicad_mod edits must not
      // be probed (a sch/pcb probe rejects them wholesale).
      const before = isProbeableKicadFile(rel) ? await readFile(abs, 'utf8') : null;
      const res = await toolEditFile(
        ctx.repoRoot,
        rel,
        str(args, 'old_string'),
        args.new_string as string,
        args.replace_all === true,
      );
      if (before !== null) {
        const loadErr = await kicadLoadError(abs);
        if (loadErr) {
          const after = await readFile(abs, 'utf8');
          await writeFile(abs, before, 'utf8');
          if (await kicadLoadError(abs)) {
            // The file was already unloadable before this edit. Reverting
            // would deadlock incremental repair (every partial fix undone
            // unless one edit fixes the whole file), so keep the edit and
            // keep the pressure on with the probe output.
            await writeFile(abs, after, 'utf8');
            markTouched(ctx, rel);
            return `${res}\nnote: ${rel} was already unloadable before this edit, so the edit is KEPT. Keep repairing until it loads. kicad-cli says:\n${loadErr}`;
          }
          return `edit REVERTED: it would make ${rel} unloadable in KiCad. kicad-cli says:\n${loadErr}\nRe-read the surrounding file text and make a smaller, syntactically complete edit.`;
        }
      }
      markTouched(ctx, rel);
      return res;
    },
  },
  {
    schema: {
      name: 'write_file',
      description:
        'Create a new file (docs, outputs). Requires a validated change proposal first (propose_change then validate_change to unlock edits). Refuses to overwrite anything or to create KiCad files.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
    requiresUnlock: true,
    handler: async (ctx, args) => {
      const corrupt = corruptionError({ content: args.content });
      if (corrupt) return corrupt;
      const rel = str(args, 'path');
      const res = await toolWriteFile(ctx.repoRoot, rel, args.content as string);
      markTouched(ctx, rel);
      return res;
    },
  },
  {
    schema: {
      name: 'run_erc',
      description: 'Run kicad-cli ERC on the schematic. Clears the ERC obligation when clean.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    requiresUnlock: false,
    handler: async (ctx) => {
      if (!ctx.config.schematic)
        return 'no schematic configured; ERC does not apply yet — skip it until a schematic exists and is set in .copperhead/config.json';
      const schPath = path.join(ctx.repoRoot, ctx.config.schematic);
      const report = await runErc(schPath);
      ctx.lastErc = report;
      if (report.ok) ctx.ledger.clear('erc');
      else ctx.repairCycles++;
      const out = formatViolations(report);
      // A zero-symbol schematic passes ERC with 0 violations — a false green
      // (3.2) that lets a premature finish look verified (an empty sheet also
      // passes drift). The stage contract already requires symbols>0, but a bare
      // "ERC clean" on the empty starting sheet still misleads the model, so warn
      // here too: no gate should read as satisfied by the empty starting state.
      if (report.ok && !(await listSymbols(schPath)).length) {
        return `${out}\nwarning: ERC is clean but the schematic has ZERO symbols — an empty sheet always passes ERC, so this is NOT a verified design. Capture the parts from BOM.md (and re-run run_erc) before calling finish.`;
      }
      return out;
    },
  },
  {
    schema: {
      name: 'search_symbols',
      description:
        'Search EVERY installed KiCad symbol library for a part or symbol name; returns matching lib_ids as Lib:Name, exact matches first. Library nicknames rarely follow from the part number (TPS61165DBV is in Driver_LED, AudioJack3 in Connector_Audio, INA226 in Sensor_Energy), so a failed single-library probe proves nothing about availability — use this before concluding a part has no symbol, and before committing any active part to the BOM: a part is only drawable if its symbol appears here.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'part or symbol name, e.g. "TLV320AIC3204" or "AudioJack3"' },
        },
        required: ['query'],
      },
    },
    requiresUnlock: false,
    handler: async (_ctx, args) => {
      const query = str(args, 'query');
      const dirs = await symbolSearchDirs();
      if (!dirs.length) return 'no installed KiCad symbol library directories found on this machine';
      const hits = await searchInstalledSymbols(query, dirs);
      if (!hits.length) {
        return `no installed symbol matches "${query}" (searched every library in: ${dirs.join(', ')}). The part is not capturable on this machine as named — choose a part whose symbol exists, or a same-family variant that does.`;
      }
      return `installed symbols matching "${query}":\n${hits.map((h) => `  - ${h}`).join('\n')}`;
    },
  },
  {
    schema: {
      name: 'symbol_pins',
      description:
        'Return the REAL pins (number, name, electrical type) of an installed KiCad symbol by lib_id, following extends links, plus its unit count — the authoritative source for REF.PIN endpoints, instead of guessing pins or reading .kicad_sym files. Warns when the symbol is multi-unit, which the drafting engine refuses. On a miss it lists the closest names in that library and where the symbol actually lives, so one call answers both "what are the pins" and "which lib_id is right".',
      parameters: {
        type: 'object',
        properties: {
          lib_id: { type: 'string', description: 'full library identifier, e.g. "Device:R" or "Audio:TLV320AIC3100"' },
        },
        required: ['lib_id'],
      },
    },
    requiresUnlock: false,
    handler: async (_ctx, args) => {
      const libId = str(args, 'lib_id');
      const name = libId.includes(':') ? libId.slice(libId.indexOf(':') + 1) : libId;
      const dirs = await symbolSearchDirs();
      if (!dirs.length) {
        return `cannot verify "${libId}": no installed KiCad symbol library directories were found on this machine, so nothing can be resolved or ruled out. Install the KiCad symbol libraries (or set KICAD_SYMBOL_DIR), or choose a part you can verify another way.`;
      }
      const r = await resolveLibrarySymbol(libId, dirs);
      if (r.status === 'ok') {
        const pins = [...r.pins]
          .sort((a, b) => comparePinNumbers(a.number, b.number))
          .map((p) => `  ${p.number}: ${p.name === '~' || !p.name ? '(unnamed)' : p.name} · ${p.type}`);
        const multi =
          r.units >= 2
            ? `\nNOTE: this symbol defines ${r.units} units; the drafting engine places each unit separately under one refdes (U1A/U1B), and net endpoints keep plain package pin numbers.`
            : '';
        return `${libId} — ${r.pins.length} pin(s), ${r.units} unit(s):\n${pins.join('\n')}${multi}`;
      }
      if (r.status === 'found-elsewhere') {
        return `"${libId}" does not resolve, but the symbol is installed as: ${r.libIds.join(', ')} — use one of these lib_ids (and call symbol_pins on it for the pin table).`;
      }
      const elsewhere = await searchInstalledSymbols(name, dirs, 6);
      const where = elsewhere.length
        ? `\ninstalled as: ${elsewhere.join(', ')}`
        : `\nno installed symbol matches "${name}" in any library — the part is not capturable as named.`;
      if (r.status === 'no-symbol') {
        const close = r.candidates.length ? `\nclosest in that library: ${r.candidates.join(', ')}` : '';
        return `"${libId}" does not exist in that library.${close}${where}`;
      }
      const lib = libId.includes(':') ? libId.slice(0, libId.indexOf(':')) : libId;
      return `no library named "${lib}" is installed.${where}`;
    },
  },
  {
    schema: {
      name: 'verify_symbols',
      description:
        "Cross-check every lib_symbols entry in the schematic against the KiCad symbol library installed on this machine. Reports pins that diverge from the real part (wrong count, name, or electrical type) and lib_ids that do not exist in the current KiCad version (with the closest real names). ERC cannot catch these — a symbol whose lib_id claims to be a canonical part but whose pins are wrong passes ERC while being wrong. Run this after capturing symbols and reconcile every finding.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
    requiresUnlock: false,
    handler: async (ctx) => {
      if (!ctx.config.schematic)
        return 'no schematic configured; verify_symbols does not apply yet';
      const { findings, checked, skipped } = await verifySchematicSymbols(
        path.join(ctx.repoRoot, ctx.config.schematic),
      );
      if (!findings.length) {
        return `verify_symbols: ${checked} symbol(s) match the installed KiCad library. No divergences.`;
      }
      const lines = findings.map((f) => `  - [${f.kind}] ${f.detail}`);
      const mismatches = findings.filter((f) => f.kind !== 'no-library').length;
      return `verify_symbols: ${checked} verified, ${skipped} unverifiable (library not installed), ${mismatches} issue(s) to reconcile:\n${lines.join('\n')}`;
    },
  },
  {
    schema: {
      name: 'draft_schematic',
      description:
        'Regenerate the schematic deterministically from the netlist-intent IR (schematic.intent.json beside the schematic). Pass intent_json to write a new IR first, or omit it to re-draft the existing file. The engine computes ALL geometry (placement, wires, labels, power symbols, group boxes); never author coordinates. The report embeds the legibility findings and score for the fresh sheet. A failed validation leaves the previous schematic untouched.',
      parameters: {
        type: 'object',
        properties: {
          intent_json: { type: 'string', description: 'full IR document as JSON text (optional: omit to re-draft the current IR)' },
        },
        required: [],
      },
    },
    requiresUnlock: true,
    handler: async (ctx, args) => {
      if (!ctx.config.schematic) return 'no schematic configured; set one in .copperhead/config.json first';
      const intentRel = defaultIntentPath(ctx.config.schematic);
      if (typeof args.intent_json === 'string' && args.intent_json.trim()) {
        const corrupt = corruptionError({ intent_json: args.intent_json });
        if (corrupt) return corrupt;
        try {
          JSON.parse(args.intent_json);
        } catch (e) {
          return `intent_json is not valid JSON (${(e as Error).message}); nothing written`;
        }
        await writeFile(resolveInRepo(ctx.repoRoot, intentRel), args.intent_json, 'utf8');
        ctx.filesTouched.add(intentRel);
      }
      const res = await draftSchematic({
        repoRoot: ctx.repoRoot,
        schematic: ctx.config.schematic,
        intentPath: intentRel,
        docsDir: ctx.config.docs,
      });
      if (!res.ok) return res.message;
      markTouched(ctx, ctx.config.schematic);
      // embed the checker and score in the draft report (design D5): a
      // draft-check-score iteration costs one tool call, and the embedded
      // checker result drives the ledger obligation exactly like check_legibility
      const docsAbs = path.join(ctx.repoRoot, ctx.config.docs);
      const leg = await checkLegibility(res.schematicPath, {
        docsDir: docsAbs,
        ...(ctx.config.legibility ? { config: ctx.config.legibility } : {}),
      });
      ctx.lastLegibility = leg.counts;
      ctx.ledger.onLegibilityResult(leg.counts.error);
      const score = await scoreSchematic(res.schematicPath, {
        docsDir: docsAbs,
        ...(ctx.config.legibility ? { config: ctx.config.legibility } : {}),
      });
      ctx.lastScore = score.composite;
      return [formatSchematicDraftReport(res.report), formatLegibility(leg), formatScore(score)].join('\n');
    },
  },
  {
    schema: {
      name: 'score_schematic',
      description:
        'Deterministic quantitative legibility score for the schematic: composite 0-100 with the per-metric breakdown (crossings, bends, alignment, spacing, symmetry, balance, …). Error-severity legibility findings cap the composite. Advisory: informs, never gates by itself.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    requiresUnlock: false,
    handler: async (ctx) => {
      if (!ctx.config.schematic) return 'no schematic configured; score_schematic does not apply yet';
      const report = await scoreSchematic(path.join(ctx.repoRoot, ctx.config.schematic), {
        docsDir: path.join(ctx.repoRoot, ctx.config.docs),
        ...(ctx.config.legibility ? { config: ctx.config.legibility } : {}),
      });
      ctx.lastScore = report.composite;
      return formatScore(report);
    },
  },
  {
    schema: {
      name: 'check_legibility',
      description:
        'Run the deterministic legibility checker against the schematic: group boxes and captions, symbol/text collisions, grid alignment, frame and title-block use. Returns numbered findings with coordinates and the concrete fix, or "no findings". Error-severity findings must be reconciled before finish; clears the legibility obligation when clean.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    requiresUnlock: false,
    handler: async (ctx) => {
      // Mirrors check_drift's vacuous path: with no schematic configured there is
      // nothing to be illegible, and leaving the obligation open would deadlock
      // any stage that edited a stray .kicad_sch without config wiring.
      if (!ctx.config.schematic) {
        ctx.ledger.clear('legibility');
        return 'no schematic configured; legibility does not apply yet';
      }
      const report = await checkLegibility(path.join(ctx.repoRoot, ctx.config.schematic), {
        docsDir: path.join(ctx.repoRoot, ctx.config.docs),
        ...(ctx.config.legibility ? { config: ctx.config.legibility } : {}),
      });
      ctx.lastLegibility = report.counts;
      ctx.ledger.onLegibilityResult(report.counts.error);
      return formatLegibility(report);
    },
  },
  {
    schema: {
      name: 'run_drc',
      description: 'Run kicad-cli DRC on the board. Clears the DRC obligation when clean.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    requiresUnlock: false,
    handler: async (ctx) => {
      if (!ctx.config.board)
        return 'no board configured; DRC does not apply yet — skip it until a board exists and is set in .copperhead/config.json';
      const report = await runDrc(path.join(ctx.repoRoot, ctx.config.board));
      ctx.lastDrc = report;
      if (report.ok) ctx.ledger.clear('drc');
      else ctx.repairCycles++;
      return formatViolations(report);
    },
  },
  {
    schema: {
      name: 'export_svg',
      description: 'Export an SVG render of the schematic or board into .copperhead/renders/.',
      parameters: {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['sch', 'pcb'] } },
        required: ['kind'],
      },
    },
    requiresUnlock: false,
    handler: async (ctx, args) => {
      const kind = str(args, 'kind') as 'sch' | 'pcb';
      const file = kind === 'sch' ? ctx.config.schematic : ctx.config.board;
      if (!file) return `no ${kind} configured`;
      const outDir = path.join(ctx.repoRoot, '.copperhead', 'renders');
      await mkdir(outDir, { recursive: true });
      return exportSvg(kind, path.join(ctx.repoRoot, file), outDir);
    },
  },
  {
    schema: {
      name: 'export_outputs',
      description:
        'Export the fabrication package into outputs/: gerbers+drill, DXF outline, STEP, SVG renders. Reports per-artifact success/failure.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    requiresUnlock: true,
    handler: async (ctx) => {
      if (!ctx.config.board) return 'no board configured';
      const outDir = path.join(ctx.repoRoot, 'outputs');
      await mkdir(outDir, { recursive: true });
      const res = await exportFab(
        path.join(ctx.repoRoot, ctx.config.board),
        ctx.config.schematic ? path.join(ctx.repoRoot, ctx.config.schematic) : null,
        outDir,
      );
      ctx.filesTouched.add('outputs/');
      const lines = [`produced: ${res.produced.join(', ') || '(none)'}`];
      for (const f of res.failed) lines.push(`FAILED ${f.artifact}: ${f.reason}`);
      return lines.join('\n');
    },
  },
  {
    schema: {
      name: 'check_drift',
      description: 'Compare BOM.md/PINOUT.md tables against the parsed schematic. Clears the drift obligation when clean.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    requiresUnlock: false,
    handler: async (ctx) => {
      // No schematic yet means there is nothing for the docs to drift against,
      // so the obligation is vacuously satisfied and must be cleared. Returning
      // without clearing deadlocks every docs-only stage of the create pipeline
      // (spec-seed, architecture, part-selection all run before the schematic
      // exists): a doc edit opens the drift obligation, this is the only tool
      // that clears it, and finish refuses while any obligation is open.
      if (!ctx.config.schematic) {
        ctx.ledger.clear('drift');
        return 'no schematic configured; drift vacuously clean';
      }
      const mismatches = await checkDrift(ctx.repoRoot, ctx.config.docs, ctx.config.schematic);
      if (!mismatches.length) {
        ctx.ledger.clear('drift');
        return 'drift: clean';
      }
      return mismatches.map((m) => `${m.doc}: claims "${m.claim}" but actual is "${m.actual}"`).join('\n');
    },
  },
  {
    schema: {
      name: 'record_constraint',
      description:
        'Record a constraint in .copperhead/constraints.json (dual write: put the same fact in the relevant doc in this same turn). Opens revisit obligations for every item in affects.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'e.g. power.sleep_current_uA' },
          min: { type: 'number' },
          max: { type: 'number' },
          forbidden: { type: 'array', items: { type: 'string' } },
          value: { type: 'string' },
          source: { type: 'string', description: 'doc/spec location that states this' },
          affects: { type: 'array', items: { type: 'string' } },
        },
        required: ['key', 'source', 'affects'],
      },
    },
    requiresUnlock: true,
    handler: async (ctx, args) => {
      const key = str(args, 'key');
      const affects = (args.affects as string[]) ?? [];
      // An affects item whose target artifact is not built yet (no schematic or
      // board configured, no BOM.md) has nothing to revisit; opening an
      // obligation now only forces a ceremonial "not yet created" resolution.
      // Defer it in the registry instead — reopenDeferredAffects re-opens it at
      // the start of the first run where the artifact exists, which is when the
      // revisit actually means something.
      const deferred: string[] = [];
      const openNow: string[] = [];
      for (const item of affects) {
        const target = classifyAffectsTarget(item);
        if (target && !affectsTargetExists(target, ctx.repoRoot, ctx.config)) deferred.push(item);
        else openNow.push(item);
      }
      await saveConstraint(ctx.repoRoot, key, {
        ...(args.min !== undefined ? { min: args.min as number } : {}),
        ...(args.max !== undefined ? { max: args.max as number } : {}),
        ...(args.forbidden !== undefined ? { forbidden: args.forbidden as string[] } : {}),
        ...(args.value !== undefined ? { value: args.value as string } : {}),
        source: str(args, 'source'),
        affects,
        ...(deferred.length ? { deferred } : {}),
      });
      ctx.ledger.onConstraintChange(key, openNow);
      ctx.ledger.clear('constraint-dual-write', key);
      const parts = [`constraint ${key} recorded`];
      parts.push(`revisit obligations opened for: ${openNow.join(', ') || '(none)'}`);
      if (deferred.length) {
        parts.push(
          `deferred until the target artifact exists (no resolve_affected needed now): ${deferred.join(', ')}`,
        );
      }
      return parts.join('; ');
    },
  },
  {
    schema: {
      name: 'resolve_affected',
      description:
        'Explicitly resolve affects-revisit obligations: state whether each affected item changed or why no change is needed. Pass resolutions[] to clear many in one call, or the single constraint_key/item/resolution form.',
      parameters: {
        type: 'object',
        properties: {
          constraint_key: { type: 'string' },
          item: { type: 'string' },
          resolution: { type: 'string', description: '"changed: ..." or "no change needed: <reason>"' },
          resolutions: {
            type: 'array',
            description: 'batch form: resolve many obligations in one call',
            items: {
              type: 'object',
              properties: {
                constraint_key: { type: 'string' },
                item: { type: 'string' },
                resolution: { type: 'string' },
              },
              required: ['constraint_key', 'item', 'resolution'],
            },
          },
        },
        required: [],
      },
    },
    requiresUnlock: true,
    handler: async (ctx, args) => {
      // An item that matches nothing must not read as success: the model would
      // move on believing the obligation closed, and only find out at finish.
      const resolveOne = (constraintKey: string, item: string, resolution: string): string => {
        const detail = `${constraintKey} affects ${item}`;
        if (!ctx.ledger.clear('affects-revisit', detail)) {
          const open = ctx.ledger.openOfKind('affects-revisit');
          if (!open.length) return `error: no open affects-revisit obligation matches "${detail}"`;
          return [
            `error: no open affects-revisit obligation matches "${detail}".`,
            'Match these exactly:',
            ...open.map((o) => `  - ${o.detail}`),
          ].join('\n');
        }
        ctx.decisions.push(`[affects] ${detail}: ${resolution}`);
        return `resolved: ${detail}`;
      };

      const batch = args.resolutions;
      if (Array.isArray(batch) && batch.length) {
        // Entries resolve independently: one bad key must not waste the call.
        return batch
          .map((entry, i) => {
            const e = entry as Record<string, unknown>;
            if (typeof e?.constraint_key !== 'string' || typeof e?.item !== 'string' || typeof e?.resolution !== 'string') {
              return `error: resolutions[${i}] needs string constraint_key, item, and resolution`;
            }
            return resolveOne(e.constraint_key, e.item, e.resolution);
          })
          .join('\n');
      }
      if (typeof args.constraint_key === 'string' && typeof args.item === 'string' && typeof args.resolution === 'string') {
        return resolveOne(args.constraint_key, args.item, args.resolution);
      }
      return 'error: pass either resolutions: [{constraint_key, item, resolution}, ...] or the single form constraint_key + item + resolution';
    },
  },
  {
    schema: {
      name: 'record_decision',
      description:
        'Append a non-trivial decision to docs/DECISIONS.md: what was decided, the one-line why, and what it affects.',
      parameters: {
        type: 'object',
        properties: {
          decision: { type: 'string' },
          rationale: { type: 'string' },
          affects: { type: 'string', description: 'refdes/nets/docs affected' },
        },
        required: ['decision', 'rationale'],
      },
    },
    requiresUnlock: true,
    handler: async (ctx, args) => {
      const corrupt = corruptionError({ decision: args.decision, rationale: args.rationale, affects: args.affects });
      if (corrupt) return corrupt;
      const decision = str(args, 'decision');
      const rationale = str(args, 'rationale');
      const affects = (args.affects as string | undefined) ?? '';
      const date = new Date().toISOString().slice(0, 10);
      const entry = `- ${date} [run ${ctx.runId}] ${decision} | why: ${rationale}${affects ? ` | affects: ${affects}` : ''}`;
      const p = path.join(ctx.repoRoot, ctx.config.docs, 'DECISIONS.md');
      await appendFile(p, entry + '\n', 'utf8');
      ctx.decisions.push(`${decision} | why: ${rationale}`);
      ctx.filesTouched.add(path.join(ctx.config.docs, 'DECISIONS.md'));
      return 'decision recorded';
    },
  },
  {
    schema: {
      name: 'finish',
      description:
        'End the run. outcome "done" requires all verification gates and sync obligations to be satisfied; outcome "refuse" ends without edits, citing the violated budget/constraint in summary.',
      parameters: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['done', 'refuse'] },
          summary: { type: 'string' },
        },
        required: ['outcome', 'summary'],
      },
    },
    requiresUnlock: false,
    handler: async (ctx, args) => {
      const outcome = str(args, 'outcome') as 'done' | 'refuse';
      const summary = str(args, 'summary');
      if (outcome === 'refuse') {
        ctx.finishRequest = { outcome, summary };
        return 'refusal recorded; run will end';
      }
      const problems: string[] = [];
      const touchedKicad = [...ctx.filesTouched].some((f) => isKicadFile(f));
      if (touchedKicad) {
        if (!ctx.lastErc?.ok) problems.push('ERC has not passed since the last schematic edit (run run_erc)');
        const touchedPcb = [...ctx.filesTouched].some((f) => f.endsWith('.kicad_pcb'));
        if (touchedPcb && !ctx.lastDrc?.ok) problems.push('DRC has not passed since the last board edit (run run_drc)');
      }
      // the changelog obligation is cleared by the commit path itself
      const blocking = ctx.ledger.openObligations.filter((o) => o.kind !== 'changelog');
      if (blocking.length) {
        problems.push('open sync obligations:\n' + blocking.map((o) => `  - [${o.kind}] ${o.detail}`).join('\n'));
      }
      if (problems.length) {
        return `cannot finish yet:\n${problems.map((p) => `- ${p}`).join('\n')}`;
      }
      ctx.finishRequest = { outcome, summary };
      return 'all gates satisfied; run will commit';
    },
  },
];

/** Compose the tool list for the current state (design D2: the lock is structural). */
export function availableTools(ctx: RunContext): ToolDef[] {
  return TOOLS.filter((t) => !t.requiresUnlock || ctx.editsUnlocked);
}

/** A tool call's outcome: its text, and whether that text is a result or a failure. */
export interface ToolOutcome {
  text: string;
  ok: boolean;
}

/**
 * Run a tool and report both its text and whether it succeeded.
 *
 * The status has to travel alongside the text rather than be recovered from it:
 * a handler's error string is just a string, so a file whose contents begin the
 * same way is indistinguishable from a failure to any caller that sniffs
 * prefixes.
 */
export async function dispatchToolResult(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const tool = availableTools(ctx).find((t) => t.schema.name === name);
  if (!tool) {
    return {
      text: `tool "${name}" is not available${ctx.editsUnlocked ? '' : ' (edit tools unlock after the proposal validates)'}`,
      ok: false,
    };
  }
  try {
    return { text: await tool.handler(ctx, args), ok: true };
  } catch (err) {
    return { text: `error: ${(err as Error).message}`, ok: false };
  }
}

/** Text-only form, for callers that only consume what the model would see. */
export async function dispatchTool(ctx: RunContext, name: string, args: Record<string, unknown>): Promise<string> {
  return (await dispatchToolResult(ctx, name, args)).text;
}
