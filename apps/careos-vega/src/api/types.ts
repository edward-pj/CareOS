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
