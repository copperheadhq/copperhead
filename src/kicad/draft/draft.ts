import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { emitSchematic } from '../emit.js';
import { parseSexp, child, isList } from '../sexp.js';
import { childSpans, listEnd } from '../spans.js';
import { SymbolSource } from './symsource.js';
import type { FootprintResolver } from '../footprints.js';
import { parseIntent, validateIntent, formatIrFindings, INTENT_FILENAME, type IrFinding } from './ir.js';
import { draftSchematicPlacement, type SchematicDraftReport, type NetClass, type NetClassBasis } from './engine.js';

/**
 * Draft orchestration: intent file in, schematic out. Deterministic, LLM-free,
 * network-free (same contract class as `check`). A failed validation writes
 * nothing — the previous schematic, if any, stays untouched (design D6).
 */

export interface SchematicDraftOptions {
  repoRoot: string;
  /** Repo-relative schematic path to (re)write. */
  schematic: string;
  /** Repo-relative intent path; defaults to `schematic.intent.json` beside the schematic. */
  intentPath?: string;
  docsDir?: string | null;
  /** Override the installed-symbol search path (tests). */
  symbolDirs?: string[];
  /** Stable date stamp for the title block (callers pass a fixed value in tests). */
  today?: string;
  /**
   * Check every part's symbol pins against its footprint's pads (#314). The
   * agent's draft tool passes one; standalone drafts and the reference-board
   * corpus do not, since they carry no board.
   */
  footprints?: FootprintResolver;
}

export type SchematicDraftResult =
  | {
      ok: true;
      report: SchematicDraftReport;
      text: string;
      schematicPath: string;
      /** Engine-generated lib blocks (copperhead_power) to vendor. */
      generatedLibs: { libId: string; sourceText: string }[];
      /** Library-sourced lib_ids, for cache/table maintenance. */
      vendoredLibIds: string[];
    }
  | { ok: false; findings: IrFinding[]; message: string };

export function defaultIntentPath(schematic: string): string {
  return path.join(path.dirname(schematic), INTENT_FILENAME);
}

/** Draft to text without touching disk (staleness checks, dry runs). */
export async function draftSchematicToText(opts: SchematicDraftOptions): Promise<SchematicDraftResult> {
  const intentRel = opts.intentPath ?? defaultIntentPath(opts.schematic);
  const intentAbs = path.join(opts.repoRoot, intentRel);
  if (!existsSync(intentAbs)) {
    return { ok: false, findings: [{ detail: `intent file ${intentRel} does not exist` }], message: `intent file ${intentRel} does not exist` };
  }
  const { intent, findings: parseFindings } = parseIntent(await readFile(intentAbs, 'utf8'));
  if (!intent) return { ok: false, findings: parseFindings, message: formatIrFindings(parseFindings) };

  // vendor: false — this path is documented as not touching disk, and it backs
  // read-shaped callers (the stage-4 staleness probe); `draftSchematic` re-resolves
  // with a vendoring source after it decides to write
  const symsource = new SymbolSource(opts.repoRoot, opts.symbolDirs, false, path.dirname(path.join(opts.repoRoot, opts.schematic)));
  // docsDir may arrive repo-relative (config.docs); resolve against the repo
  const docsDir =
    opts.docsDir === undefined || opts.docsDir === null ? null : path.resolve(opts.repoRoot, opts.docsDir);
  const { ok, findings, validated } = await validateIntent(intent, symsource, docsDir, opts.footprints);
  if (!ok || !validated) return { ok: false, findings, message: formatIrFindings(findings) };

  const projectName = path.basename(opts.schematic).replace(/\.kicad_sch$/, '');
  // Date comes from the IR (hints.date), never the wall clock: the same IR
  // must emit identical bytes on every run and every day (design D4).
  const { model, report } = draftSchematicPlacement(validated, projectName, opts.today ?? intent.hints?.date ?? '2020-01-01');
  // what validation noticed but did not refuse (a pad the library leaves
  // unconnected by design), beside the engine's own notes
  report.notes.push(...validated.warnings);
  // A merged net means the sheet does not implement the IR: two distinct nets
  // share a label point, and KiCad resolves them to one. Refused rather than
  // written, because the alternative is an electrically wrong board that ERC
  // reports only as a `multiple_net_names` warning — quiet enough to reach
  // layout and fabrication outputs. Nothing is written, exactly as on a
  // validation failure, so a previously good sheet survives.
  if (report.mergedNets.length) {
    const findings = report.mergedNets.map((m) => ({
      detail:
        m.via === 'wires'
          ? `nets ${m.nets.join(' and ')} come into WIRE contact at (${m.x}, ${m.y}) — a wire endpoint or label of one ` +
            `rests on the other's wire, which KiCad joins into one net, so the drawn netlist would not match the ` +
            `intent. This is an engine routing/placement fault, not an intent error; the engine's own avoidance ` +
            `should have prevented it. Reshaping the IR is unlikely to help and should not be attempted more than ` +
            `once — report it against the engine with the intent that produced it.`
          : `nets ${m.nets.join(' and ')} share a label position at (${m.x}, ${m.y}), which merges them into one net — ` +
            `the drawn netlist would not match the intent. This is an engine placement fault, not an intent error: the ` +
            `de-collision pass already treats foreign labels as obstacles and, failing that, moves a label off a shared ` +
            `point even at the cost of overlapping text, so reaching this state means both labels were immovable ` +
            `(wired-net labels carry no stub to ride) or the sheet is too dense to separate them. Reshaping the IR is ` +
            `unlikely to help and should not be attempted more than once — report it against the engine with the intent ` +
            `that produced it.`,
    }));
    return { ok: false, findings, message: formatIrFindings(findings) };
  }
  const text = emitSchematic(model);
  return {
    ok: true,
    report,
    text,
    schematicPath: path.join(opts.repoRoot, opts.schematic),
    generatedLibs: model.libSymbols.filter((l) => l.libId.startsWith('copperhead_power:')),
    vendoredLibIds: [...validated.symbols.values()].map((s) => s.libId),
  };
}

/** Draft and write the schematic, the vendored power lib, and the sym-lib-table. */
export async function draftSchematic(opts: SchematicDraftOptions): Promise<SchematicDraftResult> {
  const res = await draftSchematicToText(opts);
  if (!res.ok) return res;
  const schDir = path.dirname(path.join(opts.repoRoot, opts.schematic));
  // Read the user's table before writing anything: a table this cannot parse
  // is refused, never rewritten, so its rows are not lost.
  const tablePath = path.join(schDir, 'sym-lib-table');
  let userRows: { name: string; text: string }[] = [];
  if (existsSync(tablePath)) {
    try {
      userRows = symLibTableRows(await readFile(tablePath, 'utf8'));
    } catch (e) {
      const detail = `${path.relative(opts.repoRoot, tablePath)} is not a readable library table (${(e as Error).message}); fix or remove it, then draft again`;
      return { ok: false, findings: [{ detail }], message: detail };
    }
  }
  await writeFile(res.schematicPath, res.text, 'utf8');

  // Vendor the engine-generated power symbols and point a project
  // sym-lib-table at every vendored nickname: without the table, ERC raises a
  // lib_symbol_issues warning per symbol ("configuration does not include the
  // library"), and `ok` requires a violation-free report.
  const symsource = new SymbolSource(opts.repoRoot, opts.symbolDirs, true, schDir);
  for (const lib of res.generatedLibs) await symsource.vendorGenerated(lib.libId, lib.sourceText);
  for (const libId of res.vendoredLibIds) await symsource.resolve(libId);
  // Without a project file KiCad never loads the project sym-lib-table (or
  // resolves ${KIPRJMOD}), so every embedded symbol raises a lib_symbol_issues
  // warning and ERC can never report clean. The create pipeline's bootstrap
  // already provides one; standalone drafts get a minimal project.
  const proPath = path.join(schDir, path.basename(opts.schematic).replace(/\.kicad_sch$/, '.kicad_pro'));
  if (!existsSync(proPath)) {
    const pro = {
      board: { design_settings: { defaults: {}, rules: {} } },
      erc: { rule_severities: {} },
      libraries: { pinned_footprint_libs: [], pinned_symbol_libs: [] },
      meta: { filename: path.basename(proPath), version: 1 },
      schematic: { legacy_lib_dir: '', legacy_lib_list: [] },
    };
    await writeFile(proPath, JSON.stringify(pro, null, 2) + '\n', 'utf8');
  }
  const cacheRel = path.relative(schDir, symsource.cacheDir()).split(path.sep).join('/');
  const vendored = new Set(symsource.vendoredLibs());
  // Rows the user added (a project-local vendor library, #314) survive the
  // rewrite verbatim, however they are laid out; only nicknames now served
  // from the cache, and the rows copperhead wrote before, are replaced.
  const kept = userRows.filter((r) => !vendored.has(r.name) && !r.text.includes('copperhead vendored')).map((r) => `\t${r.text}`);
  const rows = [...vendored]
    .map(
      (lib) =>
        `\t(lib (name "${lib}")(type "KiCad")(uri "\${KIPRJMOD}/${cacheRel ? cacheRel + '/' : ''}${lib}.kicad_sym")(options "")(descr "copperhead vendored"))`,
    );
  await writeFile(path.join(schDir, 'sym-lib-table'), `(sym_lib_table\n\t(version 7)\n${[...kept, ...rows].join('\n')}\n)\n`, 'utf8');
  return res;
}

/**
 * Each top-level `(lib …)` row of a `sym-lib-table`, with its nickname and its
 * exact source text (a row may span lines). Throws on a file that is not
 * exactly one balanced `(sym_lib_table …)` list: anything else before or
 * after it is content the rewrite would drop, so the file is refused instead.
 */
export function symLibTableRows(text: string): { name: string; text: string }[] {
  const open = text.indexOf('(sym_lib_table');
  if (open < 0) throw new Error('no (sym_lib_table …) list');
  if (text.slice(0, open).trim()) throw new Error('content before the (sym_lib_table …) list');
  const tail = text.slice(listEnd(text, open)).trim();
  if (tail) throw new Error(`content after the (sym_lib_table …) list: ${tail.slice(0, 40)}`);
  const rows: { name: string; text: string }[] = [];
  for (const span of childSpans(text, open)) {
    if (span.tag !== 'lib') continue;
    const row = text.slice(span.start, span.end);
    const node = parseSexp(row)[0];
    const name = node && isList(node) ? child(node, 'name')?.[1] : undefined;
    if (typeof name !== 'string' || !name) throw new Error(`a (lib …) row has no name: ${row.slice(0, 80)}`);
    rows.push({ name, text: row });
  }
  return rows;
}

export function formatSchematicDraftReport(report: SchematicDraftReport): string {
  const lines = [
    `drafted: ${report.groups.length} group(s), ${report.wireCount} wire segment(s), ${report.labelCount} label(s), ${report.noConnects} no-connect(s) on ${report.paper}`,
  ];
  for (const g of report.groups) lines.push(`  group "${g.name}": ${g.members.join(', ') || '(empty)'}`);
  // The basis is part of the class, not decoration: `~` marks a class no pin
  // attests, inferred from the net's NAME alone, which is the one inference a
  // reader has to check and the IR's `kind` is there to correct.
  // `~` marks the one classification no pin attests: a POWER class taken from
  // the net's name alone. A signal is what a net is when nothing said
  // otherwise, so marking every defaulted signal would decorate almost the
  // whole line and tell a reader nothing.
  const nameInferred = (n: { overridden: boolean; class: NetClass; basis: NetClassBasis }): boolean =>
    !n.overridden && n.basis === 'name' && n.class !== 'signal';
  const mark = (n: { overridden: boolean; class: NetClass; basis: NetClassBasis }): string =>
    n.overridden ? '*' : nameInferred(n) ? '~' : '';
  const legend = [
    report.netClasses.some((n) => n.overridden) ? '*=IR override' : '',
    report.netClasses.some(nameInferred) ? '~=inferred from the net name, not from any pin type' : '',
  ].filter(Boolean);
  lines.push(
    `  net classes: ${report.netClasses.map((n) => `${n.name}=${n.class}${mark(n)}`).join(', ')}${legend.length ? ` (${legend.join(', ')})` : ''}`,
  );
  if (report.pwrFlags.length) lines.push(`  PWR_FLAG synthesized on: ${report.pwrFlags.join(', ')}`);
  const sf = report.sheetFit as SchematicDraftReport['sheetFit'] | undefined;
  if (sf) lines.push(`  sheet fit: ${sf.paper}, ink ${Math.round(sf.inkUtilization * 100)}% of the usable frame, compaction ${sf.compaction}`);
  for (const n of report.notes) lines.push(`  note: ${n}`);
  return lines.join('\n');
}