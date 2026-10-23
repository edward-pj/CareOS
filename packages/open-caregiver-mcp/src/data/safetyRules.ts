// Curated, cited safety rules (PRD §4.3). Rules are DATA: an id, a trigger, an action and a source.
//
// Every `sources` entry was read from an official FDA label on 2026-10-19 (see labelRegistry.ts for how to re-check).
// This is a starter set of high-severity rules, not a complete interaction database, and it never claims to be one.
// To add a rule: add a row here, add a test in test/rules.test.ts, and cite the label section it comes from.
//
//   BLOCK      the combination is unsafe to give at home: refuse.
//   CLINICIAN  the label itself says "ask a doctor/pharmacist": do not give; route to a clinician.

export type Severity = "CRITICAL" | "MAJOR" | "MODERATE";
export type RuleAction = "BLOCK" | "CLINICIAN";

/** What the rule matches in the patient's record. */
export type Against =
  | { kind: "class"; value: string } // class of a confirmed active medication
  | { kind: "ingredient"; value: string } // a specific confirmed active ingredient
  | { kind: "condition"; value: string } // a recorded chronic condition
  | { kind: "age_under_months"; value: number };

export interface SafetyRule {
  id: string;
  /** Matches when the proposed product has this class... */
  proposedClass?: string;
  /** ...or this active ingredient. */
  proposedIngredient?: string;
  against: Against;
  severity: Severity;
  action: RuleAction;
  rationale: string;
  /** Ingredient suggested instead; it is re-verified against the patient before being offered. */
  alternative?: string;
  sources: string[];
}

// Source ids. The set ids are the labels' SPL set ids; re-check them on DailyMed.
const OTC_IBUPROFEN = "FDA-LABEL:030d9bca-a934-6ef9-e063-6394a90a8277@v4"; // Advil Dual Action label: anticoagulant/steroid, diuretic, heart/kidney/BP, ulcer wording
const ELIQUIS_5_2 = "ELIQUIS-PI:5.2-Bleeding"; // NSAIDs, aspirin and other antiplatelets, other anticoagulants increase bleeding risk
const LISINOPRIL_PI = "FDA-LABEL:00f67e1a-6999-4295-9c9f-fcb1ce9711b8@v22"; // lisinopril/HCTZ label, Drug Interactions: NSAIDs; agents increasing serum potassium
const INFANT_MOTRIN = "FDA-LABEL:c2302bfe-b367-4867-b803-29f066a42dc7@v10"; // chart: under 6 mos ask a doctor
const TYLENOL_ES = "FDA-LABEL:0c5fdda8-5049-46de-e063-6294a90a592b@v2"; // warfarin wording
const BAYER_ASPIRIN = "FDA-LABEL:070d5713-e018-2913-e054-00144ff8d46c@v5"; // Reye's syndrome; under 12 consult a doctor
const NYQUIL_SEVERE = "FDA-LABEL:efb5f0b9-9825-ab23-e053-2995a90a26ab@v9"; // ask a doctor (BP, heart, diabetes...); under 4 do not use; 4-12 ask a doctor

export const SAFETY_RULES: SafetyRule[] = [
  // ---- NSAIDs with other drugs
  {
    id: "SR-NSAID-ANTICOAGULANT",
    proposedClass: "nsaid",
    against: { kind: "class", value: "anticoagulant" },
    severity: "CRITICAL",
    action: "BLOCK",
    rationale: "NSAIDs raise bleeding risk with blood thinners (anticoagulants).",
    alternative: "acetaminophen",
    sources: [OTC_IBUPROFEN, ELIQUIS_5_2],
  },
  {
    id: "SR-ANTIPLATELET-ANTICOAGULANT",
    proposedClass: "antiplatelet",
    against: { kind: "class", value: "anticoagulant" },
    severity: "CRITICAL",
    action: "BLOCK",
    rationale: "Aspirin and other antiplatelet drugs raise bleeding risk with blood thinners.",
    alternative: "acetaminophen",
    sources: [ELIQUIS_5_2],
  },
  {
    id: "SR-NSAID-ANTIPLATELET",
    proposedClass: "nsaid",
    against: { kind: "class", value: "antiplatelet" },
    severity: "MAJOR",
    action: "CLINICIAN",
    rationale: "The label says to ask a doctor before use if taking aspirin for heart attack or stroke; NSAIDs also add bleeding risk.",
    alternative: "acetaminophen",
    sources: [OTC_IBUPROFEN, ELIQUIS_5_2],
  },
  {
    id: "SR-NSAID-CORTICOSTEROID",
    proposedClass: "nsaid",
    against: { kind: "class", value: "corticosteroid" },
    severity: "MAJOR",
    action: "CLINICIAN",
    rationale: "The label warns of a higher stomach-bleeding risk when taking a blood thinner or steroid drug.",
    alternative: "acetaminophen",
    sources: [OTC_IBUPROFEN],
  },
  {
    id: "SR-NSAID-DIURETIC",
    proposedClass: "nsaid",
    against: { kind: "class", value: "diuretic" },
    severity: "MAJOR",
    action: "CLINICIAN",
    rationale: "The label says to ask a doctor before use if taking a diuretic.",
    alternative: "acetaminophen",
    sources: [OTC_IBUPROFEN],
  },
  {
    id: "SR-NSAID-ACE-INHIBITOR",
    proposedClass: "nsaid",
    against: { kind: "class", value: "ace_inhibitor" },
    severity: "MAJOR",
    action: "CLINICIAN",
    rationale: "NSAIDs can worsen kidney function and weaken the blood-pressure effect of ACE inhibitors such as lisinopril.",
    alternative: "acetaminophen",
    sources: [LISINOPRIL_PI],
  },
  // ---- NSAIDs with conditions
  {
    id: "SR-NSAID-KIDNEY-DISEASE",
    proposedClass: "nsaid",
    against: { kind: "condition", value: "chronic_kidney_disease" },
    severity: "MAJOR",
    action: "CLINICIAN",
    rationale: "The label says to ask a doctor before use with kidney disease.",
    alternative: "acetaminophen",
    sources: [OTC_IBUPROFEN],
  },
  {
    id: "SR-NSAID-HEART-DISEASE",
    proposedClass: "nsaid",
    against: { kind: "condition", value: "heart_disease" },
    severity: "MAJOR",
    action: "CLINICIAN",
    rationale: "The label says to ask a doctor before use with heart disease.",
    alternative: "acetaminophen",
    sources: [OTC_IBUPROFEN],
  },
  {
    id: "SR-NSAID-HYPERTENSION",
    proposedClass: "nsaid",
    against: { kind: "condition", value: "hypertension" },
    severity: "MODERATE",
    action: "CLINICIAN",
    rationale: "The label says to ask a doctor before use with high blood pressure.",
    alternative: "acetaminophen",
    sources: [OTC_IBUPROFEN],
  },
  {
    id: "SR-NSAID-STOMACH-ULCER",
    proposedClass: "nsaid",
    against: { kind: "condition", value: "stomach_ulcer" },
    severity: "MAJOR",
    action: "CLINICIAN",
    rationale: "The label warns against use after stomach ulcers or bleeding problems without asking a doctor.",
    alternative: "acetaminophen",
    sources: [OTC_IBUPROFEN],
  },
  // ---- Age rules
  {
    id: "SR-IBUPROFEN-UNDER-6-MONTHS",
    proposedIngredient: "ibuprofen",
    against: { kind: "age_under_months", value: 6 },
    severity: "CRITICAL",
    action: "BLOCK",
    rationale: "The infant ibuprofen label says to ask a doctor under 6 months of age.",
    sources: [INFANT_MOTRIN],
  },
  {
    id: "SR-ASPIRIN-UNDER-12",
    proposedIngredient: "aspirin",
    against: { kind: "age_under_months", value: 144 },
    severity: "CRITICAL",
    action: "BLOCK",
    rationale: "Aspirin labels say children under 12 should consult a doctor, and warn of Reye's syndrome in children recovering from flu-like illness or chickenpox.",
    sources: [BAYER_ASPIRIN],
  },
  {
    id: "SR-COLD-COMBO-UNDER-4",
    proposedClass: "cough_cold",
    against: { kind: "age_under_months", value: 48 },
    severity: "CRITICAL",
    action: "BLOCK",
    rationale: "Cough and cold combination products say children under 4 should not use them.",
    sources: [NYQUIL_SEVERE],
  },
  {
    id: "SR-COLD-COMBO-4-TO-12",
    proposedClass: "cough_cold",
    against: { kind: "age_under_months", value: 144 },
    severity: "MAJOR",
    action: "CLINICIAN",
    rationale: "Cough and cold combination products say children 4 to under 12 should ask a doctor first.",
    sources: [NYQUIL_SEVERE],
  },
  // ---- Other combinations
  {
    id: "SR-DECONGESTANT-HYPERTENSION",
    proposedClass: "decongestant",
    against: { kind: "condition", value: "hypertension" },
    severity: "MAJOR",
    action: "BLOCK",
    rationale: "Decongestants such as phenylephrine can raise blood pressure; the label says to ask a doctor with high blood pressure.",
    sources: [NYQUIL_SEVERE],
  },
  {
    id: "SR-ACETAMINOPHEN-WARFARIN",
    proposedIngredient: "acetaminophen",
    against: { kind: "ingredient", value: "warfarin" },
    severity: "MODERATE",
    action: "CLINICIAN",
    rationale: "The acetaminophen label says to ask a doctor or pharmacist before use when taking the blood thinner warfarin.",
    sources: [TYLENOL_ES],
  },
  {
    id: "SR-POTASSIUM-ACE-INHIBITOR",
    proposedClass: "potassium_supplement",
    against: { kind: "class", value: "ace_inhibitor" },
    severity: "MAJOR",
    action: "CLINICIAN",
    rationale: "Potassium supplements and potassium-containing salt substitutes can significantly raise potassium in people taking ACE inhibitors.",
    sources: [LISINOPRIL_PI],
  },
];

export const RULE_COUNT = SAFETY_RULES.length;
