import { INGREDIENT_CLASSES, ingredientsOf, lookupDrug } from "../data/drugClasses.js";
import { SAFETY_RULES, type RuleAction, type SafetyRule, type Severity } from "../data/safetyRules.js";

/** Layers B (prescriptions / ingredients) and C (conditions / age) of the plan pipeline. Pure and deterministic. */
export interface PatientClinical {
  /** CONFIRMED active medications only. A pending prescription photo never reaches this list (S6). */
  activeRx: string[];
  conditions: string[];
  allergies: string[];
  ageMonths: number;
}

export interface ProposedProduct {
  /** What the caller called it, for messages. */
  name: string;
  ingredients: string[];
  classes: string[];
}

export type FindingType = "ALLERGY" | "DUPLICATE_INGREDIENT" | "DRUG_CONTRAINDICATION" | "CONDITION" | "AGE_GATE";

export interface SafetyFinding {
  ruleId: string;
  type: FindingType;
  severity: Severity;
  action: RuleAction;
  /** The prescription, condition or age that triggered it. */
  conflictingRx: string;
  rationale: string;
  alternative?: string;
  sources: string[];
}

export type SafetyResult =
  | { status: "CLEAR"; ingredients: string[] }
  | ({ status: "BLOCKED" | "NEEDS_CLINICIAN"; findings: SafetyFinding[] } & Omit<SafetyFinding, "action">);

const SEVERITY_RANK: Record<Severity, number> = { CRITICAL: 3, MAJOR: 2, MODERATE: 1 };
const ACTION_RANK: Record<RuleAction, number> = { BLOCK: 2, CLINICIAN: 1 };

export function productFromName(name: string): ProposedProduct | undefined {
  const d = lookupDrug(name);
  return d ? { name, ingredients: d.ingredients, classes: d.classes } : undefined;
}

export function productFromIngredient(ingredient: string): ProposedProduct {
  return { name: ingredient, ingredients: [ingredient], classes: INGREDIENT_CLASSES[ingredient] ?? [] };
}

function activeClasses(rx: string[]): { name: string; ingredients: string[]; classes: string[] }[] {
  return rx.flatMap((name) => {
    const d = lookupDrug(name);
    return d ? [{ name, ingredients: d.ingredients, classes: d.classes }] : [];
  });
}

function collect(product: ProposedProduct, p: PatientClinical): SafetyFinding[] {
  const out: SafetyFinding[] = [];
  const active = activeClasses(p.activeRx);

  // Allergy to any ingredient (CRITICAL, always a block).
  const allergyIngredients = ingredientsOf(p.allergies);
  for (const ing of product.ingredients) {
    if (allergyIngredients.includes(ing)) {
      out.push({ ruleId: "SR-ALLERGY", type: "ALLERGY", severity: "CRITICAL", action: "BLOCK", conflictingRx: ing, rationale: `${ing} is on this person's allergy list.`, sources: ["CHART:allergies"] });
    }
  }

  // The same ingredient is already an active medication (duplicate therapy).
  for (const a of active) {
    const shared = a.ingredients.find((i) => product.ingredients.includes(i));
    if (shared) {
      out.push({ ruleId: "SR-DUPLICATE-INGREDIENT", type: "DUPLICATE_INGREDIENT", severity: "MAJOR", action: "BLOCK", conflictingRx: a.name, rationale: `${shared} is already an active medication.`, sources: ["CHART:active-medications"] });
    }
  }

  for (const r of SAFETY_RULES) {
    const proposedMatches =
      (r.proposedClass !== undefined && product.classes.includes(r.proposedClass)) ||
      (r.proposedIngredient !== undefined && product.ingredients.includes(r.proposedIngredient));
    if (!proposedMatches) continue;

    const hit = matchAgainst(r, active, p);
    if (!hit) continue;
    out.push({
      ruleId: r.id,
      type: r.against.kind === "condition" ? "CONDITION" : r.against.kind === "age_under_months" ? "AGE_GATE" : "DRUG_CONTRAINDICATION",
      severity: r.severity,
      action: r.action,
      conflictingRx: hit,
      rationale: r.rationale,
      alternative: r.alternative,
      sources: r.sources,
    });
  }
  return out;
}

/** Returns a short description of what matched (the active drug, condition or age), or undefined. */
function matchAgainst(r: SafetyRule, active: ReturnType<typeof activeClasses>, p: PatientClinical): string | undefined {
  const a = r.against;
  if (a.kind === "class") return active.find((x) => x.classes.includes(a.value))?.name;
  if (a.kind === "ingredient") return active.find((x) => x.ingredients.includes(a.value))?.name;
  if (a.kind === "condition") return p.conditions.includes(a.value) ? a.value.replace(/_/g, " ") : undefined;
  return p.ageMonths < a.value ? `age ${Math.floor(p.ageMonths)} months` : undefined;
}

function rank(f: SafetyFinding): number {
  return ACTION_RANK[f.action] * 10 + SEVERITY_RANK[f.severity];
}

/** Evaluates a proposed product against the patient's chart. Any suggested alternative is re-verified first. */
export function evaluateSafety(product: ProposedProduct, p: PatientClinical): SafetyResult {
  const findings = collect(product, p).sort((a, b) => rank(b) - rank(a));
  const top = findings[0];
  if (!top) return { status: "CLEAR", ingredients: product.ingredients };

  let alternative = top.alternative;
  if (alternative) {
    // Only offer an alternative that is itself safe for this exact patient.
    const alt = collect(productFromIngredient(alternative), p);
    if (alt.length > 0) alternative = undefined;
  }
  const { action, ...rest } = top;
  return { status: action === "BLOCK" ? "BLOCKED" : "NEEDS_CLINICIAN", ...rest, alternative, findings };
}

/**
 * Convenience wrapper for callers that only have a medication NAME (e.g. re-checking remembered advice).
 * An unrecognised name cannot be verified, so it fails closed.
 */
export function verifyDrugSafety(name: string, p: PatientClinical): SafetyResult {
  const product = productFromName(name);
  if (!product) {
    return {
      status: "NEEDS_CLINICIAN",
      ruleId: "SR-UNKNOWN-PRODUCT",
      type: "DRUG_CONTRAINDICATION",
      severity: "MODERATE",
      conflictingRx: "n/a",
      rationale: `"${name}" is not in the verified medication list, so it cannot be cleared.`,
      sources: [],
      findings: [],
    };
  }
  return evaluateSafety(product, p);
}
