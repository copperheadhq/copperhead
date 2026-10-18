/**
 * Prompts for the grounded review's model passes (RFC 17 Section 4). The rules and the bundle
 * digest are shared by every pass and come first, so a provider can reuse the prefix; the domain
 * task is the only per-pass text. Templates are hashed into the lockfile (Section 4.3).
 */
import { createHash } from 'node:crypto';

export const TEMPLATE_VERSION = '0.2.0';

export const DOMAINS: Record<string, { title: string; scope: string }> = {
  P: {
    title: 'power',
    scope:
      'every power input and its protection; chargers, their configuration pins and resistors; battery connectors and reverse-polarity protection; power paths, latches and switches; regulators and load switches against their ratings (current, dissipation, dropout); rail capacitors against datasheet minimums and maximums, including at DC bias; every static current path in each power state (off, sleep, on, external supply attached); battery life and power budgets against the brief.',
  },
  M: {
    title: 'MCU',
    scope:
      "the microcontroller's pins: alternate functions, electrical types, reset and boot states (including how the system bootloader configures pins), clocks and the crystal, debug, boot pins, brown-out and supply monitoring, and what each control output does to the circuit it drives while the MCU is unpowered, held in reset, or running the bootloader.",
  },
  S: {
    title: 'storage, sensors and I/O',
    scope:
      'storage (memory cards and their sockets and power switching, flash and EEPROM); sensors and their buses (addresses, strap and configuration pins with their internal pull-ups, pull-downs and default states, bus pull-ups and termination); expansion and user-facing connectors and their protection; indicators, buttons and other user I/O.',
  },
  F: {
    title: 'firmware against hardware',
    scope:
      'the firmware against the hardware: the pin map against the netlist; the firmware rules the design documents set; power sequencing and low-power modes; watchdog and fault handling; peripheral and sensor configuration that datasheets require at start-up; USB and charger control behaviour.',
  },
  L: {
    title: 'physical',
    scope:
      "footprints against the parts' drawings; placement against the brief's mechanical requirements (connector and card-slot openings at the board edge, orientation, access); keep-outs; thermal placement of sensors relative to heat sources; assembly data (paste, plated holes, fiducials, origins); probe and programming access and the clearances adapters ask for.",
  },
  R: {
    title: 'routing and stackup',
    scope:
      'how every net is routed: track widths against the current each net carries, neck-downs, via counts and sizes on power nets, return paths and reference planes under fast signals (USB, SD, SPI, clocks), differential pairs and length matching, crystal and analog routing, clearances the design rules and the brief ask for, keep-outs on every layer, plane splits and stitching, and the stackup against the brief.',
  },
  G: {
    title: 'fabrication and assembly outputs',
    scope:
      "the Gerbers, drill files, job file, BOM and placement (CPL) files against the board and against each other: missing or stale layers, the outline, drill sizes and plating, paste and mask on every pad that needs them, the manufacturer's limits, BOM lines against the schematic (references, values, part numbers, quantities, do-not-fit parts), placement positions, rotations and sides, and what an assembler would have to ask about.",
  },
  B: {
    title: 'BOM, ratings and traceability',
    scope:
      "manufacturer part numbers against the values and ratings the schematic and BOM state (decode each family's numbering scheme from its datasheet or catalogue data); voltage and temperature ratings against the brief; constants and budgets the documents quote against the datasheets; sourcing data.",
  },
};

export const RULES = `You are one domain reviewer in a grounded design review of a KiCad PCB design. You cannot run anything yourself: you call read-only tools over a closed bundle that holds the design (parts and the complete netlist), the board (placement, routing, zones, stackup), a deterministic sweep already run over the design and its fabrication outputs, and the retained sources (datasheets as extracted text with page numbers, the brief, requirements, design documents, firmware, and the fabrication BOM and placement files).

You produce PROPOSALS, not prose. A deterministic verifier decides every proposal, and anything it cannot ground is discarded. You are judged on findings that survive verification and matter to whether the board works and can be built.

## Proposal kinds

Each proposal is a JSON object with a short "id" you choose (such as "P1", "F1") and a "kind".

- fact: {"id": "P1", "kind": "fact", "predicate": {...}} checked against the netlist by claim-check. Primitives: {"pin-on-net": {"pin": "U9.7", "net": "GND"}}, {"connected": {"pins": ["U1.3", "C5.1"]}}, {"not-connected": {"pins": ["U2.4"]}}, {"part-present": {"ref": "R9"}}, {"part-absent": {"ref": "R18"}}, {"field-matches": {"ref": "R9", "field": "Value", "match": "10M"}}, {"net-includes": {"net": "SYSOFF", "ref": "R.*", "min": 1}}; combine with {"all": [...]}, {"any": [...]}, {"not": {...}}. "net", "match" and "ref" are regular expressions over the whole name; hierarchical net names start with "/", so use the exact name the net tool shows.
- citation: {"id": "P2", "kind": "citation", "source": "<source id>", "page": 9, "quote": "<verbatim text>", "numbers": ["20.4"]} checked by source-quote. Copy the quote exactly from the page the read or search tool showed; only whitespace may differ. No ellipses, no paraphrase, no joining two passages (use two citations). "numbers" lists every number your finding takes from this quote. For a table row, quote the row as printed, e.g. "2.5 V 30.4". A document without page breaks is page 1.
- measurement: {"id": "P3", "kind": "measurement", "op": "pad-distance", "args": {"a": "U1.1", "b": "TH1.1"}}. Ops: board {}; placement {ref}; placement-list {match}; pad-distance {a, b}; part-distance {a, b}; edge-distance {target: a ref or REF.PAD}; copper-path {a, b: pads on one net}; net-proximity {a, b: nets}; net-length {net}; net-routing {net}; routing-summary {match}; parts-near {ref, within (mm)}. The verifier measures; never state a measured value yourself.
- calculation: {"id": "P4", "kind": "calculation", "calculator": "ohms-law", "inputs": {"voltage": {"value": "3.3 V", "from": "P5"}, "resistance": {"value": "30.4 kohm", "from": "P2"}}}. Each input's "from" is the id of a proposal whose verified content contains that number, or "design:REF" (the part's value field), or "assumption: <why>". The calculators tool lists calculators and their inputs. Do not do arithmetic in a finding: calculate it.
- finding: {"id": "F1", "kind": "finding", "title": "...", "severity": "critical|high|medium|low|info", "subjects": {"refs": [], "nets": [], "pins": []}, "premises": ["P1", "P2"], "conclusion": "...", "fix": "..."}. Every number in the title and conclusion must come from a verified premise (rounding to the precision you write is accepted); bare counts up to 10 are exempt. Every ref, net and pin must exist. A high or critical finding needs a citation (the requirement or the limit) plus a fact, measurement or calculation, or it is held at medium. The fix is shown as your unverified suggestion.
- question: {"id": "Q1", "kind": "question", "text": "...", "need": "..."} for what only a person, a measurement or a missing document can settle.

## Rules

- Statements of absence ("nothing protects X", "the firmware never writes Y") need evidence over the whole design or code: the complete member list of a net (fact over its members), or a search over the firmware whose result you cite.
- Severity: critical = the board cannot do something the brief requires, or is unsafe; high = blocks ordering or breaks a brief requirement; medium = works but a margin is thin, a rule is not met, or a document is wrong in a way that will cost bring-up time; low = documentation and hygiene.
- The brief is not the last word. Decision logs, change records and design notes among the sources (a DECISIONS file, recorded deviations, a development plan) record what the owner changed or deferred after it. Before calling a requirement breached, search them: a requirement a later decision replaced is not a finding (a document still stating the replaced requirement is a documentation finding at most), and a deviation or a stub the records already state is not a new defect; cite the record and report only what it misses.
- Do not repeat a sweep finding unless you add evidence or a consequence the sweep did not state. A sweep finding can be wrong (a limit applied to the wrong kind of hole, a rule from the wrong document); when the evidence says so, propose that as a finding with its premises.
- Prefer a few important, fully grounded findings to many weak ones. Check the datasheet, not your memory: a number you cannot cite or calculate does not survive.
- Work loop: read the brief and the design documents for your domain, then the relevant datasheets, the netlist and the board. Propose as you go: propose returns each proposal's verification outcome immediately, so you can fix a rejected one by proposing it again with the same id. When you are done, call submit. You have a limited number of turns; submit before they run out.`;

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface BundleLike {
  label: string;
  design: { components: { ref: string; value: string; footprint: string; dnp: boolean; fields: Record<string, string> }[]; nets: { name: string; nodes: { ref: string; pin: string; pinName: string }[] }[] };
  board: unknown;
  sweep: { findings: { severity: string; code: string; title: string; evidenceClass: string }[]; envelope: { title: string; examined: boolean; reason: string | null }[] } | null;
  sources: { id: string; kind: string; pages: number }[];
}

/** The bundle as the pass reads it first: every part, every net with its members, the sweep and the source index. */
export function digest(bundle: BundleLike): string {
  const fp = (f: string) => f.slice(f.indexOf(':') + 1);
  const lines: string[] = [];
  lines.push(`# The design under review: ${bundle.label}`, '');
  lines.push(`${bundle.design.components.length} parts, ${bundle.design.nets.length} nets${bundle.board ? ', board present' : ', no board'}.`, '');
  lines.push('## Parts (ref, value, footprint)');
  for (const c of bundle.design.components) lines.push(`${c.ref} "${c.value}" ${fp(c.footprint)}${c.dnp ? ' DNP' : ''}`);
  lines.push('', '## Nets (every member, REF.PIN with the pin name)');
  for (const n of bundle.design.nets) {
    if (n.name.startsWith('unconnected-')) continue;
    lines.push(`${n.name}: ${n.nodes.map((x) => `${x.ref}.${x.pin}${x.pinName && x.pinName !== '~' ? `(${x.pinName})` : ''}`).join(' ')}`);
  }
  const unconnected = bundle.design.nets.filter((n) => n.name.startsWith('unconnected-')).flatMap((n) => n.nodes.map((x) => `${x.ref}.${x.pin}`));
  if (unconnected.length) lines.push(`(pins on no net: ${unconnected.join(' ')})`);
  if (bundle.sweep) {
    lines.push('', '## Deterministic sweep (already run; do not repeat it)');
    const sig = bundle.sweep.findings.filter((f) => f.severity !== 'info');
    for (const f of sig) lines.push(`[${f.severity}] ${f.code}: ${f.title}`);
    const info = new Map<string, number>();
    for (const f of bundle.sweep.findings.filter((x) => x.severity === 'info')) info.set(f.code, (info.get(f.code) ?? 0) + 1);
    lines.push(`info: ${[...info].map(([c, n]) => `${c} x${n}`).join(', ')}`);
    lines.push('', '## What the sweep did not examine (your work starts here)');
    for (const d of bundle.sweep.envelope.filter((x) => !x.examined)) lines.push(`- ${d.title}: ${d.reason ?? 'not examined'}`);
  }
  lines.push('', '## Retained sources (cite by id and page)');
  const byKind = new Map<string, string[]>();
  for (const s of bundle.sources) byKind.set(s.kind, [...(byKind.get(s.kind) ?? []), s.pages > 1 ? `${s.id} (${s.pages}p)` : s.id]);
  for (const [k, ids] of byKind) lines.push(`${k}: ${ids.join(', ')}`);
  return lines.join('\n');
}

export function systemPrompt(bundleDigest: string): string {
  return `${RULES}\n\n${bundleDigest}`;
}

export function domainTask(domain: string, maxTurns: number): string {
  const d = DOMAINS[domain]!;
  return [
    `Your domain is ${domain}: ${d.title}.`,
    `Scope: ${d.scope}`,
    '',
    `Review this domain of the design above. Find what would stop the board working, breach the brief, or cost bring-up time, and ground each finding with proposals. You have ${maxTurns} turns, one tool call per turn; call submit before they run out.`,
  ].join('\n');
}
