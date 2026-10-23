// The shapes every safety tool returns. One envelope, so a client (Alexa+, the simulator, curl) can rely on the same
// fields whichever tool it called, and so the Numeric Guard knows which text is allowed to carry numbers.

export type CardType =
  | "SYRINGE_CALIBRATOR"
  | "TABLET_DOSE"
  | "DOUBLE_DOSE_INTERCEPT"
  | "CONTRAINDICATION_SHIELD"
  | "MEMORY_CONFLICT"
  | "CONFIRM_DOSE"
  | "NEEDS_INFO"
  | "PANTRY_REMEDY"
  | "AMAZON_RESTOCK_CAROUSEL"
  | "EMERGENCY_LOCATOR"
  | "RED_FLAG_CHECKLIST"
  | "NURSE_LINE_BRIEF"
  | "RX_CONFIRMATION"
  | "LABEL_LENS"
  | null;

/** The verdict vocabulary of the safety pipeline (PRD §4.3). */
export type PlanStatus = "APPROVED" | "BLOCKED" | "ALTERNATE_SUGGESTED" | "NEEDS_CLINICIAN" | "NEEDS_INFO";

export type Payload = Record<string, unknown> & { status: string; card_type: CardType };

/** Present on every safety-relevant result. */
export interface SafetyEnvelope {
  /** Read this verbatim. Two sentences at most, numbers in digits and words, always with units. */
  speech: string;
  /** What to say or do next, if anything (kept out of `speech` so `speech` stays short). */
  followup?: string;
  reason_codes: string[];
  /** Label SKU + version, or rule id, behind the verdict (S9). */
  sources: string[];
  /** The model must not paraphrase `speech`. */
  read_verbatim: true;
}

export type PlanPayload = Payload & SafetyEnvelope & { patient_id: string; patient_name: string };
