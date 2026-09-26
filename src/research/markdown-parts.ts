import { parseNamedMarkdownTables } from '../memory/bom-table.js';

export class AuditError extends Error {}

export interface AuditInputRow {
  query: string;
  /** Only explicit MPN / part-number / LCSC fields require an exact identifier. */
  mpn?: string;
  refdes?: string;
  requiredQuantity?: number;
  line: number;
}

const PART_WORD = /\b(?:resistors?|capacitors?|inductors?|diodes?|transistors?|mosfets?|leds?|connectors?|headers?|receptacles?|switches?|buttons?|crystals?|oscillators?|regulators?|microcontrollers?|sensors?|modules?|relays?|fuses?|op[- ]?amps?|amplifiers?|eeproms?|flash|thermistors?|optocouplers?|potentiometers?)\b/i;
const PLACEHOLDER = /^(?:[-—?]+|n\/?a|unknown|unverified|tbd)$/i;
const IGNORE_SECTION = /^(?:out of scope|non[- ]goals|excluded|not required)\b/i;

function plain(value: string): string {
  return value.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/(?<!\w)(__?)(.+?)\1(?!\w)/g, '$2')
    .replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
}

function quantity(value: string | undefined, line: number): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value.replace(/,/g, '').trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new AuditError(`line ${line}: Required qty must be a positive whole number, got "${value}"`);
  return parsed;
}

/** Strip code and comments while keeping input line numbers stable. */
function contentLines(markdown: string): string[] {
  let fence: { char: string; length: number } | undefined;
  const uncommented = markdown.replace(/<!--[\s\S]*?(?:-->|$)/g, (value) => value.replace(/[^\n]/g, ''));
  return uncommented.split(/\r?\n/).map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { char: marker[1]![0]!, length: marker[1]!.length };
      else if (marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      return '';
    }
    return fence || (/^(?: {4}|\t)/.test(line) && !/^\s*(?:[-+*]|\d+[.)])\s+/.test(line)) ? '' : line;
  });
}

function identifiers(value: string): string[] {
  return (value.match(/\b[A-Za-z0-9][A-Za-z0-9.+/_-]{2,}\b/g) ?? []).filter((token) => {
    if (!/[a-z]/i.test(token) || !/\d/.test(token) || /^\d+-(?:layer|pin|bit|lead)$/i.test(token)) return false;
    if (/^(?:I2C|I2S|RS232|RS485|\d+(?:\.\d+)?(?:[munpk]?Ah|[munpk]?Wh|[kmg]?bps|[kmg]?B|dBm?|rpm|C))$/i.test(token)) return false;
    if (/^(?:[RCLDUJQY]|GPIO|IO|PIN)\d+$/i.test(token) && !/^C\d{4,}$/i.test(token)) return false;
    if (/^(?:\d+(?:\.\d+)?(?:[munpk]?a|[munpk]?v|[munp]?f|[kmg]?hz|[kmg]?ohms?|[munp]?h|mm|cm|mil|w|mb|gb|k|m)|\d+[vx]\d+|(?:USB|I2C|SPI|UART|QFN|SOIC|SOT|DIP|LQFP|TQFP)[-\d.]+)$/i.test(token)) return false;
    return !/^v?\d+(?:\.\d+)+$/i.test(token) && !/\.(?:md|json|tsx?|ya?ml|png|pdf)$/i.test(token);
  });
}

/** Keep nearby electrical qualifiers, not the surrounding requirements prose. */
function descriptions(phrase: string): string[] {
  const qualifier = (word: string): boolean => {
    const value = word.replace(/^[(:]+|[):,]+$/g, '');
    return identifiers(value).length > 0
      || /^(?:USB[- ]?C|USB|QSPI|SPI|I2C|LDO|SMD|SMT|DIP|SOIC|SOT|QFN|TQFP|LQFP|X7R|X5R|C0G|NP0|N-channel|P-channel|Schottky|Zener|tactile|ceramic|electrolytic|tantalum|red|green|blue|white|RGB|temperature|humidity|pressure|current|voltage|linear|switching|buck|boost|low|dropout|surface|mount)$/i.test(value)
      || /^(?:\d{4}|(?:QFN|SOIC|SOT|DIP|LQFP|TQFP)[-\d]+|\d+(?:\.\d+)?(?:[munp]?F|[munp]?H|[kmg]?Hz|[kmg]?(?:ohms?|Ω)|[kmg]|[munp]?A|[munp]?V|W|mm|cm|mil|MB|GB|%|"))$/i.test(value);
  };
  const out: string[] = [];
  for (const match of phrase.matchAll(new RegExp(PART_WORD.source, 'gi'))) {
    const before = phrase.slice(0, match.index).trim().split(/\s+/).filter(Boolean);
    const after = phrase.slice(match.index + match[0].length).replace(/^\s*:\s*/, '').trim().split(/\s+/).filter(Boolean);
    const prefix: string[] = [];
    while (before.length && qualifier(before.at(-1)!)) prefix.unshift(before.pop()!);
    const suffix: string[] = [];
    while (after.length && qualifier(after[0]!)) suffix.push(after.shift()!);
    out.push([...prefix, match[0], ...suffix].join(' '));
  }
  return out;
}

/** Deterministic extraction, with source locations so inferred queries are reviewable. */
export function parsePartAuditInput(markdown: string): AuditInputRow[] {
  const lines = contentLines(markdown);
  const out: AuditInputRow[] = [];
  const seen = new Set<string>();
  let excludedDepth: number | undefined;
  const add = (row: AuditInputRow): void => {
    row.query = plain(row.query).replace(/[.;]+$/, '').trim();
    if (row.mpn) row.mpn = row.query;
    if (!row.query || PLACEHOLDER.test(row.query)) return;
    const key = JSON.stringify([row.query.toUpperCase(), row.mpn?.toUpperCase(), row.refdes, row.requiredQuantity]);
    if (seen.has(key)) return;
    if (out.length >= 50) throw new AuditError('more than 50 part queries found; split the Markdown file into smaller lists');
    seen.add(key);
    out.push(row);
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (!raw) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      if (excludedDepth !== undefined && heading[1]!.length <= excludedDepth) excludedDepth = undefined;
      if (IGNORE_SECTION.test(heading[2]!)) excludedDepth = heading[1]!.length;
    }
    if (excludedDepth !== undefined) continue;

    if (raw.includes('|') && lines[i + 1]?.includes('|') && /^\s*\|?\s*:?-+:?\s*\|/.test(lines[i + 1]!)) {
      let end = i + 2;
      while (end < lines.length && lines[end]!.trim().includes('|')) end++;
      const table = parseNamedMarkdownTables(lines.slice(i, end).join('\n'))[0];
      if (table) {
        const headers = table.header.cells.map((value) => plain(value).toLowerCase().replace(/[\s_-]+/g, ' '));
        const col = (names: string[]) => headers.findIndex((value) => names.includes(value));
        const id = col(['mpn', 'manufacturer part number', 'manufacturer part no', 'part number', 'part no', 'lcsc', 'lcsc part number']);
        const name = col(['part', 'part name', 'component', 'component name', 'name', 'description', 'item', 'model']);
        const ref = col(['refdes', 'reference', 'designator']);
        const qty = col(['required qty', 'required quantity', 'qty', 'quantity']);
        const value = col(['value']);
        const pkg = col(['package', 'footprint']);
        if (id >= 0 || name >= 0 || value >= 0) {
          table.rows.forEach((row, index) => {
            const line = i + index + 3;
            const identifier = id < 0 ? '' : plain(row.cells[id] ?? '');
            const exact = identifier && !PLACEHOLDER.test(identifier) ? (headers[id]!.startsWith('lcsc') && /^\d+$/.test(identifier) ? `C${identifier}` : identifier) : undefined;
            const query = exact ?? [name, value, pkg].filter((c) => c >= 0).map((c) => row.cells[c] ?? '').filter((v) => !PLACEHOLDER.test(v)).join(' ');
            if (!query.trim()) throw new AuditError(`line ${line}: a part name or number is required`);
            add({ query, ...(exact ? { mpn: exact } : {}), line,
              ...(ref >= 0 && row.cells[ref]?.trim() ? { refdes: plain(row.cells[ref]!) } : {}),
              ...(qty >= 0 ? { requiredQuantity: quantity(row.cells[qty], line) } : {}),
            });
          });
        }
      }
      i = end - 1;
      continue;
    }
    if (raw.includes('|') || /^\[.*\]:|^---+$/.test(raw)) continue;
    let text = plain(raw.replace(/^#{1,6}\s+|^>\s*|^(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, ''));
    if (!text || /^(?:do not|don't|without|no|exclude|avoid)\b/i.test(text) || /^\s*\$?\s*(?:copperhead|npm|pnpm|git)\s/.test(text)) continue;
    const qtyMatch = /(?:\b(?:required qty|quantity|qty)\s*[:=]\s*([^\s;)]+)|\b(?:required qty|quantity|qty)\s+(-?[\d,.]+)|\(\s*([\d,.-]+)\s*(?:pcs?|pieces?)\s*\))/i.exec(text);
    const requiredQuantity = qtyMatch ? quantity(qtyMatch[1] ?? qtyMatch[2] ?? qtyMatch[3], i + 1) : undefined;
    if (qtyMatch) text = text.replace(qtyMatch[0], '').replace(/[,;\s]+$/, '').trim();
    const ref = /^([RCLDUJQYX]\d+)\s*[:=]\s*/i.exec(text);
    if (ref) text = text.slice(ref[0].length);
    const base = { line: i + 1, ...(ref ? { refdes: ref[1] } : {}), ...(requiredQuantity ? { requiredQuantity } : {}) };
    const explicit = /^(MPN|manufacturer part number|part number|part no|LCSC)\s*[:=]\s*(.+)$/i.exec(text);
    if (explicit) {
      const id = /^lcsc$/i.test(explicit[1]!) && /^\d+$/.test(explicit[2]!) ? `C${explicit[2]}` : explicit[2]!;
      add({ ...base, query: id, mpn: id });
      continue;
    }
    const named = /^(?:part|component|part name|component name)\s*[:=]\s*(.+)$/i.exec(text);
    if (named) { add({ ...base, query: named[1]! }); continue; }

    // A short part label can include an unfamiliar family or qualifier. Keep
    // it intact; the narrower noun extraction below is for surrounding prose.
    if (PART_WORD.test(text) && text.split(/\s+/).length <= 8 && !/[,:;.!?]/.test(text)
      && !/\b(?:use|uses|using|need|needs|add|include|includes|is|are|must|should|will|the|a|an|and|or|for|with|on|to|from|if)\b/i.test(text)) {
      add({ ...base, query: text });
      continue;
    }

    for (const sentence of text.split(/(?:[.!?](?:\s|$)|;|,(?!\d)|\s+and\s+|\s+or\s+)/i)) {
      const phrase = sentence.trim().replace(/^.*?\b(?:use|uses|using|need|needs|add|include|includes|contains?|provide|show|accept)\s+/i, '')
        .replace(/^(?:a|an|the)\s+/i, '').replace(/\s+(?:for|to|which|that)\s+.*$/i, '').trim();
      if (!phrase || /^(?:do not|don't|without|no|exclude|avoid)\b/i.test(phrase)) continue;
      const ids = identifiers(phrase);
      const names = descriptions(phrase);
      for (const name of names) add({ ...base, query: name });
      for (const id of ids) {
        if (!names.some((name) => name.includes(id))) add({ ...base, query: id });
      }
      // Unknown short names are accepted only as a complete line, never as a
      // fragment produced by splitting a sentence (e.g. "and a starting point").
      if (!names.length && !ids.length && phrase === text && !heading && !/\d/.test(phrase)
        && /[a-z]/i.test(phrase) && !/[.:!?/]/.test(phrase) && phrase.split(/\s+/).length <= 5
        && !/\b(?:is|are|must|should|will|board|budget|output|input|scope|notes|cost|voltage|current|overview|introduction|thanks|parts|requirements)\b/i.test(phrase)) {
        add({ ...base, query: phrase });
      }
    }
  }
  if (!out.length) throw new AuditError('no parts found: add a part name or number in a table, list, or text (for example "- ESP32 module" or "MPN: NE555P")');
  return out;
}
