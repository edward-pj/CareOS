// Mirrors the careos-server HTTP contract (GET /api/state, POST /api/converse, turn event stream).
// Hand-written so the browser bundle never imports server packages.

export type LockStatus = "DOUBLE_DOSE_LOCKED" | "DAILY_MAX_REACHED";

export interface PatientProfile {
  id: string;
  name: string;
  kind: "infant" | "elder";
  dobMs: number;
  weightLbs?: number;
  activeRx: string[];
  conditions: string[];
  allergies: string[];
  age_days: number;
  weight_kg: number | null;
}

export interface DoseLedgerEntry {
  eventId: string;
  patientId: string;
  medication: string;
  ingredient: string;
  caregiver: string;
  /** Epoch ms. */
  at: number;
  volumeMl?: number;
}

export interface ActiveLock {
  ingredient: string;
  status: LockStatus;
  next_eligible_time: string;
}

export interface PatientSnapshot {
  profile: PatientProfile;
  medication_history: DoseLedgerEntry[];
  active_locks: ActiveLock[];
}

export interface Caregiver {
  id: string;
  name: string;
}

export interface InventoryItem {
  id: string;
  name: string;
  unit: "mL" | "count" | "pantry";
  remaining: number;
  lowThreshold: number;
}

export interface StateResponse {
  now: string;
  patients: PatientSnapshot[];
  caregivers: Caregiver[];
  inventory: InventoryItem[];
}

export type CardType =
  | "SYRINGE_CALIBRATOR"
  | "DOUBLE_DOSE_INTERCEPT"
  | "CONTRAINDICATION_SHIELD"
  | "PANTRY_REMEDY"
  | "AMAZON_RESTOCK_CAROUSEL";

export type TurnEvent =
  | { seq: number; type: "assistant_delta"; data: { text: string } }
  | { seq: number; type: "tool_call"; data: { id: string; name: string; input: Record<string, unknown> } }
  | { seq: number; type: "tool_result"; data: { id: string; name: string; status?: string; is_error: boolean } }
  | { seq: number; type: "card"; data: { card_type: CardType; tool: string; payload: Record<string, unknown> } }
  | { seq: number; type: "alert"; data: { kind: string; violation_type?: string | null; offending?: string[]; tool?: string } }
  | { seq: number; type: "error"; data: { message: string } }
  | { seq: number; type: "done"; data: Record<string, never> };

export const TURN_EVENT_TYPES = ["assistant_delta", "tool_call", "tool_result", "card", "alert", "error", "done"] as const;

export interface ConverseRequest {
  session_id: string;
  active_profile: string;
  caregiver: string;
  transcript: string;
}

/** One JSON-RPC frame crossing /mcp, as emitted by GET /api/trace. */
export interface TraceFrame {
  id: number;
  ts: number;
  dir: "in" | "out";
  kind: "call" | "result" | "blocked" | "error" | "other";
  method?: string;
  tool?: string;
  summary: string;
  message: unknown;
}

export interface OverrideRequest {
  patient_id: string;
  ingredient: string;
  caregiver: string;
  pin: string;
}
