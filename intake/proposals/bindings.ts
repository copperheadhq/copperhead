// Proposing circuit-block roles (add-binding-proposals; Copperhead RFC 17 Section 3.1: the model
// proposes, a verifier decides). The model sees only the context bundles copperhead-tools' block-map
// emits (each part's pins, nets and the parts on them) and answers with roles naming parts from those
// bundles. block-map checks every named part against the nets its role requires before using it, so a
// wrong proposal is refused, never applied. Pure: no I/O, no SDK.

export const PROPOSER_VERSION = "bindings-proposer-1";

export const KINDS = ["buck", "boost", "buck-boost", "ldo", "load-switch", "none"] as const;
export const ROLES = [
  "input-capacitor",
  "output-capacitor",
  "inductor",
  "bootstrap-capacitor",
  "feedback-top",
  "feedback-bottom",
  "feedforward-capacitor",
  "soft-start-capacitor",
  "power-good-pull-up",
  "catch-diode",
  "output-diode",
  "bias-capacitor",
] as const;

export interface ContextPart {
  ref: string;
  value: string;
  part: string;
  sheet: string;
  kind: string | null;
  otherNet?: string;
  dnp: boolean;
}

export interface ContextBundle {
  ref: string;
  value: string;
  library: string;
  part: string;
  sheet: string;
  pins: { pin: string; name: string; type: string; net: string; ground: boolean; parts: ContextPart[] }[];
  reach: { net: string; via: string[]; parts: ContextPart[] }[];
}

export interface ProposedBlock {
  anchor: string;
  kind: (typeof KINDS)[number];
  roles: Partial<Record<(typeof ROLES)[number], string[]>>;
  why: string;
}

const ROLE_GUIDE = [
  "input-capacitor: capacitor between the regulator's input net (VIN/IN/VI pin) and ground, on the regulator's schematic sheet",
  "output-capacitor: capacitor between the block's output net and ground, on the regulator's sheet. Output net: a buck's net on the far side of the inductor from SW; an LDO's or load switch's OUT pin net; a boost's VOUT pin net or, without one, the net after its output diode",
  "inductor: inductor with a terminal on the SW/LX net (a boost's runs from the input to SW)",
  "bootstrap-capacitor: capacitor between the BST/BOOT/BS/CB pin's net and the SW net (possibly through a small series resistor)",
  "feedback-top: resistor between the FB/ADJ net and the output side; feedback-bottom: resistor between the FB/ADJ net and ground. Both empty for a fixed output whose FB is tied to the output",
  "feedforward-capacitor: capacitor between the output net and the FB net",
  "soft-start-capacitor: capacitor between the SS pin's net and ground",
  "power-good-pull-up: resistor between the PG net and a rail",
  "catch-diode: diode between SW and ground (non-synchronous buck); output-diode: diode between SW and the output (non-synchronous boost)",
  "bias-capacitor: capacitor between a bias, bypass or noise-reduction pin (BP, NR, VCC bias) and ground",
];

/** The prompt for one board's bundles. Deterministic: the same bundles give the same prompt. */
export function buildPrompt(bundles: ContextBundle[]): string {
  return [
    "You identify voltage-regulator blocks on a KiCad design from its netlist context.",
    "For each part below, say whether it is a voltage regulator, DC-DC converter or load switch, which kind, and which listed parts fill each role.",
    `Kinds: ${KINDS.join(", ")} (none for a part that is not one).`,
    "Roles:",
    ...ROLE_GUIDE.map((r) => `- ${r}`),
    "Rules: name only parts listed in that part's context; never a part marked dnp; leave a role out when no listed part fills it; give a one-sentence reason per block.",
    "",
    "Context bundles (JSON):",
    JSON.stringify(bundles),
    "",
    'Respond with ONLY a JSON object: { "blocks": [ { "anchor": string, "kind": string, "roles": { [role: string]: string[] }, "why": string } ] }. No prose, no markdown fences.',
  ].join("\n");
}

/**
 * The model's reply as proposed blocks: only anchors that were asked about, only known kinds and roles,
 * only parts the anchor's bundle lists. Anything else is dropped and counted; the verifier in block-map
 * still checks what remains.
 */
export function parseProposal(reply: unknown, bundles: ContextBundle[]): { blocks: ProposedBlock[]; dropped: string[] } {
  const dropped: string[] = [];
  const raw = (reply as { blocks?: unknown })?.blocks;
  if (!Array.isArray(raw)) return { blocks: [], dropped: ["the reply has no blocks list"] };
  const byRef = new Map(bundles.map((b) => [b.ref, b]));
  const blocks: ProposedBlock[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    const anchor = String(item?.anchor ?? "");
    const bundle = byRef.get(anchor);
    if (!bundle) {
      dropped.push(`block for ${anchor || "(no anchor)"}: not a part that was asked about`);
      continue;
    }
    const kind = String(item.kind ?? "");
    if (!(KINDS as readonly string[]).includes(kind)) {
      dropped.push(`${anchor}: unknown kind ${JSON.stringify(kind)}`);
      continue;
    }
    const listed = new Set([...bundle.pins.flatMap((p) => p.parts), ...bundle.reach.flatMap((r) => r.parts)].filter((p) => !p.dnp).map((p) => p.ref));
    const roles: ProposedBlock["roles"] = {};
    for (const [role, refs] of Object.entries((item.roles as Record<string, unknown>) ?? {})) {
      if (!(ROLES as readonly string[]).includes(role)) {
        dropped.push(`${anchor}: unknown role ${JSON.stringify(role)}`);
        continue;
      }
      const kept = (Array.isArray(refs) ? refs : []).map(String).filter((r) => {
        if (listed.has(r)) return true;
        dropped.push(`${anchor} ${role}: ${r} is not a fitted part in its context`);
        return false;
      });
      if (kept.length) roles[role as (typeof ROLES)[number]] = [...new Set(kept)].sort();
    }
    blocks.push({ anchor, kind: kind as ProposedBlock["kind"], roles: kind === "none" ? {} : roles, why: String(item.why ?? "") });
  }
  return { blocks, dropped };
}
