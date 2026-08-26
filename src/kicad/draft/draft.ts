import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { emitSchematic } from '../emit.js';
import { SymbolSource } from './symsource.js';
import { parseIntent, validateIntent, formatIrFindings, INTENT_FILENAME, type IrFinding } from './ir.js';
import { draftSchematicPlacement, type SchematicDraftReport } from './engine.js';

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
  const symsource = new SymbolSource(opts.repoRoot, opts.symbolDirs, false);
  // docsDir may arrive repo-relative (config.docs); resolve against the repo
  const docsDir =
    opts.docsDir === undefined || opts.docsDir === null ? null : path.resolve(opts.repoRoot, opts.docsDir);
  const { ok, findings, validated } = await validateIntent(intent, symsource, docsDir);
  if (!ok || !validated) return { ok: false, findings, message: formatIrFindings(findings) };

  const projectName = path.basename(opts.schematic).replace(/\.kicad_sch$/, '');
  // Date comes from the IR (hints.date), never the wall clock: the same IR
  // must emit identical bytes on every run and every day (design D4).
  const { model, report } = draftSchematicPlacement(validated, projectName, opts.today ?? intent.hints?.date ?? '2020-01-01');
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
  await writeFile(res.schematicPath, res.text, 'utf8');

  // Vendor the engine-generated power symbols and point a project
  // sym-lib-table at every vendored nickname: without the table, ERC raises a
  // lib_symbol_issues warning per symbol ("configuration does not include the
  // library"), and `ok` requires a violation-free report.
  const symsource = new SymbolSource(opts.repoRoot, opts.symbolDirs);
  for (const lib of res.generatedLibs) await symsource.vendorGenerated(lib.libId, lib.sourceText);
  for (const libId of res.vendoredLibIds) await symsource.resolve(libId);
  const schDir = path.dirname(path.join(opts.repoRoot, opts.schematic));
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
  const rows = symsource
    .vendoredLibs()
    .map(
      (lib) =>
        `\t(lib (name "${lib}")(type "KiCad")(uri "\${KIPRJMOD}/${cacheRel ? cacheRel + '/' : ''}${lib}.kicad_sym")(options "")(descr "copperhead vendored"))`,
    );
  await writeFile(path.join(schDir, 'sym-lib-table'), `(sym_lib_table\n\t(version 7)\n${rows.join('\n')}\n)\n`, 'utf8');
  return res;
}

export function formatSchematicDraftReport(report: SchematicDraftReport): string {
  const lines = [
    `drafted: ${report.groups.length} group(s), ${report.wireCount} wire segment(s), ${report.labelCount} label(s), ${report.noConnects} no-connect(s) on ${report.paper}`,
  ];
  for (const g of report.groups) lines.push(`  group "${g.name}": ${g.members.join(', ') || '(empty)'}`);
  // The basis is part of the class, not decoration: `~` marks a class no pin
  // attests, inferred from the net's NAME alone, which is the one inference a
  // reader has to check and the IR's `kind` is there to correct.
  const mark = (n: { overridden: boolean; basis: string }): string => (n.overridden ? '*' : n.basis === 'name' ? '~' : '');
  const legend = [
    report.netClasses.some((n) => n.overridden) ? '*=IR override' : '',
    report.netClasses.some((n) => !n.overridden && n.basis === 'name') ? '~=inferred from the net name, not from any pin type' : '',
  ].filter(Boolean);
  lines.push(
    `  net classes: ${report.netClasses.map((n) => `${n.name}=${n.class}${mark(n)}`).join(', ')}${legend.length ? ` (${legend.join(', ')})` : ''}`,
  );
  if (report.pwrFlags.length) lines.push(`  PWR_FLAG synthesized on: ${report.pwrFlags.join(', ')}`);
  for (const n of report.notes) lines.push(`  note: ${n}`);
  return lines.join('\n');
}