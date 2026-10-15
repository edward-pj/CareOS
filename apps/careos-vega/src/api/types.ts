// Mirrors GET /api/state from apps/careos-server (CareService.patientSnapshot + storage listings).
// Kept as a hand-written contract so the Vega bundle never imports server packages.

export type LockStatus = 'DOUBLE_DOSE_LOCKED' | 'DAILY_MAX_REACHED';

export interface PatientProfile {
  id: string;
  name: string;
  kind: 'infant' | 'elder';
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
  unit: 'mL' | 'count' | 'pantry';
  remaining: number;
  lowThreshold: number;
}

export interface StateResponse {
  now: string;
  patients: PatientSnapshot[];
  caregivers: Caregiver[];
  inventory: InventoryItem[];
}

// ---- Conversation (Phase 4 server contract: POST /api/converse, GET /api/turns/:id/events)

export type CardType =
  | 'SYRINGE_CALIBRATOR'
  | 'DOUBLE_DOSE_INTERCEPT'
  | 'CONTRAINDICATION_SHIELD'
  | 'PANTRY_REMEDY'
  | 'AMAZON_RESTOCK_CAROUSEL';

export type TurnEvent =
  | {seq: number; type: 'assistant_delta'; data: {text: string}}
  | {seq: number; type: 'tool_call'; data: {id: string; name: string; input: Record<string, unknown>}}
  | {seq: number; type: 'tool_result'; data: {id: string; name: string; status?: string; is_error: boolean}}
  | {seq: number; type: 'card'; data: {card_type: CardType; tool: string; payload: Record<string, unknown>}}
  | {seq: number; type: 'alert'; data: {kind: string; violation_type?: string | null; offending?: string[]; tool?: string}}
  | {seq: number; type: 'error'; data: {message: string}}
  | {seq: number; type: 'done'; data: Record<string, never>};

export interface TurnPage {
  events: TurnEvent[];
  done: boolean;
  /** Cursor to pass as `after` on the next request. */
  next: number;
}

export interface ConverseRequest {
  session_id: string;
  active_profile: string;
  caregiver: string;
  transcript: string;
}
