import {
  FEVER_SEEK_CARE_UNDER_DAYS,
  FORMULATIONS,
  LBS_TO_KG,
  SYRINGE_CAPACITY_ML,
  SYRINGE_STEP_ML,
  WEIGHT_BOUNDS_KG,
  type Formulation,
} from "../data/formulations.js";

export interface DoseInput {
  weightValue: number;
  weightUnit: "lbs" | "kg";
  ageDays: number;
  /** "ibuprofen.infant_drops" etc. */
  formulationKey: string;
  hasFever?: boolean;
}

export type DoseResult =
  | {
      status: "APPROVED";
      weightKg: number;
      targetDoseMg: number;
      deliveredDoseMg: number;
      dispenseVolumeMl: number;
      formulation: Formulation;
    }
  | { status: "SEEK_CARE" | "BLOCKED"; reason: string; weightKg?: number };

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

export function lbsToKg(lbs: number): number {
  return lbs * LBS_TO_KG;
}

/** Pure, deterministic. No clock, no I/O. Always rounds DOWN to the syringe mark. */
export function calculateDose(input: DoseInput): DoseResult {
  const f = FORMULATIONS[input.formulationKey];
  if (!f) return { status: "BLOCKED", reason: `Unknown formulation "${input.formulationKey}".` };

  if (!Number.isFinite(input.weightValue) || input.weightValue <= 0) {
    return { status: "BLOCKED", reason: "Weight must be a positive number." };
  }
  const kg = input.weightUnit === "kg" ? input.weightValue : lbsToKg(input.weightValue);
  if (kg < WEIGHT_BOUNDS_KG.min || kg > WEIGHT_BOUNDS_KG.max) {
    return {
      status: "BLOCKED",
      weightKg: round(kg, 2),
      reason: `Weight ${round(kg, 2)} kg is outside the supported range (${WEIGHT_BOUNDS_KG.min}-${WEIGHT_BOUNDS_KG.max} kg). Please re-check the weight.`,
    };
  }
  if (input.hasFever && input.ageDays < FEVER_SEEK_CARE_UNDER_DAYS) {
    return { status: "SEEK_CARE", weightKg: round(kg, 2), reason: "Fever in an infant under 12 weeks needs a clinician now. Do not dose at home." };
  }
  if (input.ageDays < f.minAgeDays) {
    return { status: "BLOCKED", weightKg: round(kg, 2), reason: `${f.ingredient} is not approved under ${Math.round(f.minAgeDays / 30.4)} months of age.` };
  }

  const targetMg = Math.min(kg * f.mgPerKg, f.maxSingleMg);
  const rawMl = targetMg / f.mgPerMl;
  // Integer quarter-mL units avoid float drift; epsilon guards exact boundaries.
  const quarters = Math.floor(rawMl / SYRINGE_STEP_ML + 1e-9);
  const ml = quarters * SYRINGE_STEP_ML;

  if (ml < SYRINGE_STEP_ML) {
    return { status: "SEEK_CARE", weightKg: round(kg, 2), reason: "Calculated dose is below the smallest syringe mark. Ask a pharmacist or clinician." };
  }
  if (ml > SYRINGE_CAPACITY_ML) {
    return { status: "BLOCKED", weightKg: round(kg, 2), reason: `Dose of ${ml} mL exceeds the ${SYRINGE_CAPACITY_ML} mL syringe. Use a different formulation.` };
  }

  return {
    status: "APPROVED",
    weightKg: round(kg, 2),
    targetDoseMg: round(targetMg, 2),
    deliveredDoseMg: round(ml * f.mgPerMl, 2),
    dispenseVolumeMl: ml,
    formulation: f,
  };
}
