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

/**
 * The facts a part pack holds for a regulator (add-part-pack-export), as extraction requests. Each key
 * maps to a part-pack parameter in core/pack.ts.
 */
export const PACK_FIELD_SPECS: FieldSpec[] = [
  DEFAULT_FIELD_SPECS[0] as FieldSpec,
  DEFAULT_FIELD_SPECS[1] as FieldSpec,
  DEFAULT_FIELD_SPECS[3] as FieldSpec,
  {
    key: "feedback_voltage_V",
    description: "feedback (FB) reference or regulation voltage of an adjustable regulator, from the electrical characteristics; report MIN, TYP and MAX as separate entries",
    dimension: "voltage",
    requiredConditions: [],
  },
  {
    key: "output_voltage_V",
    description: "output voltage of a fixed-output regulator option, from the electrical characteristics; report MIN, TYP and MAX as separate entries",
    dimension: "voltage",
    requiredConditions: [],
  },
  {
    key: "output_current_A",
    description: "rated (maximum continuous) output current",
    dimension: "current",
    requiredConditions: [],
  },
  {
    key: "current_limit_A",
    description: "switch, peak or valley current limit of a converter, or the current limit of a regulator",
    dimension: "current",
    requiredConditions: [],
  },
  {
    key: "switching_frequency_Hz",
    description: "switching frequency of a converter",
    dimension: "frequency",
    requiredConditions: [],
  },
  {
    key: "dropout_voltage_V",
    description: "dropout voltage of a linear regulator, with its load-current condition",
    dimension: "voltage",
    requiredConditions: [],
  },
  {
    key: "enable_threshold_V",
    description: "enable pin rising threshold or logic-high input voltage",
    dimension: "voltage",
    requiredConditions: [],
  },
  {
    key: "junction_temperature_max_C",
    description: "maximum operating junction temperature from the recommended operating conditions",
    dimension: "temperature",
    requiredConditions: [],
  },
];

export function specFor(key: string, specs: FieldSpec[] = DEFAULT_FIELD_SPECS): FieldSpec | undefined {
  return specs.find((s) => s.key === key);
}
