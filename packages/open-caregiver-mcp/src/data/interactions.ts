export type Severity = "CRITICAL" | "MAJOR" | "MODERATE";

export interface InteractionRule {
  /** Class of the proposed drug. */
  proposed: string;
  /** Class of the active prescription, or a chronic condition (prefix "condition:"). */
  active: string;
  severity: Severity;
  rationale: string;
  /** Ingredient suggested instead; re-verified against the patient before being returned. */
  alternative?: string;
}

export const INTERACTION_RULES: InteractionRule[] = [
  {
    proposed: "nsaid",
    active: "anticoagulant",
    severity: "CRITICAL",
    rationale: "Severe gastrointestinal hemorrhage risk when combining anticoagulants with NSAIDs.",
    alternative: "acetaminophen",
  },
  {
    proposed: "nsaid",
    active: "ace_inhibitor",
    severity: "MAJOR",
    rationale: "NSAIDs can blunt ACE-inhibitor blood-pressure control and raise kidney injury risk.",
    alternative: "acetaminophen",
  },
  {
    proposed: "antiplatelet",
    active: "anticoagulant",
    severity: "CRITICAL",
    rationale: "Aspirin plus an anticoagulant markedly raises bleeding risk.",
    alternative: "acetaminophen",
  },
  {
    proposed: "decongestant",
    active: "condition:hypertension",
    severity: "MAJOR",
    rationale: "Decongestants can raise blood pressure.",
  },
];
