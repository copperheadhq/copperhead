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
 * Whitespace is irrelevant; unknown bodies and edited copies fail closed.
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
  return candidates.some((candidate) =>
    candidate.libId === libId &&
    JSON.stringify(parseSexp(renameSymbolBlock(candidate.sourceText, candidate.libId))[0]) === JSON.stringify(symbol),
  );
}
