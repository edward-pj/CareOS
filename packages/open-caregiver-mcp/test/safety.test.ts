import { describe, expect, it } from "vitest";
import { ingredientsOf, lookupDrug } from "../src/data/drugClasses.js";
import { SAFETY_RULES, RULE_COUNT } from "../src/data/safetyRules.js";
import { evaluateSafety, productFromName, verifyDrugSafety, type PatientClinical } from "../src/engines/safetyMatrix.js";

const frank: PatientClinical = { activeRx: ["eliquis", "metformin", "lisinopril", "atorvastatin"], conditions: ["hypertension", "type2_diabetes"], allergies: [], ageMonths: 78 * 12 };
const healthyAdult: PatientClinical = { activeRx: [], conditions: [], allergies: [], ageMonths: 40 * 12 };
const child = (ageMonths: number, over: Partial<PatientClinical> = {}): PatientClinical => ({ activeRx: [], conditions: [], allergies: [], ageMonths, ...over });

describe("Layers B + C: prescriptions, ingredients, conditions, age", () => {
  it("E1: Advil with Eliquis is blocked, citing the rule and the label, and suggests acetaminophen", () => {
    const r = verifyDrugSafety("Advil", frank);
    expect(r).toMatchObject({ status: "BLOCKED", ruleId: "SR-NSAID-ANTICOAGULANT", severity: "CRITICAL", conflictingRx: "eliquis", alternative: "acetaminophen" });
    if (r.status === "CLEAR") return;
    expect(r.sources).toEqual(expect.arrayContaining(["ELIQUIS-PI:5.2-Bleeding"]));
    // lower-severity findings are still reported alongside the top one
    expect(r.findings.map((f) => f.ruleId)).toEqual(expect.arrayContaining(["SR-NSAID-ACE-INHIBITOR", "SR-NSAID-HYPERTENSION"]));
  });

  it("S4: brands are ingredients. Motrin, Advil, children's ibuprofen and Aleve all hit the same NSAID rule", () => {
    for (const name of ["Motrin", "Advil", "Infants' Motrin", "children's ibuprofen", "ibuprofen", "Aleve", "naproxen", "aspirin"]) {
      expect(verifyDrugSafety(name, frank), name).toMatchObject({ status: "BLOCKED", ruleId: expect.stringMatching(/ANTICOAGULANT/) });
    }
  });

  it("an alternative is only offered if it is itself safe for this exact person", () => {
    const allergic = { ...frank, allergies: ["tylenol"] };
    const r = verifyDrugSafety("Advil", allergic);
    expect(r.status).toBe("BLOCKED");
    if (r.status !== "CLEAR") expect(r.alternative).toBeUndefined();
  });

  it("an NSAID with only an ACE inhibitor is a 'ask a clinician', not a flat block", () => {
    const r = verifyDrugSafety("ibuprofen", { ...healthyAdult, activeRx: ["lisinopril"] });
    expect(r).toMatchObject({ status: "NEEDS_CLINICIAN", ruleId: "SR-NSAID-ACE-INHIBITOR" });
  });

  it("NSAIDs with a diuretic, a steroid, or an antiplatelet all route to a clinician", () => {
    expect(verifyDrugSafety("ibuprofen", { ...healthyAdult, activeRx: ["furosemide"] })).toMatchObject({ status: "NEEDS_CLINICIAN", ruleId: "SR-NSAID-DIURETIC" });
    expect(verifyDrugSafety("ibuprofen", { ...healthyAdult, activeRx: ["prednisone"] })).toMatchObject({ status: "NEEDS_CLINICIAN", ruleId: "SR-NSAID-CORTICOSTEROID" });
    expect(verifyDrugSafety("ibuprofen", { ...healthyAdult, activeRx: ["clopidogrel"] })).toMatchObject({ status: "NEEDS_CLINICIAN", ruleId: "SR-NSAID-ANTIPLATELET" });
  });

  it("NSAIDs with kidney disease, heart disease, or a stomach ulcer route to a clinician", () => {
    for (const [condition, rule] of [["chronic_kidney_disease", "SR-NSAID-KIDNEY-DISEASE"], ["heart_disease", "SR-NSAID-HEART-DISEASE"], ["stomach_ulcer", "SR-NSAID-STOMACH-ULCER"]] as const) {
      expect(verifyDrugSafety("ibuprofen", { ...healthyAdult, conditions: [condition] })).toMatchObject({ status: "NEEDS_CLINICIAN", ruleId: rule });
    }
  });

  it("aspirin plus an anticoagulant is blocked on its own rule too", () => {
    expect(verifyDrugSafety("aspirin", { ...healthyAdult, activeRx: ["warfarin"] })).toMatchObject({ status: "BLOCKED", severity: "CRITICAL" });
  });

  it("duplicate therapy: the same ingredient under another brand is a block", () => {
    expect(verifyDrugSafety("acetaminophen", { ...healthyAdult, activeRx: ["tylenol"] })).toMatchObject({ status: "BLOCKED", ruleId: "SR-DUPLICATE-INGREDIENT" });
  });

  it("allergies are matched by ingredient, not by brand", () => {
    expect(verifyDrugSafety("Motrin", child(24, { allergies: ["advil"] }))).toMatchObject({ status: "BLOCKED", ruleId: "SR-ALLERGY", severity: "CRITICAL" });
  });

  it("acetaminophen with warfarin: the label says to ask a doctor or pharmacist", () => {
    expect(verifyDrugSafety("Tylenol", { ...healthyAdult, activeRx: ["warfarin"] })).toMatchObject({ status: "NEEDS_CLINICIAN", ruleId: "SR-ACETAMINOPHEN-WARFARIN" });
  });

  it("a potassium salt substitute with an ACE inhibitor routes to a pharmacist", () => {
    expect(verifyDrugSafety("salt substitute", frank)).toMatchObject({ status: "NEEDS_CLINICIAN", ruleId: "SR-POTASSIUM-ACE-INHIBITOR" });
  });

  describe("age rules", () => {
    it("C8: ibuprofen is blocked under 6 months and allowed at 6", () => {
      expect(verifyDrugSafety("Motrin", child(3))).toMatchObject({ status: "BLOCKED", ruleId: "SR-IBUPROFEN-UNDER-6-MONTHS" });
      expect(verifyDrugSafety("Motrin", child(5.9))).toMatchObject({ status: "BLOCKED" });
      expect(verifyDrugSafety("Motrin", child(6)).status).toBe("CLEAR");
    });

    it("aspirin is blocked for children under 12", () => {
      expect(verifyDrugSafety("aspirin", child(8 * 12))).toMatchObject({ status: "BLOCKED", ruleId: "SR-ASPIRIN-UNDER-12" });
      expect(verifyDrugSafety("aspirin", child(12 * 12)).status).toBe("CLEAR");
    });
  });

  describe("C7: combination products expand to every ingredient", () => {
    it("NyQuil contains hidden acetaminophen, a decongestant and more", () => {
      expect(ingredientsOf(["NyQuil"])).toEqual(expect.arrayContaining(["acetaminophen", "dextromethorphan", "doxylamine", "phenylephrine"]));
      expect(lookupDrug("Vicks NyQuil Severe")?.classes).toEqual(expect.arrayContaining(["analgesic", "decongestant", "cough_cold"]));
    });

    it("under 4: blocked; 4 to 11: ask a doctor; an adult with high blood pressure: blocked for the decongestant", () => {
      expect(verifyDrugSafety("NyQuil", child(36))).toMatchObject({ status: "BLOCKED", ruleId: "SR-COLD-COMBO-UNDER-4" });
      expect(verifyDrugSafety("NyQuil", child(6 * 12))).toMatchObject({ status: "NEEDS_CLINICIAN", ruleId: "SR-COLD-COMBO-4-TO-12" });
      expect(verifyDrugSafety("NyQuil", frank)).toMatchObject({ status: "BLOCKED", ruleId: "SR-DECONGESTANT-HYPERTENSION" });
      expect(verifyDrugSafety("NyQuil", healthyAdult).status).toBe("CLEAR");
    });
  });

  it("S2: an unknown product cannot be cleared", () => {
    expect(productFromName("magic cure")).toBeUndefined();
    expect(verifyDrugSafety("magic cure", healthyAdult)).toMatchObject({ status: "NEEDS_CLINICIAN", ruleId: "SR-UNKNOWN-PRODUCT" });
  });

  it("a clean chart is CLEAR and reports the ingredients it checked", () => {
    expect(evaluateSafety({ name: "x", ingredients: ["acetaminophen"], classes: ["analgesic"] }, frank)).toEqual({ status: "CLEAR", ingredients: ["acetaminophen"] });
  });
});

describe("the curated rule set (data, not code)", () => {
  it("every rule has a unique id and cites at least one real source", () => {
    const ids = SAFETY_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of SAFETY_RULES) {
      expect(r.sources.length, r.id).toBeGreaterThan(0);
      for (const s of r.sources) expect(s, r.id).toMatch(/^(FDA-LABEL:[0-9a-f-]{36}@v\d+|ELIQUIS-PI:5\.2-Bleeding)$/);
      expect(r.rationale.length, r.id).toBeGreaterThan(10);
      expect(r.proposedClass !== undefined || r.proposedIngredient !== undefined, r.id).toBe(true);
    }
  });

  it("is an honest starter set, not a claim of completeness", () => {
    expect(RULE_COUNT).toBe(SAFETY_RULES.length);
    expect(RULE_COUNT).toBeGreaterThanOrEqual(15);
  });
});
