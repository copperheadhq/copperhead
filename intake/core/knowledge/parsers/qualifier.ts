/**
 * Qualifier parser (SPEC §8): MIN / TYP / MAX / NOM / ABS_MAX from column
 * headers or explicit labels. Unrecognized → undefined (QUALIFIER_MISSING
 * routes to review; never guessed).
 */

import type { Qualifier } from "../types";

const QUALIFIER_LABELS: Record<string, Qualifier> = {
  MIN: "MIN",
  MINIMUM: "MIN",
  TYP: "TYP",
  TYPICAL: "TYP",
  MAX: "MAX",
  MAXIMUM: "MAX",
  NOM: "NOM",
  NOMINAL: "NOM",
  "ABS MAX": "ABS_MAX",
  ABS_MAX: "ABS_MAX",
  "ABSOLUTE MAX": "ABS_MAX",
  "ABSOLUTE MAXIMUM": "ABS_MAX",
};

export function parseQualifier(label: string): Qualifier | undefined {
  const key = label.trim().toUpperCase().replace(/\.$/, "").replace(/\s+/g, " ");
  return QUALIFIER_LABELS[key];
}
