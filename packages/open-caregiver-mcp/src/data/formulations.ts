// Pediatric formulation table. Values follow AAP / manufacturer labeling for
// OTC antipyretics. Demo software: have a clinician audit before real use.

export type Ingredient = "ibuprofen" | "acetaminophen";

export interface Formulation {
  key: string;
  ingredient: Ingredient;
  label: string;
  /** Concentration as mg per mL. */
  mgPerMl: number;
  /** Per-dose target in mg per kg of body weight. */
  mgPerKg: number;
  /** Absolute ceiling for a single dose, mg. */
  maxSingleMg: number;
  minIntervalHours: number;
  maxDosesPer24h: number;
  /** Minimum age in days. */
  minAgeDays: number;
  warning: string;
}

export const FORMULATIONS: Record<string, Formulation> = {
  "ibuprofen.infant_drops": {
    key: "ibuprofen.infant_drops",
    ingredient: "ibuprofen",
    label: "Infant Motrin Drops (50mg/1.25mL)",
    mgPerMl: 40,
    mgPerKg: 10,
    maxSingleMg: 400,
    minIntervalHours: 6,
    maxDosesPer24h: 4,
    minAgeDays: 182, // 6 months
    warning: "Based on Infant's Motrin Drops (50mg / 1.25mL). Do not use Children's suspension.",
  },
  "ibuprofen.children_susp": {
    key: "ibuprofen.children_susp",
    ingredient: "ibuprofen",
    label: "Children's Motrin Suspension (100mg/5mL)",
    mgPerMl: 20,
    mgPerKg: 10,
    maxSingleMg: 400,
    minIntervalHours: 6,
    maxDosesPer24h: 4,
    minAgeDays: 182,
    warning: "Based on Children's suspension (100mg / 5mL). Do not use Infant drops.",
  },
  "acetaminophen.infant_susp": {
    key: "acetaminophen.infant_susp",
    ingredient: "acetaminophen",
    label: "Infant Tylenol Suspension (160mg/5mL)",
    mgPerMl: 32,
    mgPerKg: 15,
    maxSingleMg: 480,
    minIntervalHours: 4,
    maxDosesPer24h: 5,
    minAgeDays: 0, // gated separately: fever < 12 weeks => seek care
    warning: "Based on Infant Tylenol Suspension (160mg / 5mL).",
  },
};

/** Any fever under this age must be seen by a clinician, not dosed at home. */
export const FEVER_SEEK_CARE_UNDER_DAYS = 84; // 12 weeks

export const SYRINGE_CAPACITY_ML = 5;
export const SYRINGE_STEP_ML = 0.25;
export const WEIGHT_BOUNDS_KG = { min: 2, max: 40 } as const;
export const LBS_TO_KG = 0.45359237;
