import { parseSexp, children, type SexpNode } from './sexp.js';
import { renameSymbolBlock } from './emit.js';

/**
 * The symbol-name token a power-class net's generated symbol lives under
 * (`copperhead_power:<token>`), which is also what its vendored file is named
 * from. Two nets that sanitize to one token would share one `lib_id` and one
 * embedded pin name, quietly merging their rails in KiCad's netlist —
 * `validateIntent` refuses that pair using this same function, so the collision
 * dies as a numbered finding instead.
 */
export const powerNetToken = (net: string): string => net.replace(/[^A-Za-z0-9_+.-]/g, '_');

/** Escape a string for embedding inside a quoted s-expression atom. Defense in
 * depth: `validateIntent` already refuses net names containing `"` or `\`, but
 * this template must not be able to corrupt a schematic even if called raw. */
const sexpQuote = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Engine-authored power-port and PWR_FLAG symbols (design D6a). Authored here,
 * not copied from a library: the engine must be able to satisfy ERC's
 * undriven-rail check on any machine without depending on the installed power
 * library's naming. Pin at the origin; the body draws above (rail) or below
 * (ground) it.
 */
export function powerSymbolSource(rawNet: string, kind: 'rail' | 'ground'): { libId: string; sourceText: string } {
  const net = sexpQuote(rawNet);
  const name = powerNetToken(rawNet);
  const libId = `copperhead_power:${name}`;
  // Symbol space is Y-up and the schematic transform flips it: negative-Y
  // graphics here render BELOW the connection point on the sheet. A ground
  // hangs below its pin (angle 270 = line toward -Y body) as a stem and an
  // open triangle, the reference-ground glyph; a rail rises above (angle 90)
  // as a stem and a filled arrowhead, the way KiCad's own +3V3 draws. Both
  // reach 2.54 from the pin, inside the 2-unit box the engine reserves.
  const body =
    kind === 'ground'
      ? `\t(symbol "${name}_0_1"
\t\t(polyline (pts (xy 0 0) (xy 0 -1.27)) (stroke (width 0.254) (type default)) (fill (type none)))
\t\t(polyline (pts (xy -1.27 -1.27) (xy 1.27 -1.27) (xy 0 -2.54) (xy -1.27 -1.27)) (stroke (width 0.254) (type default)) (fill (type none)))
\t)
\t(symbol "${name}_1_1"
\t\t(pin power_in line (at 0 0 270) (length 0) hide
\t\t\t(name "${net}" (effects (font (size 1.27 1.27))))
\t\t\t(number "1" (effects (font (size 1.27 1.27))))
\t\t)
\t)`
      : `\t(symbol "${name}_0_1"
\t\t(polyline (pts (xy 0 0) (xy 0 1.27)) (stroke (width 0.254) (type default)) (fill (type none)))
\t\t(polyline (pts (xy -0.762 1.27) (xy 0 2.54) (xy 0.762 1.27) (xy -0.762 1.27)) (stroke (width 0.254) (type default)) (fill (type outline)))
\t)
\t(symbol "${name}_1_1"
\t\t(pin power_in line (at 0 0 90) (length 0) hide
\t\t\t(name "${net}" (effects (font (size 1.27 1.27))))
\t\t\t(number "1" (effects (font (size 1.27 1.27))))
\t\t)
\t)`;
  const sourceText = `(symbol "${name}"
\t(power)
\t(pin_names (offset 0))
\t(exclude_from_sim yes)
\t(in_bom no)
\t(on_board no)
\t(property "Reference" "#PWR" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
\t(property "Value" "${net}" (at 0 ${kind === 'ground' ? '-3.556' : '3.556'} 0) (effects (font (size 1.27 1.27)) hide))
${body}
)`;
  return { libId, sourceText };
}

export function pwrFlagSource(): { libId: string; sourceText: string } {
  const libId = 'copperhead_power:PWR_FLAG';
  const sourceText = `(symbol "PWR_FLAG"
\t(power)
\t(pin_names (offset 0))
\t(exclude_from_sim yes)
\t(in_bom no)
\t(on_board no)
\t(property "Reference" "#FLG" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
\t(property "Value" "PWR_FLAG" (at 0 -3.556 0) (effects (font (size 1.27 1.27)) hide))
\t(symbol "PWR_FLAG_0_1"
\t\t(polyline (pts (xy 0 1.27) (xy -1.016 1.905) (xy 0 2.54) (xy 1.016 1.905) (xy 0 1.27)) (stroke (width 0.254) (type default)) (fill (type none)))
\t)
\t(symbol "PWR_FLAG_1_1"
\t\t(pin power_out line (at 0 0 90) (length 0) hide
\t\t\t(name "pwr" (effects (font (size 1.27 1.27))))
\t\t\t(number "1" (effects (font (size 1.27 1.27))))
\t\t)
\t)
)`;
  return { libId, sourceText };
}

/**
 * A reserved name is not proof that a symbol is engine-generated. Compare its
 * entire parsed definition with the very templates used by the emitter: power
 * flags, metadata, one pin, its electrical type/name/number, and geometry.
 * Known KiCad save defaults and child ordering are irrelevant; unknown bodies
 * and edited electrical definitions fail closed. Known historical graphics
 * remain supported without accepting arbitrary bodies under a reserved name.
 */
export function matchesGeneratedPowerSymbol(symbol: SexpNode[]): boolean {
  const libId = symbol[1];
  if (typeof libId !== 'string' || !libId.startsWith('copperhead_power:')) return false;
  const value = children(symbol, 'property').find((p) => p[1] === 'Value')?.[2];
  if (typeof value !== 'string' || !value) return false;
  // PWR_FLAG is reserved for the synthesized driver, never a renamed rail.
  const candidates = libId === 'copperhead_power:PWR_FLAG'
    ? [pwrFlagSource()]
    : [powerSymbolSource(value, 'rail'), powerSymbolSource(value, 'ground')];
  return candidates.some((candidate) => {
    if (candidate.libId !== libId) return false;
    const expected = parseSexp(renameSymbolBlock(candidate.sourceText, candidate.libId))[0] as SexpNode[];
    const variants = [expected];
    if (libId !== 'copperhead_power:PWR_FLAG') variants.push(legacyPowerGraphics(expected));
    return variants.some(v => JSON.stringify(normalizePowerDefinition(v)) === JSON.stringify(normalizePowerDefinition(symbol)));
  });
}

/** Normalize only observed nonsemantic KiCad9/10 save defaults, read-only. */
function normalizePowerDefinition(node: SexpNode): SexpNode {
  if (!Array.isArray(node)) return node;
  const tag = node[0];
  if (tag === 'power' && node.length === 2 && node[1] === 'global') return ['power'];
  const result: SexpNode[] = [];
  let hiddenInEffects = false;
  for (const item of node) {
    if (Array.isArray(item)) {
      if ((item[0] === 'in_pos_files' && item[1] === 'yes') ||
          (item[0] === 'duplicate_pin_numbers_are_jumpers' && item[1] === 'no') ||
          (item[0] === 'embedded_fonts' && item[1] === 'no') ||
          (tag === 'property' && ['show_name', 'do_not_autoplace'].includes(String(item[0])) && item[1] === 'no')) continue;
      if (item[0] === 'property' && ['Footprint', 'Datasheet', 'Description'].includes(String(item[1])) && item[2] === '') continue;
      if (tag === 'property' && item[0] === 'effects' && item.includes('hide')) {
        hiddenInEffects = true;
        result.push(normalizePowerDefinition(item.filter(v => v !== 'hide')));
        continue;
      }
    }
    result.push(item === 'hide' && ['pin', 'effects'].includes(String(tag)) ? ['hide', 'yes'] : normalizePowerDefinition(item));
  }
  if (hiddenInEffects) result.push(['hide', 'yes']);
  // Keep points and positional atoms ordered; only unordered attribute/shape
  // collections are sorted. Full geometry and pin metadata remain compared.
  if (['symbol', 'property', 'effects', 'font', 'pin', 'stroke', 'fill'].includes(String(tag))) {
    const atoms = result.filter(v => !Array.isArray(v));
    const lists = result.filter(Array.isArray).sort((a,b) => {
      const x=JSON.stringify(a), y=JSON.stringify(b); return x<y?-1:x>y?1:0;
    });
    return [...atoms,...lists];
  }
  return result;
}

/** Exact pre-71c10ed graphics; electrical metadata is the current same source. */
function legacyPowerGraphics(expected: SexpNode[]): SexpNode[] {
  const name=String(expected[1]).replace(/^copperhead_power:/,'');
  const pin = children(expected,'symbol').flatMap(s => children(s,'pin'))[0]!;
  const ground = children(pin,'at')[0]?.[3] === '270';
  const points = ground
    ? [[-1.27,-1.27,1.27,-1.27],[-0.762,-1.778,0.762,-1.778],[-0.254,-2.286,0.254,-2.286]]
    : [[-1.27,1.27,1.27,1.27]];
  const graphics = parseSexp(`(symbol "${name}_0_1" ${points.map(([x,y,u,v]) =>
    `(polyline (pts (xy ${x} ${y}) (xy ${u} ${v})) (stroke (width 0.254) (type default)) (fill (type none)))`).join(' ')})`)[0];
  return expected.map(v => Array.isArray(v) && v[0] === 'symbol' && v[1] === `${name}_0_1` ? graphics! : v);
}
