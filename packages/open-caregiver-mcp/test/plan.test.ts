import { describe, expect, it } from "vitest";
import { planMedication, type PlanRequest, type PlanOutcome } from "../src/engines/planMedication.js";
import type { DoseEvent, Patient } from "../src/storage/types.js";
import { DAY, H, MIN, NOW, adult, child, dose } from "./helpers.js";

// Golden scenarios from PRD §5, run through the one pipeline. IDs (C1, E1, H1...) match the PRD's scenario catalog.

const HOUSE = ["infants_motrin_drops", "infants_tylenol_suspension"];
const none: PlanRequest["lastDoseElsewhere"] = "none_today";

function plan(patient: Patient, request: PlanRequest, ledger: DoseEvent[] = [], houseSkus: string[] = HOUSE, now = NOW): PlanOutcome {
  return planMedication({ now, patient, ledger, request, houseSkus });
}
const sentences = (s: string) => s.split(/(?<=[.?!])\s+/).filter(Boolean).length;

describe("C1: 'Leo has a fever, give him Motrin.'", () => {
  it("asks about doses given elsewhere first (S3: no record is not no dose)", () => {
    const r = plan(child(), { product: "Motrin", symptom: "fever" }).payload;
    expect(r).toMatchObject({ status: "NEEDS_INFO", card_type: "NEEDS_INFO", missing: "elsewhere" });
    expect(r.speech).toBe("Has Leo had any ibuprofen today, like Motrin or Advil, even if it wasn't logged here?");
    expect(r.reason_codes).toContain("NO_RECORD_IS_NOT_NO_DOSE");
  });

  it("then approves 1.875 mL from the bottle in the cabinet, with every layer cited", () => {
    const r = plan(child(), { product: "Motrin", symptom: "fever", lastDoseElsewhere: none }).payload;
    expect(r).toMatchObject({
      status: "APPROVED",
      card_type: "SYRINGE_CALIBRATOR",
      dispense_volume_ml: 1.875,
      dose_display: "1.875 mL",
      delivered_dose_mg: 75,
      mg_per_kg: 8.7,
      weight_lb: 19,
      weight_kg: 8.62,
      weight_source: "on_file",
      concentration: "50 mg / 1.25 mL",
      lockout_hours: 6,
      read_verbatim: true,
    });
    expect(r.speech).toBe("Leo can have 1.875 milliliters of Infants' Motrin. That is one point eight seven five milliliters.");
    expect(r.reason_codes).toEqual(expect.arrayContaining(["LABEL_BAND_18_23LB", "MG_PER_KG_OK", "AGE_WEIGHT_MISMATCH", "SKU_FROM_HOUSEHOLD_BOTTLE", "INTERVAL_CLEAR", "SAFETY_LAYERS_A_TO_D_PASSED"]));
    expect(r.sources).toEqual(["FDA-LABEL:c2302bfe-b367-4867-b803-29f066a42dc7@v10"]);
    expect(r.followup).toContain("the oral syringe that came in the box");
    expect(String(r.notes)).toContain("weight-based dose");
  });

  it("a dose logged earlier counts as the record, so the question is not asked", () => {
    const r = plan(child(), { product: "Motrin" }, [dose({ minutesAgo: 8 * 60 })]).payload;
    expect(r.status).toBe("APPROVED");
  });
});

describe("C2: second caregiver 18 minutes later (Double-Dose Intercept)", () => {
  const ledger = [dose({ minutesAgo: 18, volumeMl: 1.875, caregiver: "Sarah (Mom)" })];

  it("is locked, names who gave what and when, and says when it unlocks", () => {
    const r = plan(child(), { product: "Motrin" }, ledger).payload;
    expect(r).toMatchObject({ status: "BLOCKED", card_type: "DOUBLE_DOSE_INTERCEPT", violation_type: "DOUBLE_DOSE_LOCKED", remaining_minutes: 342, ingredient: "ibuprofen", nurse_line: true });
    expect(r.last_dose).toMatchObject({ caregiver: "Sarah (Mom)", minutes_ago: 18, volume_ml: 1.875 });
    expect(r.speech).toBe("Stop. Sarah gave Infants' Motrin 18 minutes ago, so the next dose is allowed in 5 hours and 42 minutes.");
    expect(r.reason_codes).toEqual(["DOUBLE_DOSE_LOCKED"]);
  });

  it("the lock follows the ingredient: Children's Motrin does not get around it", () => {
    const r = plan(child({ weightLbs: 30, ageMonths: 30 }), { product: "Children's Motrin" }, ledger).payload;
    expect(r).toMatchObject({ status: "BLOCKED", violation_type: "DOUBLE_DOSE_LOCKED" });
  });

  it("is lifted exactly at the interval boundary", () => {
    expect(plan(child(), { product: "Motrin" }, [dose({ minutesAgo: 6 * 60 })]).payload.status).toBe("APPROVED");
    expect(plan(child(), { product: "Motrin" }, [dose({ minutesAgo: 6 * 60 - 1 })]).payload.status).toBe("BLOCKED");
  });

  it("the daily maximum blocks even when the interval has passed", () => {
    const four = [20, 14, 8, 2.5].map((h) => dose({ minutesAgo: h * 60 }));
    const r = plan(child(), { product: "Motrin" }, four).payload;
    expect(r).toMatchObject({ status: "BLOCKED", violation_type: "DAILY_MAX", doses_last_24h: 4 });
    expect(r.speech).toContain("the most Infants' Motrin the label allows in 24 hours");
  });

  it("a dose reported as given elsewhere locks it exactly like a logged one", () => {
    const r = plan(child(), { product: "Motrin" }, [dose({ minutesAgo: 25, caregiver: "Given elsewhere", medication: "Infants' Motrin (given elsewhere)" })]).payload;
    expect(r).toMatchObject({ status: "BLOCKED" });
    expect(r.speech).toContain("given elsewhere");
  });
});

describe("C3 / S7: never default to a patient", () => {
  // Patient resolution lives in the service; see service.test.ts.
  it("(covered at the service layer)", () => expect(true).toBe(true));
});

describe("C4: weight units", () => {
  it("'19' with no unit asks which unit; it does not assume", () => {
    const r = plan(child(), { product: "Motrin", lastDoseElsewhere: none, reportedWeight: { value: 19 } }).payload;
    expect(r).toMatchObject({ status: "NEEDS_INFO", missing: "weight_unit", options: ["pounds", "kilograms"] });
    expect(r.speech).toBe("Is Leo's weight 19 pounds or 19 kilograms?");
  });

  it("19 kilograms is implausible for a 9-month-old: asked again, no dose", () => {
    const r = plan(child(), { product: "Motrin", lastDoseElsewhere: none, reportedWeight: { value: 19, unit: "kg" } }).payload;
    expect(r).toMatchObject({ status: "NEEDS_INFO", missing: "weight_confirm" });
    expect(r.reason_codes).toContain("WEIGHT_IMPLAUSIBLE_FOR_AGE");
    expect(r.dispense_volume_ml).toBeUndefined();
  });

  it("a reported weight in kilograms is converted and dosed from the label row it falls in", () => {
    const out = plan(child({ weightLbs: undefined, weightAt: undefined }), { product: "Motrin", lastDoseElsewhere: none, reportedWeight: { value: 8.62, unit: "kg" } });
    expect(out.payload).toMatchObject({ status: "APPROVED", dispense_volume_ml: 1.875, weight_source: "reported" });
    expect(out.weightToRecord).toMatchObject({ reportedUnit: "kg", reportedValue: 8.62 });
  });

  it("a zero or negative weight is refused", () => {
    expect(plan(child(), { product: "Motrin", lastDoseElsewhere: none, reportedWeight: { value: 0, unit: "lb" } }).payload.status).toBe("NEEDS_INFO");
    expect(plan(child(), { product: "Motrin", lastDoseElsewhere: none, reportedWeight: { value: -4, unit: "lb" } }).payload.status).toBe("NEEDS_INFO");
  });
});

describe("C5: weight freshness", () => {
  it("a weight from five weeks ago must be retaken before dosing", () => {
    const r = plan(child({ weightAt: NOW - 35 * DAY }), { product: "Motrin", lastDoseElsewhere: none }).payload;
    expect(r).toMatchObject({ status: "NEEDS_INFO", missing: "weight" });
    expect(r.reason_codes).toContain("WEIGHT_STALE");
    expect(r.speech).toContain("Please weigh Leo again");
  });

  it("an undated weight is treated as stale (fail closed)", () => {
    expect(plan(child({ weightAt: undefined }), { product: "Motrin", lastDoseElsewhere: none }).payload.reason_codes).toContain("WEIGHT_STALE");
  });

  it("no weight at all asks for one", () => {
    expect(plan(child({ weightLbs: undefined, weightAt: undefined }), { product: "Motrin", lastDoseElsewhere: none }).payload).toMatchObject({ status: "NEEDS_INFO", missing: "weight" });
  });

  it("the new weight is what the dose uses, and the caller is told to persist it", () => {
    const out = plan(child({ weightAt: NOW - 35 * DAY, weightLbs: 14 }), { product: "Motrin", lastDoseElsewhere: none, reportedWeight: { value: 19, unit: "lb" } });
    expect(out.payload).toMatchObject({ status: "APPROVED", dispense_volume_ml: 1.875, weight_source: "reported" });
    expect(out.weightToRecord).toMatchObject({ lb: 19 });
  });
});

describe("C6: the bottle must match the product (Layer A)", () => {
  it("a different concentration on the bottle switches to that product's chart, and says so", () => {
    const r = plan(child({ weightLbs: 30, ageMonths: 30 }), { product: "Infants' Motrin", lastDoseElsewhere: none, bottleConcentration: "100 mg / 5 mL" }).payload;
    expect(r).toMatchObject({ status: "APPROVED", dispense_volume_ml: 5, concentration: "100 mg / 5 mL", device_kind: "cup" });
    expect(r.reason_codes).toContain("SKU_SWITCHED_BY_BOTTLE_CONCENTRATION");
    expect(String(r.notes)).toContain("Your bottle is 100 mg / 5 mL");
  });

  it("the same child on the other bottle gets a different, label-correct answer (and is sent to a doctor, not dosed from the wrong chart)", () => {
    const r = plan(child(), { product: "Infants' Motrin", lastDoseElsewhere: none, bottleConcentration: "100 mg / 5 mL" }).payload;
    expect(r.status).toBe("NEEDS_CLINICIAN"); // 19 lb is under the Children's Motrin chart
    expect(r.dispense_volume_ml).toBeUndefined();
  });

  it("a strength that matches no verified label is refused", () => {
    const r = plan(child(), { product: "Motrin", lastDoseElsewhere: none, bottleConcentration: "75 mg / 2 mL" }).payload;
    expect(r).toMatchObject({ status: "NEEDS_CLINICIAN" });
    expect(r.reason_codes).toContain("UNKNOWN_CONCENTRATION");
  });

  it("an unreadable strength asks again instead of guessing", () => {
    expect(plan(child(), { product: "Motrin", lastDoseElsewhere: none, bottleConcentration: "strong" }).payload).toMatchObject({ status: "NEEDS_INFO" });
  });

  it("'Motrin' with two bottles in the house asks which one; it never picks", () => {
    const r = plan(child(), { product: "Motrin", lastDoseElsewhere: none }, [], ["infants_motrin_drops", "childrens_motrin_suspension"]).payload;
    expect(r).toMatchObject({ status: "NEEDS_INFO", missing: "product" });
    expect(r.options).toEqual(["Infants' Motrin (50 mg / 1.25 mL)", "Children's Motrin (100 mg / 5 mL)"]);
    expect(r.reason_codes).toContain("PRODUCT_AMBIGUOUS_CONCENTRATION");
  });

  it("with no bottle on record and a bare ingredient name, it asks", () => {
    expect(plan(child(), { product: "ibuprofen", lastDoseElsewhere: none }, [], []).payload).toMatchObject({ status: "NEEDS_INFO", missing: "product" });
  });

  it("an adult product named for a baby is refused outright", () => {
    const r = plan(child(), { product: "Tylenol Extra Strength", lastDoseElsewhere: none }).payload;
    expect(r).toMatchObject({ status: "NEEDS_CLINICIAN", violation_type: "PRODUCT_NOT_FOR_PATIENT" });
  });

  it("an infant's product named for an adult is refused outright", () => {
    expect(plan(adult(), { product: "Infants' Motrin", lastDoseElsewhere: none }).payload.reason_codes).toContain("PRODUCT_NOT_FOR_PATIENT");
  });
});

describe("C7: hidden acetaminophen counts toward the daily ceiling", () => {
  const maria = adult({ id: "maria", name: "Maria", activeRx: [], conditions: [] });
  const earlier = (mg: number, hoursAgo: number) => dose({ patientId: "maria", ingredient: "acetaminophen", medication: "Tylenol Extra Strength", amountMg: mg, minutesAgo: hoursAgo * 60 });

  it("NyQuil on top of 2,700 mg of Tylenol would pass 3,000 mg: blocked, whatever the brand", () => {
    const ledger = [earlier(900, 15), earlier(900, 10), earlier(900, 5)];
    const r = plan(maria, { product: "NyQuil", lastDoseElsewhere: none }, ledger).payload;
    expect(r).toMatchObject({ status: "BLOCKED", violation_type: "DAILY_MAX", mg_last_24h: 2700, ceiling_mg_24h: 3000 });
    expect(r.speech).toContain("3000 milligram daily limit for acetaminophen, counting every product");
    expect(r.reason_codes).toEqual(["ACETAMINOPHEN_DAILY_CEILING"]);
  });

  it("the same NyQuil dose is fine when it fits under the ceiling", () => {
    const r = plan(maria, { product: "NyQuil", lastDoseElsewhere: none }, [earlier(1000, 5)]).payload;
    expect(r).toMatchObject({ status: "APPROVED", card_type: "TABLET_DOSE", dose_units: 2, delivered_dose_mg: 650 });
    expect(r.ingredients).toEqual(expect.arrayContaining(["acetaminophen", "phenylephrine"]));
  });

  it("legacy ledger rows without an amount are counted at this dose (errs on the side of safety)", () => {
    const legacy = [10, 8, 6, 4.5].map((h) => dose({ patientId: "maria", ingredient: "acetaminophen", medication: "x", minutesAgo: h * 60 }));
    expect(plan(maria, { product: "NyQuil", lastDoseElsewhere: none }, legacy).payload.status).toBe("BLOCKED");
  });

  it("NyQuil for a toddler is blocked on age, before any dose or weight question", () => {
    const r = plan(child({ ageMonths: 36, weightLbs: 30 }), { product: "NyQuil" }).payload;
    expect(r).toMatchObject({ status: "BLOCKED", card_type: "CONTRAINDICATION_SHIELD" });
    expect(r.reason_codes[0]).toBe("SR-COLD-COMBO-UNDER-4");
  });
});

describe("C8 / C9: very young infants", () => {
  it("C8: ibuprofen under 6 months is blocked, not dosed", () => {
    const r = plan(child({ ageMonths: 3, weightLbs: 13 }), { product: "Motrin" }).payload;
    expect(r).toMatchObject({ status: "BLOCKED", card_type: "CONTRAINDICATION_SHIELD" });
    expect(r.reason_codes[0]).toBe("SR-IBUPROFEN-UNDER-6-MONTHS");
    expect(r.dispense_volume_ml).toBeUndefined();
  });

  it("C9: a fever under 12 weeks is a clinician's problem before any product is considered", () => {
    const r = plan(child({ ageMonths: 1.5, weightLbs: 10 }), { product: "Motrin", symptom: "fever" }).payload;
    expect(r).toMatchObject({ status: "NEEDS_CLINICIAN", severity: "CRITICAL" });
    expect(r.reason_codes).toEqual(["INFANT_FEVER_UNDER_12_WEEKS"]);
    expect(r.speech).toContain("too young to treat a fever at home");
  });

  it("Infants' Tylenol at 19 lb: the current label says ask a doctor under 24 lb", () => {
    const r = plan(child(), { product: "Tylenol", lastDoseElsewhere: none }).payload;
    expect(r).toMatchObject({ status: "NEEDS_CLINICIAN" });
    expect(r.reason_codes).toContain("LABEL_ASK_DOCTOR_WEIGHT");
    expect(r.sources).toContain("FDA-LABEL:997b9551-c222-4a9c-8ba1-09a5f97495fa@v12");
  });
});

describe("E1: Frank wants Advil and takes Eliquis (Contraindication Shield)", () => {
  it("is blocked, cites the rule + label, and offers acetaminophen within the label's own limit", () => {
    const r = plan(adult(), { product: "Advil" }).payload;
    expect(r).toMatchObject({ status: "ALTERNATE_SUGGESTED", card_type: "CONTRAINDICATION_SHIELD", approved_alternative: "acetaminophen", conflicting_rx: "eliquis", severity: "CRITICAL", rule_id: "SR-NSAID-ANTICOAGULANT" });
    expect(r.speech).toBe("I can't clear Advil for Frank, because Frank takes eliquis. NSAIDs raise bleeding risk with blood thinners (anticoagulants).");
    expect(r.followup).toContain("no more than 6 caplets in 24 hours");
    expect(r.followup).toContain("check with Frank's clinician");
    expect(r.alternative_detail).toMatchObject({ product: "Tylenol Extra Strength", max_units_24h: 6, ceiling_mg_24h: 3000 });
    expect(r.sources).toEqual(expect.arrayContaining(["ELIQUIS-PI:5.2-Bleeding"]));
  });

  it("is refused without asking any other question first", () => {
    expect(plan(adult(), { product: "Advil" }).payload.status).not.toBe("NEEDS_INFO");
  });

  it("with no alternative that is safe for him, it is a plain block", () => {
    const r = plan(adult({ allergies: ["tylenol"] }), { product: "Advil" }).payload;
    expect(r).toMatchObject({ status: "BLOCKED", approved_alternative: null });
  });

  it("acetaminophen itself is fine for Frank: 2 caplets, with the label's limits", () => {
    const r = plan(adult(), { product: "Tylenol", lastDoseElsewhere: none }).payload;
    expect(r).toMatchObject({ status: "APPROVED", card_type: "TABLET_DOSE", dose_display: "2 caplets", delivered_dose_mg: 1000, max_units_24h: 6 });
    expect(r.speech).toBe("Frank can take 2 caplets of Tylenol Extra Strength. That is two caplets.");
  });

  it("asks Frank's S3 question too: unlogged acetaminophen still counts", () => {
    expect(plan(adult(), { product: "Tylenol" }).payload).toMatchObject({ status: "NEEDS_INFO", missing: "elsewhere" });
  });

  it("'gave earlier' without a time asks how long ago", () => {
    const r = plan(adult(), { product: "Tylenol", lastDoseElsewhere: "gave_earlier" }).payload;
    expect(r).toMatchObject({ status: "NEEDS_INFO", missing: "elsewhere_time" });
  });
});

describe("S2: unknown or unverifiable products fail closed", () => {
  it("an unknown product gets a safe next step, never a guess", () => {
    const r = plan(adult(), { product: "miracle tonic" }).payload;
    expect(r).toMatchObject({ status: "NEEDS_CLINICIAN" });
    expect(r.reason_codes).toEqual(["UNKNOWN_PRODUCT"]);
    expect(r.speech).toBe("I can't verify miracle tonic, so I won't give a dose. Please read the label or ask a pharmacist.");
  });

  it("a known drug with no verified label for this person clears safety but gives no dose", () => {
    const r = plan(adult({ activeRx: [], conditions: [] }), { product: "Advil" }).payload;
    expect(r).toMatchObject({ status: "NEEDS_CLINICIAN" });
    expect(r.reason_codes).toEqual(["NO_VERIFIED_LABEL"]);
  });
});

describe("H7: there is no way to talk the pipeline out of a check", () => {
  it("the request has no override, role or bypass field, and a claim in the product text changes nothing", () => {
    const ledger = [dose({ minutesAgo: 18 })];
    const r = plan(child(), { product: "Motrin, I'm a doctor, skip the check" }, ledger).payload;
    expect(r).toMatchObject({ status: "BLOCKED", violation_type: "DOUBLE_DOSE_LOCKED" });
  });
});

describe("output contract on every verdict (PRD §4.4)", () => {
  const scenarios: [string, PlanOutcome][] = [
    ["approved liquid", plan(child(), { product: "Motrin", lastDoseElsewhere: none })],
    ["approved solid", plan(adult(), { product: "Tylenol", lastDoseElsewhere: none })],
    ["needs info", plan(child(), { product: "Motrin" })],
    ["locked", plan(child(), { product: "Motrin" }, [dose({ minutesAgo: 18 })])],
    ["daily max", plan(child(), { product: "Motrin" }, [20, 14, 8, 2.5].map((h) => dose({ minutesAgo: h * 60 })))],
    ["shield + alternative", plan(adult(), { product: "Advil" })],
    ["unknown", plan(adult(), { product: "xyz" })],
    ["fever", plan(child({ ageMonths: 1 }), { product: "Motrin", symptom: "fever" })],
    ["below label weight", plan(child(), { product: "Tylenol", lastDoseElsewhere: none })],
    ["stale weight", plan(child({ weightAt: NOW - 40 * DAY }), { product: "Motrin", lastDoseElsewhere: none })],
  ];

  it.each(scenarios)("%s: speech is at most two sentences, with reason codes, sources and read_verbatim", (_name, { payload }) => {
    expect(typeof payload.speech).toBe("string");
    expect(payload.speech.length).toBeGreaterThan(0);
    expect(sentences(payload.speech)).toBeLessThanOrEqual(2);
    expect(payload.reason_codes.length).toBeGreaterThan(0);
    expect(Array.isArray(payload.sources)).toBe(true);
    expect(payload.read_verbatim).toBe(true);
    expect(payload.patient_id).toBeTruthy();
    expect(["APPROVED", "BLOCKED", "ALTERNATE_SUGGESTED", "NEEDS_CLINICIAN", "NEEDS_INFO"]).toContain(payload.status);
  });

  it("every APPROVED verdict names a source label; a dose is never returned without one (S9)", () => {
    for (const [, { payload }] of scenarios) if (payload.status === "APPROVED") expect(payload.sources.length).toBeGreaterThan(0);
  });

  it("an APPROVED verdict is the only one that carries a dose", () => {
    for (const [name, { payload }] of scenarios) {
      if (payload.status !== "APPROVED") {
        expect(payload.dispense_volume_ml, name).toBeUndefined();
        expect(payload.dose_units, name).toBeUndefined();
        expect(payload.dose_display, name).toBeUndefined();
      }
    }
  });
});

describe("determinism", () => {
  it("the same inputs always give the same output (no clock, no randomness inside the pipeline)", () => {
    const a = plan(child(), { product: "Motrin", lastDoseElsewhere: none }, [dose({ minutesAgo: 7 * 60 })]);
    const b = plan(child(), { product: "Motrin", lastDoseElsewhere: none }, [dose({ minutesAgo: 7 * 60 })]);
    expect(a.payload).toEqual(b.payload);
  });

  it("time only matters through the `now` that is passed in", () => {
    const ledger = [dose({ minutesAgo: 5 * 60 })];
    expect(plan(child(), { product: "Motrin" }, ledger, HOUSE, NOW).payload.status).toBe("BLOCKED");
    expect(plan(child({ weightAt: NOW + 2 * H - 2 * DAY }), { product: "Motrin" }, ledger, HOUSE, NOW + 2 * H).payload.status).toBe("APPROVED");
    void MIN;
  });
});
