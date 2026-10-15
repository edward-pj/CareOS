import type { IntervalResult, LedgerEntry } from "../engines/intervalLock.js";

export interface Patient {
  id: string; // "leo", "frank"
  name: string;
  kind: "infant" | "elder";
  dobMs: number;
  weightLbs?: number;
  activeRx: string[];
  conditions: string[];
  allergies: string[];
}

export interface Caregiver {
  id: string;
  name: string; // "Sarah (Mom)"
  phone?: string;
}

export interface InventoryItem {
  id: string;
  name: string;
  /** Ingredient it supplies, for dose-linked decrement. */
  ingredient?: string;
  unit: "mL" | "count" | "pantry";
  remaining: number;
  lowThreshold: number;
}

export interface DoseEvent extends LedgerEntry {
  eventId: string;
  patientId: string;
  medication: string;
  temperatureF?: number;
  idempotencyKey: string;
}

export type CommitResult =
  | { ok: true; event: DoseEvent; inventoryRemaining?: number; lowStock: boolean; replay: boolean }
  | { ok: false; reason: "LOCKED" | "DAILY_MAX" | "INSUFFICIENT_STOCK"; interval?: IntervalResult };

export interface CommitDoseArgs {
  event: DoseEvent;
  rule: { minIntervalHours: number; maxDosesPer24h: number };
  inventoryItemId?: string;
  now: number;
  /** True when a valid PIN override is active; skips the interval check only. */
  bypassLock: boolean;
}

export interface CartLine {
  itemName: string;
  channel: "prime" | "pharmacy" | "fresh";
  priceUsd: number;
  merchantLabel: string;
}
export interface Cart {
  cartId: string;
  lines: CartLine[];
  totalUsd: number;
  eta: string;
  status: "STAGED" | "ORDERED";
  orderId?: string;
}

/**
 * Persistence contract. `commitDose` MUST be atomic: the interval check, the
 * event write and the inventory decrement succeed or fail together, so two
 * caregivers dosing at once cannot both win. (DynamoDB: TransactWriteItems.)
 */
export interface StorageAdapter {
  getPatient(id: string): Promise<Patient | undefined>;
  listPatients(): Promise<Patient[]>;
  getCaregivers(): Promise<Caregiver[]>;
  getLedger(patientId: string): Promise<DoseEvent[]>;
  getEventByKey(idempotencyKey: string): Promise<DoseEvent | undefined>;
  getInventory(): Promise<InventoryItem[]>;
  commitDose(args: CommitDoseArgs): Promise<CommitResult>;
  saveCart(cart: Cart): Promise<void>;
  getCart(cartId: string): Promise<Cart | undefined>;
  setOverride(patientId: string, ingredient: string, expiresAt: number): Promise<void>;
  getOverride(patientId: string, ingredient: string): Promise<number | undefined>;
}

export interface Notifier {
  /** Returns a message id when one exists. */
  send(kind: "DOSE_LOGGED" | "LOCKOUT_ATTEMPT" | "CRITICAL_BLOCK" | "OVERRIDE_USED", text: string): Promise<string | undefined>;
}
