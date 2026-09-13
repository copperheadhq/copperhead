/**
 * Shared markdown-table parsing for BOM.md and PINOUT.md (design D9's
 * fixed-column contract). Originally lived inline in drift.ts; pulled out so
 * the supplier BOM export work (add-supplier-bom-export) can parse BOM.md
 * once, the same way, instead of duplicating this.
 */

export interface TableRow {
    cells: string[];
  }
  
  /**
   * Split one row into trimmed cells. The outer pipes are optional, because they
   * are optional in GitHub-flavored markdown: `Refdes | Pin | Net` renders as a
   * table exactly like `| Refdes | Pin | Net |` does, and a hand- or LLM-authored
   * doc may legitimately be written either way.
   */
  function splitRow(line: string): string[] {
    return line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
  }

  /** `|---|:--:|` and friends: the row separating a header from its data. */
  function isSeparatorRow(cells: string[]): boolean {
    return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
  }

  /**
   * Parses every markdown pipe-table row out of a document, across however
   * many tables the file contains, skipping separator rows (e.g. `|---|---|`).
   * Malformed lines (stray `|` outside a real table) just become a row with
   * whatever cells they split into — this function never throws.
   */
  export function parseMarkdownTables(md: string): TableRow[] {
    return (
      scanTableGroups(md)
        // A group opened by an un-piped line with no delimiter row is not a table:
        // GFM requires the delimiter row for one to exist at all. Without this,
        // ordinary prose such as `Second-source options: Yageo | Vishay | KOA`
        // under a BOM table becomes a part in `export bom`, which `check` cannot
        // catch because `parseCanonicalTables` drops the header-less group.
        .filter((g) => g[0]!.piped || g.some((l) => l.separator))
        .flat()
        .filter((l) => !l.separator)
        .map((l) => ({ cells: l.cells }))
    );
  }

  interface ScannedLine {
    cells: string[];
    separator: boolean;
    /** Whether the source line carried a leading pipe. */
    piped: boolean;
  }

  /**
   * Group a document's table lines, one group per table. Both readers below go
   * through this so they cannot disagree about which documents are readable:
   * `check` accepting a BOM.md that `export bom` reads as empty is how a clean
   * check turns into a header-only ordering file.
   *
   * Lines inside a fenced code block are skipped. Docs legitimately show the
   * table format as an example, and an example row is not a part or a pin.
   */
  function scanTableGroups(md: string): ScannedLine[][] {
    const groups: ScannedLine[][] = [];
    let current: ScannedLine[] | null = null;
    let width = 0; // column count of the open group, set by its first line
    // The open fence's delimiter, or null outside one. A fence closes only on the
    // same character, at least as long (CommonMark). Toggling on any fence-like
    // line would let a shorter or different delimiter *inside* a block end it
    // early, and the example rows after it would be read as parts or pins.
    let fence: { char: string; length: number } | null = null;
    // Split on either line ending: a CRLF document would otherwise leave a
    // trailing \r on every line, and \r is a line terminator that `.` does not
    // match, so the fence patterns below would never fire on a CRLF file.
    for (const line of md.split(/\r?\n/)) {
      const t = line.trim();
      // Matched against the raw line: CommonMark allows a fence up to three
      // spaces of indentation, and four or more makes it content rather than a
      // fence. Trimming first would let an indented delimiter inside a block
      // read as a closer.
      const delim = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (delim) {
        const marker = delim[1]!;
        const char = marker[0]!;
        if (!fence) {
          fence = { char, length: marker.length };
          current = null;
          continue;
        }
        // A closing fence carries no info string; anything else stays content.
        if (char === fence.char && marker.length >= fence.length && !delim[2]!.trim()) {
          fence = null;
          current = null;
          continue;
        }
      }
      if (fence || !t.includes('|')) {
        current = null; // a blank, prose, or fenced line terminates the table
        continue;
      }
      const cells = splitRow(t);
      // Outer pipes make a line unambiguously a table row. Without them, a
      // pipe-bearing prose line (`Legend: A | B`) is indistinguishable from a
      // row by shape alone, so the column count decides: matching the open
      // table's width keeps it as a row, a mismatch ends the table there rather
      // than reading the prose as a part/pin. The line still opens a new group,
      // in case it is itself the header of an un-piped table.
      if (current && !t.startsWith('|') && cells.length !== width) current = null;
      if (!current) {
        current = [];
        width = cells.length;
        groups.push(current);
      }
      // The separator row stays in the group so the header can be located
      // relative to it; it is dropped by the readers above and below.
      current.push({ cells, separator: isSeparatorRow(cells), piped: t.startsWith('|') });
    }
    return groups;
  }
  
  /** True for a table's header row. BOM.md and PINOUT.md both lead with a
   * Refdes or Pin column, so one check covers both doc types. */
  export const isHeader = (row: TableRow): boolean =>
    row.cells.some((c) => /^(refdes|pin)$/i.test(c));

  /**
   * Data rows of the CANONICAL table(s) only — those introduced by a Refdes/Pin
   * header row (`isHeader`). BOM.md and PINOUT.md legitimately carry supporting
   * tables (a quiescent-current roll-up, a net-meaning legend); their rows are
   * NOT parts/pins and must never be compared against the schematic. The flat
   * `parseMarkdownTables(md).filter(!isHeader)` does exactly that — it merges
   * every table's rows — so a second table's first cell gets read as a refdes and
   * flagged "not in schematic", which pushes the agent to degrade good docs into
   * bullet lists just to appease the drift gate.
   *
   * This groups lines into tables (a run of pipe-rows, ended by any non-pipe
   * line), keeps only the groups whose first row is a Refdes/Pin header, and
   * returns those groups' data rows (header dropped). A table with no recognized
   * header — including a bare data-only block — is ignored, preserving the
   * fixed-column contract (design D9) while letting docs hold extra tables.
   */
  export function parseCanonicalRows(md: string): TableRow[] {
    return parseCanonicalTables(md).flatMap((t) => t.rows);
  }

  /**
   * Like parseCanonicalRows, but keeps each kept table's header row so a caller
   * can resolve columns by *name* instead of a fixed position. PINOUT.md's
   * column count is not fixed in practice: the scaffold writes
   * `Refdes | Pin | Name | Net | Notes`, but a hand- or LLM-authored table may
   * legitimately drop the optional Name/Notes columns and write
   * `Refdes | Pin | Net`. A fixed positional net index then reads the wrong cell
   * and reports every pin as net "NC" against a doc that is in fact correct —
   * a false drift the agent cannot diagnose (the doc plainly shows the net), so
   * it loops on finish forever. Resolving by header name fixes that.
   */
  export function parseCanonicalTables(md: string): Array<{ header: TableRow; rows: TableRow[] }> {
    const tables: Array<{ header: TableRow; rows: TableRow[] }> = [];
    for (const g of scanTableGroups(md)) {
      // The header is the row directly above the separator. Falling back to the
      // first row keeps a table that omits the separator working, and anchoring
      // on the separator means a stray pipe-bearing prose line immediately above
      // a table no longer hides it.
      const sep = g.findIndex((l) => l.separator);
      const headerIdx = sep > 0 ? sep - 1 : 0;
      const header = g[headerIdx];
      if (!header || header.separator || !isHeader({ cells: header.cells })) continue;
      tables.push({
        header: { cells: header.cells },
        rows: g
          .slice(headerIdx + 1)
          .filter((l) => !l.separator)
          .map((l) => ({ cells: l.cells })),
      });
    }
    return tables;
  }

  /**
   * Markdown tables with their named header retained. Unlike
   * `parseCanonicalTables`, this accepts arbitrary header names so a
   * deterministic consumer can define a small, explicit input format without
   * pretending that every table is a BOM or pinout table.
   */
  export function parseNamedMarkdownTables(md: string): Array<{ header: TableRow; rows: TableRow[] }> {
    const tables: Array<{ header: TableRow; rows: TableRow[] }> = [];
    for (const g of scanTableGroups(md)) {
      const sep = g.findIndex((l) => l.separator);
      // A header-less pipe block is not a stable interface. Requiring the GFM
      // delimiter row also keeps prose containing pipes out of audit inputs.
      if (sep <= 0) continue;
      const header = g[sep - 1]!;
      tables.push({
        header: { cells: header.cells },
        rows: g.slice(sep + 1).filter((l) => !l.separator).map((l) => ({ cells: l.cells })),
      });
    }
    return tables;
  }

  /**
   * PINOUT.md pin assignments, resolved by column *name* and tolerant of the
   * optional Name/Notes columns (see parseCanonicalTables). Only the canonical
   * table that carries both a Pin and a Net header is read; a supporting table
   * (e.g. a `Net | Role` legend) is ignored. Net names are compared bare, so the
   * common `` `VBUS` `` markdown-backtick styling is stripped — the schematic
   * stores plain net names, and a backtick-only difference is not real drift.
   */
  export function parsePinoutRows(md: string): Array<{ ref: string; pin: string; net: string }> {
    const out: Array<{ ref: string; pin: string; net: string }> = [];
    const strip = (s: string | undefined): string => (s ?? '').replace(/`/g, '').trim();
    for (const { header, rows } of parseCanonicalTables(md)) {
      const col = (re: RegExp): number => header.cells.findIndex((c) => re.test(c));
      const refI = col(/^refdes$/i);
      const pinI = col(/^pin$/i);
      const netI = col(/^net$/i);
      if (pinI < 0 || netI < 0) continue; // not the pin-assignment table
      for (const row of rows) {
        out.push({
          ref: refI >= 0 ? strip(row.cells[refI]) : '',
          pin: strip(row.cells[pinI]),
          net: strip(row.cells[netI]),
        });
      }
    }
    return out;
  }

  /**
   * Fold the semantically-identical encodings that the model and KiCad render
   * differently, so a value that differs only in *encoding* is not flagged as
   * drift (#I11). A design that reached ERC-clean once churned for turns on
   * `Ihold≥3A` vs `Ihold>=3A` and `0.1"` vs `0.1in` — byte differences with zero
   * electrical meaning. Folded here: ≥/>=, ≤/<=, Ω/ohm(s), µ/μ/u, smart quotes,
   * and the inch mark (`"` / `″` / a trailing `in`/`inch` after a number). NFKC
   * first collapses width/compatibility variants; the explicit rules cover the
   * cases NFKC leaves alone (≥, smart quotes, the ohm/inch words).
   */
  export function foldEncodings(s: string | undefined): string {
    if (!s) return '';
    return s
      .normalize('NFKC')
      .replace(/≥/g, '>=')
      .replace(/≤/g, '<=')
      .replace(/[ΩΩ]/g, 'ohm') // ohm sign U+2126 / greek capital omega U+03A9
      .replace(/\bohms\b/gi, 'ohm')
      .replace(/[µμ]/g, 'u') // micro sign U+00B5 / greek small mu U+03BC
      .replace(/[“”″]/g, '"') // smart double quotes and double-prime → "
      .replace(/[‘’′]/g, "'") // smart single quotes and prime → '
      .replace(/(?<=[\d.])\s*(?:inches|inch|in)\b/gi, '"') // 0.1in / 0.1 inch → 0.1"
      .trim();
  }

  /**
   * Value-cell equality key: `foldEncodings` plus case- and whitespace-folding.
   * Used to compare BOM.md value/footprint cells against schematic symbol values
   * so an encoding/case/spacing-only difference is not reported as drift.
   */
  export function normalizeValue(s: string | undefined): string {
    return foldEncodings(s).replace(/\s+/g, '').toLowerCase();
  }

  /**
   * Footprint equality key: like `normalizeValue` but WITHOUT case-folding (F6).
   * A footprint is a KiCad library reference (`Resistor_SMD:R_0603_1608Metric`)
   * whose casing is significant — `R_0603` and `r_0603` are not the same library
   * id — so lowercasing it would hide a real footprint difference. Encoding and
   * spacing are still folded (a stray space or unicode variant is not real drift).
   */
  export function normalizeFootprint(s: string | undefined): string {
    return foldEncodings(s).replace(/\s+/g, '');
  }

  /**
   * Which of the canonical pin-assignment columns PINOUT.md actually provides.
   * `checkDrift` uses this to emit ONE explicit "no Net column" message when the
   * doc omits the column entirely, instead of silently checking nothing (a
   * correct doc then looks unverified) or — the old positional bug (#I12) —
   * reading the wrong cell and reporting every pin as a false `NC` mismatch.
   * `hasTable` is false when the doc has no Refdes/Pin-headed table at all.
   */
  export function pinoutColumnReport(md: string): { hasTable: boolean; pin: boolean; net: boolean; refdes: boolean } {
    let hasTable = false;
    let pin = false;
    let net = false;
    let refdes = false;
    for (const { header } of parseCanonicalTables(md)) {
      hasTable = true;
      const has = (re: RegExp): boolean => header.cells.some((c) => re.test(c));
      if (has(/^pin$/i)) pin = true;
      if (has(/^net$/i)) net = true;
      if (has(/^refdes$/i)) refdes = true;
    }
    return { hasTable, pin, net, refdes };
  }

  /**
   * A typed BOM.md data row, per the fixed column contract that `init` writes
   * (Refdes | Value | Footprint | MPN | Rationale — see scaffold.ts's
   * `bomTable`). `flags` currently only ever contains `UNVERIFIED` (the MPN
   * column literally says so) or `MISSING_MPN` (no MPN column value at all);
   * more may be added as the export/fab-gate work grows.
   */
  export interface BomRow {
    refdes: string;
    value?: string;
    footprint?: string;
    mpn?: string;
    flags: string[];
  }
  
  /**
   * Parses BOM.md's data rows into typed rows. Columns are resolved by header
   * *name* (Refdes/Value/Footprint/MPN), falling back to the canonical position
   * when a header is absent — the same header-name discipline `parsePinoutRows`
   * uses (#I12), so a doc that reorders or drops an optional column is still read
   * correctly instead of silently shifting every cell. Rows without a refdes are
   * dropped rather than thrown on: a hand-edited doc with a ragged or partial
   * table shouldn't crash `check` or `export bom`, it should just be skipped
   * (drift/export callers report the gaps that matter against the schematic).
   */
  export function parseBomTable(md: string): BomRow[] {
    const out: BomRow[] = [];
    for (const { header, rows } of parseCanonicalTables(md)) {
      // Resolve by header name; -1 means "not found", so fall back to the
      // canonical index for that column (Refdes 0, Value 1, Footprint 2, MPN 3).
      const col = (re: RegExp, fallback: number): number => {
        const i = header.cells.findIndex((c) => re.test(c));
        return i >= 0 ? i : fallback;
      };
      const refI = col(/^refdes$/i, 0);
      const valI = col(/^value$/i, 1);
      const fpI = col(/^footprint$/i, 2);
      const mpnI = col(/^mpn$/i, 3);
      for (const row of rows) {
        const refdes = row.cells[refI];
        if (!refdes) continue;
        const value = row.cells[valI];
        const footprint = row.cells[fpI];
        const mpn = row.cells[mpnI];
        const flags: string[] = [];
        if (mpn === 'UNVERIFIED') flags.push('UNVERIFIED');
        if (row.cells.some((c) => /VERIFIED\(datasheet\)/i.test(c))) flags.push('VERIFIED(datasheet)');
        else if (!mpn) flags.push('MISSING_MPN');
        out.push({
          refdes,
          value: value || undefined,
          footprint: footprint || undefined,
          mpn: mpn || undefined,
          flags,
        });
      }
    }
    return out;
  }
