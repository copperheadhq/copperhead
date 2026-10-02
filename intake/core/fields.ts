// Field requests (ground-intake-extraction D5): what the extractor is asked for, with the
// dimension and conditions each parameter needs. Pure.

import type { ConditionField } from "./knowledge/validators/candidate";

export interface FieldSpec {
  /** Canonical parameter key, e.g. "pin_input_leakage_uA". */
  key: string;
  /** What to look for, as the extractor is told. */
  description: string;
  /** The cortex dimension family the value must have (voltage, current, resistance, ...). */
  dimension: string;
  /** Conditions a reading of this parameter must state. */
  requiredConditions: ConditionField[];
}

export const DEFAULT_FIELD_SPECS: FieldSpec[] = [
  {
    key: "supply_voltage_V",
    description:
      "supply or operating voltage range from the recommended operating conditions or electrical characteristics; report the MIN and the MAX as two separate entries",
    dimension: "voltage",
    requiredConditions: [],
  },
  {
    key: "quiescent_current_uA",
    description: "quiescent or supply current drawn by the part",
    dimension: "current",
    requiredConditions: [],
  },
  {
    key: "pin_input_leakage_uA",
    description: "input leakage current of an input pin (high-level or low-level input current)",
    dimension: "current",
    requiredConditions: [],
  },
  {
    key: "abs_max_vin_V",
    description:
      "absolute maximum supply or input voltage rating, from the absolute maximum ratings table (qualifier ABS_MAX)",
    dimension: "voltage",
    requiredConditions: [],
  },
  {
    key: "recommended_pullup_ohm",
    description: "pull-up resistance, internal or recommended external",
    dimension: "resistance",
    requiredConditions: [],
  },
];

export function specFor(key: string, specs: FieldSpec[] = DEFAULT_FIELD_SPECS): FieldSpec | undefined {
  return specs.find((s) => s.key === key);
}
