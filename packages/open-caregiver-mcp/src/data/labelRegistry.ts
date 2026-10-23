// Label registry: the ONLY place a dose can come from (principle S1).
//
// Every row is transcribed from an official FDA drug label (SPL) read through the openFDA label API on
// 2026-10-19, and cites the label's set id + version so it can be re-checked on DailyMed. Nothing here is typed
// from memory. If a label changes, re-ingest the row and bump `version`/`retrievedAt`; do not edit doses in place.
//
//   verify a row:  https://dailymed.nlm.nih.gov/dailymed/lookup.cfm?setid=<setId>
//   raw source:    https://api.fda.gov/drug/label.json?search=set_id:<setId>
//
// Not yet verified (and therefore not modelled): dosing-syringe tick marks. The labels say "use only enclosed
// syringe/cup" but do not list the marks, so `device.marksMl` is deliberately absent and the cards tell the caregiver
// to use the device from the box rather than claim a mark.

export const REGISTRY_RETRIEVED_AT = "2026-10-19";

export interface LabelSource {
  /** Stable id quoted in every tool result's `sources`. */
  id: string;
  brand: string;
  setId: string;
  version: number;
  /** Label effective date (YYYYMMDD) as reported by openFDA. */
  effectiveTime: string;
  url: string;
  retrievedAt: string;
}

const source = (brand: string, setId: string, version: number, effectiveTime: string): LabelSource => ({
  id: `FDA-LABEL:${setId}@v${version}`,
  brand,
  setId,
  version,
  effectiveTime,
  url: `https://dailymed.nlm.nih.gov/dailymed/lookup.cfm?setid=${setId}`,
  retrievedAt: REGISTRY_RETRIEVED_AT,
});

export interface LabelBand {
  /** Inclusive weight range exactly as printed on the label's chart. */
  minLb: number;
  maxLb: number;
  doseMl: number;
  /** The age column printed next to the weight, for the age/weight mismatch flag. */
  ageLabel: string;
  ageMinMonths: number;
  ageMaxMonths: number;
}

interface SkuBase {
  sku: string;
  displayName: string;
  /** What Alexa says aloud. */
  spokenName: string;
  /** Normalised (see `norm`) phrases that identify this EXACT product. A hit on another population's SKU is a mismatch. */
  aliases: string[];
  /** Bare brand names ("tylenol") that only select this SKU when it suits the patient; otherwise the ingredient decides. */
  looseAliases?: string[];
  /** Classes of the product as a whole (e.g. "cough_cold"), on top of its ingredients' classes. */
  productClasses?: string[];
  /** Every active ingredient: combination products expand to all of them (S4). */
  ingredients: string[];
  /** The ingredient whose interval / daily limit this label enforces. */
  limitIngredient: string;
  concentrationLabel: string;
  /** Shortest repeat interval on the label; this is the lock length. */
  intervalHours: number;
  intervalNote: string;
  maxDosesPer24h: number;
  source: LabelSource;
}

export interface LiquidSku extends SkuBase {
  kind: "liquid";
  mgPerMl: number;
  bands: LabelBand[];
  /** The label chart says "ask a doctor" below this weight. */
  askDoctorBelowLb: number;
  /**
   * A standalone age row on the chart ("under 6 mos ask a doctor"). Only set when the label prints one; where weight and
   * age share a row, weight governs ("if possible, use weight to dose; otherwise use age").
   */
  askDoctorBelowMonths?: number;
  /** Per-dose ceiling used as the independent S5 cross-check (not a dosing source). */
  mgPerKgCeiling: number;
  device: {
    kind: "syringe" | "cup";
    name: string;
    /** Verified tick marks, if known. Absent = unknown: never claim a mark. */
    marksMl?: number[];
    /** Only used to draw the fill graphic; says nothing about the real device. */
    illustrativeScaleMl: number;
  };
}

export interface SolidSku extends SkuBase {
  kind: "solid";
  unit: { singular: string; plural: string };
  /** mg of `limitIngredient` in one unit. */
  mgPerUnit: number;
  unitsPerDose: number;
  maxUnitsPer24h: number;
  minAgeYears: number;
}

export type LabelSku = LiquidSku | SolidSku;

export const LABEL_REGISTRY: LabelSku[] = [
  {
    kind: "liquid",
    sku: "infants_motrin_drops",
    displayName: "Infants' Motrin Concentrated Drops (ibuprofen 50 mg / 1.25 mL)",
    spokenName: "Infants' Motrin",
    aliases: ["infants motrin", "infant motrin", "infants motrin drops", "infant motrin drops", "motrin drops", "concentrated drops", "infant ibuprofen drops", "ibuprofen drops", "infants motrin concentrated drops"],
    ingredients: ["ibuprofen"],
    limitIngredient: "ibuprofen",
    concentrationLabel: "50 mg / 1.25 mL",
    mgPerMl: 40,
    intervalHours: 6,
    intervalNote: "every 6-8 hours",
    maxDosesPer24h: 4,
    askDoctorBelowLb: 12,
    askDoctorBelowMonths: 6,
    // Chart: "under 6 mos ask a doctor / 12-17 lbs 6-11 mos 1.25 mL / 18-23 lbs 12-23 mos 1.875 mL"
    bands: [
      { minLb: 12, maxLb: 17, doseMl: 1.25, ageLabel: "6-11 months", ageMinMonths: 6, ageMaxMonths: 11 },
      { minLb: 18, maxLb: 23, doseMl: 1.875, ageLabel: "12-23 months", ageMinMonths: 12, ageMaxMonths: 23 },
    ],
    mgPerKgCeiling: 10,
    device: { kind: "syringe", name: "the oral syringe that came in the box", illustrativeScaleMl: 2.5 },
    source: source("Infants Motrin", "c2302bfe-b367-4867-b803-29f066a42dc7", 10, "20260630"),
  },
  {
    kind: "liquid",
    sku: "childrens_motrin_suspension",
    displayName: "Children's Motrin Oral Suspension (ibuprofen 100 mg / 5 mL)",
    spokenName: "Children's Motrin",
    aliases: ["childrens motrin", "children motrin", "childrens ibuprofen", "children ibuprofen", "motrin suspension", "childrens motrin suspension", "childrens ibuprofen liquid", "childrens liquid"],
    ingredients: ["ibuprofen"],
    limitIngredient: "ibuprofen",
    concentrationLabel: "100 mg / 5 mL",
    mgPerMl: 20,
    intervalHours: 6,
    intervalNote: "every 6-8 hours",
    maxDosesPer24h: 4,
    askDoctorBelowLb: 24,
    // Chart: "under 24 lbs under 2 yrs ask a doctor / 24-35 lbs 2-3 yrs 5 mL / 36-47 4-5 7.5 / 48-59 6-8 10 / 60-71 9-10 12.5 / 72-95 11 yrs 15 mL"
    bands: [
      { minLb: 24, maxLb: 35, doseMl: 5, ageLabel: "2-3 years", ageMinMonths: 24, ageMaxMonths: 47 },
      { minLb: 36, maxLb: 47, doseMl: 7.5, ageLabel: "4-5 years", ageMinMonths: 48, ageMaxMonths: 71 },
      { minLb: 48, maxLb: 59, doseMl: 10, ageLabel: "6-8 years", ageMinMonths: 72, ageMaxMonths: 107 },
      { minLb: 60, maxLb: 71, doseMl: 12.5, ageLabel: "9-10 years", ageMinMonths: 108, ageMaxMonths: 131 },
      { minLb: 72, maxLb: 95, doseMl: 15, ageLabel: "11 years", ageMinMonths: 132, ageMaxMonths: 143 },
    ],
    mgPerKgCeiling: 10,
    device: { kind: "cup", name: "the dosing cup that came in the box", illustrativeScaleMl: 15 },
    source: source("Childrens Motrin", "9e1cdef7-921f-4163-869c-6c062e31c5bb", 16, "20241101"),
  },
  {
    kind: "liquid",
    sku: "infants_tylenol_suspension",
    displayName: "Infants' Tylenol Oral Suspension (acetaminophen 160 mg / 5 mL)",
    spokenName: "Infants' Tylenol",
    aliases: ["infants tylenol", "infant tylenol", "infants tylenol suspension", "infant acetaminophen", "infants acetaminophen", "infant tylenol drops"],
    ingredients: ["acetaminophen"],
    limitIngredient: "acetaminophen",
    concentrationLabel: "160 mg / 5 mL",
    mgPerMl: 32,
    intervalHours: 4,
    intervalNote: "every 4 hours while symptoms last",
    maxDosesPer24h: 5,
    askDoctorBelowLb: 24,
    // Chart: "under 24 lbs (under 2 yrs) ask a doctor / 24-35 lbs 2-3 yrs 5 mL"
    bands: [{ minLb: 24, maxLb: 35, doseMl: 5, ageLabel: "2-3 years", ageMinMonths: 24, ageMaxMonths: 47 }],
    mgPerKgCeiling: 15,
    device: { kind: "syringe", name: "the oral syringe that came in the box", illustrativeScaleMl: 5 },
    source: source("Infants TYLENOL", "997b9551-c222-4a9c-8ba1-09a5f97495fa", 12, "20260805"),
  },
  {
    kind: "solid",
    sku: "tylenol_extra_strength_500",
    displayName: "Tylenol Extra Strength caplets (acetaminophen 500 mg)",
    spokenName: "Tylenol Extra Strength",
    aliases: ["tylenol extra strength", "extra strength tylenol", "acetaminophen 500", "tylenol caplets"],
    looseAliases: ["tylenol"],
    ingredients: ["acetaminophen"],
    limitIngredient: "acetaminophen",
    concentrationLabel: "500 mg per caplet",
    unit: { singular: "caplet", plural: "caplets" },
    mgPerUnit: 500,
    unitsPerDose: 2,
    maxUnitsPer24h: 6,
    minAgeYears: 12,
    intervalHours: 6,
    intervalNote: "every 6 hours while symptoms last",
    maxDosesPer24h: 3, // label: do not take more than 6 caplets in 24 hours = 3 doses of 2
    source: source("Tylenol Extra Strength", "0c5fdda8-5049-46de-e063-6294a90a592b", 2, "20241107"),
  },
  {
    kind: "solid",
    sku: "nyquil_severe_caplets",
    displayName: "Vicks NyQuil Severe Cold & Flu caplets (acetaminophen 325 mg + dextromethorphan + doxylamine + phenylephrine)",
    spokenName: "NyQuil Severe",
    aliases: ["nyquil severe", "vicks nyquil severe"],
    looseAliases: ["nyquil", "vicks nyquil"],
    productClasses: ["cough_cold"],
    ingredients: ["acetaminophen", "dextromethorphan", "doxylamine", "phenylephrine"],
    limitIngredient: "acetaminophen",
    concentrationLabel: "acetaminophen 325 mg per caplet",
    unit: { singular: "caplet", plural: "caplets" },
    mgPerUnit: 325,
    unitsPerDose: 2,
    maxUnitsPer24h: 8,
    minAgeYears: 12,
    intervalHours: 4,
    intervalNote: "every 4 hours",
    maxDosesPer24h: 4, // label: do not exceed 8 caplets per 24 hrs = 4 doses of 2
    source: source("Vicks NyQuil VapoCOOL Severe COLD and FLU plus CONGESTION", "efb5f0b9-9825-ab23-e053-2995a90a26ab", 9, "20260908"),
  },
];

/**
 * Adult acetaminophen ceiling across ALL sources. Derived from the Tylenol Extra Strength label:
 * "do not take more than 6 caplets in 24 hours" x 500 mg = 3,000 mg (the label itself states no mg total).
 */
export const ACETAMINOPHEN_ADULT_CEILING_MG_24H = 3000;
export const ACETAMINOPHEN_CEILING_SOURCE = "FDA-LABEL:0c5fdda8-5049-46de-e063-6294a90a592b@v2";

export function findSku(sku: string): LabelSku | undefined {
  return LABEL_REGISTRY.find((s) => s.sku === sku);
}

/** Lowercase, strip apostrophes, collapse everything that is not a letter/digit to single spaces. */
export function norm(text: string): string {
  return text.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9.]+/g, " ").trim();
}

/** Parses "100 mg / 5 mL", "50mg per 1.25 ml" and similar into mg per mL, or undefined. */
export function parseConcentrationMgPerMl(text: string): number | undefined {
  const m = /(\d+(?:\.\d+)?)\s*mg\s*(?:\/|per)\s*(\d+(?:\.\d+)?)\s*ml/i.exec(text);
  if (!m) return undefined;
  const mg = Number(m[1]);
  const ml = Number(m[2]);
  return ml > 0 ? mg / ml : undefined;
}
