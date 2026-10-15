import { lookupDrug } from "../data/drugClasses.js";
import { INTERACTION_RULES, type Severity } from "../data/interactions.js";

export interface PatientClinical {
  activeRx: string[];
  conditions: string[]; // e.g. "hypertension", "type2_diabetes"
  allergies: string[];
}

export type SafetyResult =
  | { status: "CLEAR"; ingredient: string }
  | {
      status: "BLOCKED";
      violationType: "DRUG_CONTRAINDICATION" | "ALLERGY" | "DUPLICATE_INGREDIENT" | "UNKNOWN_DRUG";
      severity: Severity;
      conflictingRx: string;
      rationale: string;
      approvedAlternative?: string;
    };

function check(proposed: string, p: PatientClinical): SafetyResult {
  const drug = lookupDrug(proposed);
  if (!drug) {
    return {
      status: "BLOCKED",
      violationType: "UNKNOWN_DRUG",
      severity: "MODERATE",
      conflictingRx: "n/a",
      rationale: `"${proposed}" is not in the verified medication list, so it cannot be cleared.`,
    };
  }

  for (const a of p.allergies) {
    const al = lookupDrug(a);
    if (al && al.ingredient === drug.ingredient) {
      return { status: "BLOCKED", violationType: "ALLERGY", severity: "CRITICAL", conflictingRx: a, rationale: `Patient has a recorded allergy to ${drug.ingredient}.` };
    }
  }

  for (const rx of p.activeRx) {
    const info = lookupDrug(rx);
    if (!info) continue;
    if (info.ingredient === drug.ingredient) {
      return { status: "BLOCKED", violationType: "DUPLICATE_INGREDIENT", severity: "MAJOR", conflictingRx: rx, rationale: `${drug.ingredient} is already an active medication.` };
    }
    for (const rule of INTERACTION_RULES) {
      if (drug.classes.includes(rule.proposed) && info.classes.includes(rule.active)) {
        return { status: "BLOCKED", violationType: "DRUG_CONTRAINDICATION", severity: rule.severity, conflictingRx: rx, rationale: rule.rationale, approvedAlternative: rule.alternative };
      }
    }
  }
  for (const c of p.conditions) {
    for (const rule of INTERACTION_RULES) {
      if (drug.classes.includes(rule.proposed) && rule.active === `condition:${c}`) {
        return { status: "BLOCKED", violationType: "DRUG_CONTRAINDICATION", severity: rule.severity, conflictingRx: c, rationale: rule.rationale, approvedAlternative: rule.alternative };
      }
    }
  }
  return { status: "CLEAR", ingredient: drug.ingredient };
}

export function verifyDrugSafety(proposed: string, patient: PatientClinical): SafetyResult {
  const result = check(proposed, patient);
  // An alternative is only offered if it is itself safe for this patient.
  if (result.status === "BLOCKED" && result.approvedAlternative) {
    const alt = check(result.approvedAlternative, patient);
    if (alt.status !== "CLEAR") return { ...result, approvedAlternative: undefined };
  }
  return result;
}
