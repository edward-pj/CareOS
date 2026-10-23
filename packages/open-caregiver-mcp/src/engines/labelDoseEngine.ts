import type { LabelBand, LiquidSku, SolidSku } from "../data/labelRegistry.js";

// Label-first pediatric dosing (PRD §4.2). The product's own printed chart is the dosing source; mg/kg is only an
// INDEPENDENT cross-check that must agree (S5). Pure and deterministic: no clock, no I/O, no model.

export const LB_PER_KG_FACTOR = 0.45359237; // kg per lb
export const lbToKg = (lb: number) => lb * LB_PER_KG_FACTOR;
export const kgToLb = (kg: number) => kg / LB_PER_KG_FACTOR;

/** Floating-point noise must never move a boundary weight into a neighbouring band. */
const EPS = 1e-6;
/** Weights are compared to the label's printed bands at this precision (lb). */
const roundWeight = (lb: number) => Math.round(lb * 10_000) / 10_000;

export type LabelReason =
  | "UNDER_LABEL_MIN_AGE"
  | "BELOW_LABEL_WEIGHT"
  | "ABOVE_LABEL_TABLE"
  | "CROSS_CHECK_FAILED"
  | "DOSE_NOT_ON_DEVICE_MARK"
  | "UNDER_LABEL_MIN_AGE_YEARS";

export type LabelDoseResult =
  | {
      status: "APPROVED";
      doseMl: number;
      doseMg: number;
      weightLb: number;
      weightKg: number;
      /** mg/kg of the label dose: the S5 cross-check value. */
      mgPerKg: number;
      band: LabelBand;
      /** Informational reason codes, e.g. LABEL_BAND_18_23LB, MG_PER_KG_OK, AGE_WEIGHT_MISMATCH, LABEL_GAP_LOWER_BAND_USED. */
      codes: string[];
      /** The label has a gap at this weight; the caller must tell the user to ask the pediatrician. */
      gap: boolean;
      /** Age on the label row differs from the child's age: weight governs but it is flagged. */
      ageWeightMismatch: boolean;
    }
  | { status: "NEEDS_CLINICIAN"; reason: LabelReason; detail: string; codes: string[]; weightKg?: number };

export interface LabelDoseInput {
  sku: LiquidSku;
  weightLb: number;
  /** Whole months of age (floor). */
  ageMonths: number;
}

const bandCode = (b: LabelBand) => `LABEL_BAND_${b.minLb}_${b.maxLb}LB`;

/** Which printed row applies to a weight? Never rounds up into a higher band. */
export function findBand(sku: LiquidSku, weightLb: number): { band: LabelBand; gap: boolean } | { band: undefined; where: "below" | "above" } {
  const w = roundWeight(weightLb);
  if (w < sku.askDoctorBelowLb - EPS) return { band: undefined, where: "below" };
  const bands = [...sku.bands].sort((a, b) => a.minLb - b.minLb);
  const inside = bands.find((b) => w >= b.minLb - EPS && w <= b.maxLb + EPS);
  if (inside) return { band: inside, gap: false };
  const last = bands[bands.length - 1]!;
  if (w > last.maxLb + EPS) return { band: undefined, where: "above" };
  // Between two printed rows (e.g. 17.5 lb with rows 12-17 and 18-23): the LOWER row applies.
  const lower = [...bands].reverse().find((b) => b.maxLb < w);
  if (!lower) return { band: undefined, where: "below" };
  return { band: lower, gap: true };
}

export function labelDose({ sku, weightLb, ageMonths }: LabelDoseInput): LabelDoseResult {
  if (sku.askDoctorBelowMonths !== undefined && ageMonths < sku.askDoctorBelowMonths) {
    return { status: "NEEDS_CLINICIAN", reason: "UNDER_LABEL_MIN_AGE", detail: `The ${sku.spokenName} label says to ask a doctor under ${sku.askDoctorBelowMonths} months.`, codes: ["LABEL_ASK_DOCTOR_AGE"] };
  }

  const weightKg = lbToKg(weightLb);
  const found = findBand(sku, weightLb);
  if (!found.band) {
    return found.where === "below"
      ? { status: "NEEDS_CLINICIAN", reason: "BELOW_LABEL_WEIGHT", detail: `The ${sku.spokenName} label says to ask a doctor below ${sku.askDoctorBelowLb} pounds.`, codes: ["LABEL_ASK_DOCTOR_WEIGHT"], weightKg }
      : { status: "NEEDS_CLINICIAN", reason: "ABOVE_LABEL_TABLE", detail: `This weight is above the ${sku.spokenName} dosing chart.`, codes: ["WEIGHT_ABOVE_LABEL_TABLE"], weightKg };
  }

  const { band, gap } = found;
  const doseMl = band.doseMl;
  const doseMg = doseMl * sku.mgPerMl;
  const mgPerKg = doseMg / weightKg;

  // S5: an independent method must agree with the label. Disagreement blocks and routes to a clinician.
  if (mgPerKg > sku.mgPerKgCeiling + 1e-9) {
    return {
      status: "NEEDS_CLINICIAN",
      reason: "CROSS_CHECK_FAILED",
      detail: `The label dose works out to ${mgPerKg.toFixed(1)} mg/kg, above the ${sku.mgPerKgCeiling} mg/kg ceiling.`,
      codes: [bandCode(band), "MG_PER_KG_EXCEEDS_CEILING"],
      weightKg,
    };
  }

  // Device-aware: never round a dose to fit a device. If the device's marks are known and this dose is not one of
  // them, the label (which allows no rounding) leaves only a pharmacist.
  const marks = sku.device.marksMl;
  if (marks && !marks.some((m) => Math.abs(m - doseMl) < 1e-9)) {
    return {
      status: "NEEDS_CLINICIAN",
      reason: "DOSE_NOT_ON_DEVICE_MARK",
      detail: `${doseMl} mL is not a mark on ${sku.device.name}. Do not round it; ask a pharmacist how to measure it.`,
      codes: [bandCode(band), "DOSE_NOT_ON_DEVICE_MARK"],
      weightKg,
    };
  }

  const ageWeightMismatch = ageMonths < band.ageMinMonths || ageMonths > band.ageMaxMonths;
  const codes = [bandCode(band), "MG_PER_KG_OK"];
  if (gap) codes.push("LABEL_GAP_LOWER_BAND_USED");
  if (ageWeightMismatch) codes.push("AGE_WEIGHT_MISMATCH");

  return { status: "APPROVED", doseMl, doseMg, weightLb, weightKg, mgPerKg, band, codes, gap, ageWeightMismatch };
}

// ------------------------------------------------------------------ adults / solids

export type SolidDoseResult =
  | { status: "APPROVED"; units: number; unitLabel: string; doseMg: number; codes: string[] }
  | { status: "NEEDS_CLINICIAN"; reason: "UNDER_LABEL_MIN_AGE_YEARS"; detail: string; codes: string[] };

export function solidDose(sku: SolidSku, ageMonths: number): SolidDoseResult {
  if (ageMonths < sku.minAgeYears * 12) {
    return { status: "NEEDS_CLINICIAN", reason: "UNDER_LABEL_MIN_AGE_YEARS", detail: `The ${sku.spokenName} label is for ages ${sku.minAgeYears} and up.`, codes: ["LABEL_AGE_MINIMUM"] };
  }
  return {
    status: "APPROVED",
    units: sku.unitsPerDose,
    unitLabel: sku.unitsPerDose === 1 ? sku.unit.singular : sku.unit.plural,
    doseMg: sku.unitsPerDose * sku.mgPerUnit,
    codes: [`LABEL_ADULT_DOSE_${sku.unitsPerDose}_${sku.unit.plural.toUpperCase()}`],
  };
}

// ------------------------------------------------------------------ weight sanity

/**
 * Coarse sanity windows by age (kg). These are NOT growth percentiles: they are deliberately wide bounds whose only
 * job is to catch a unit or typing mistake such as "19 kg" for a 9-month-old, so the caller is asked again (PRD §4.2).
 */
const PLAUSIBLE_KG: { upToMonths: number; min: number; max: number }[] = [
  { upToMonths: 3, min: 2, max: 9 },
  { upToMonths: 6, min: 3.5, max: 11 },
  { upToMonths: 12, min: 4.5, max: 14 },
  { upToMonths: 24, min: 6, max: 18 },
  { upToMonths: 48, min: 8, max: 24 },
  { upToMonths: 96, min: 11, max: 42 },
  { upToMonths: 144, min: 15, max: 75 },
  { upToMonths: Infinity, min: 30, max: 250 },
];

export function plausibleWeightKg(ageMonths: number): { min: number; max: number } {
  const { min, max } = PLAUSIBLE_KG.find((r) => ageMonths < r.upToMonths)!;
  return { min, max };
}

export function weightIsPlausible(weightKg: number, ageMonths: number): boolean {
  const r = plausibleWeightKg(ageMonths);
  return weightKg >= r.min && weightKg <= r.max;
}

/** A weight older than 14 days (infants under 12 months) or 30 days (older) must be retaken before dosing. */
export function staleAfterDays(ageMonths: number): number {
  return ageMonths < 12 ? 14 : 30;
}

export function isWeightStale(weighedAt: number | undefined, now: number, ageMonths: number): boolean {
  if (weighedAt === undefined) return true; // an undated weight cannot be trusted (S2: fail closed)
  return now - weighedAt > staleAfterDays(ageMonths) * 86_400_000;
}
