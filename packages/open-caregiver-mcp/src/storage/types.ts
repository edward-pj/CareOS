import type { IntervalResult, LedgerEntry } from "../engines/intervalLock.js";
import type { Urgency } from "../data/redFlagRules.js";
import type { SeedData } from "./seed.js";

export interface Patient {
  id: string; // "leo", "frank"
  name: string;
  kind: "infant" | "elder";
  dobMs: number;
  /** Last known weight and WHEN it was taken. A weight without a date cannot be trusted for dosing (S2). */
  weightLbs?: number;
  weightAt?: number;
  /** CONFIRMED active medications only. Prescriptions parsed from a photo stay pending until a caregiver confirms (S6). */
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
  /** Registry SKU this bottle is, so a dose of one product never empties another's bottle. */
  sku?: string;
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
  /** Registry SKU, when the dose came from a known product. */
  sku?: string;
  /** Milligrams of `ingredient` in this dose; feeds the cross-product daily ceiling (S4). */
  amountMg?: number;
}

export type ObservationType = "temperature" | "weight" | "glucose" | "blood_pressure" | "wet_diapers";

/** A measurement a caregiver reported. Weight observations are what dosing relies on. */
export interface Observation {
  id: string;
  patientId: string;
  type: ObservationType;
  value: number;
  /** "F", "C", "lb", "kg", "mg/dL", "count"... */
  unit: string;
  /** When it was measured (epoch ms). */
  at: number;
  /** Who reported it. */
  source: string;
}

/** Append-only record of every safety decision (PRD §9.1). Feeds the Data Inspector and the doctor export. */
export interface AuditEntry {
  id: string;
  at: number;
  tool: string;
  patientId?: string;
  caregiver?: string;
  /** Short hash of the inputs, so repeats are recognisable without storing free text. */
  inputHash: string;
  verdict: string;
  reasonCodes: string[];
}

/** Advice the household remembers ("last time Dad's gout flared, Dr. Rao said naproxen"). Re-checked on every recall. */
export interface AdviceMemory {
  id: string;
  patientId: string;
  topic: string;
  advice: string;
  /** The medication the advice names, so it can be re-verified against today's chart. */
  drug: string;
  givenBy: string;
  /** When the advice was given (epoch ms). */
  at: number;
}

/** One thing that happened during an illness episode. */
export interface EpisodeEvent {
  at: number;
  type: "OPENED" | "TRIAGE" | "CHECKIN" | "DOSE" | "NOTE" | "CLOSED";
  text: string;
}

/** An illness that stays open across hours: what was reported, how urgent it was judged, and what happened next. */
export interface Episode {
  id: string;
  patientId: string;
  status: "OPEN" | "CLOSED";
  openedAt: number;
  updatedAt: number;
  urgency: Urgency;
  /** Ids of the red-flag rules that have fired. */
  redFlags: string[];
  timeline: EpisodeEvent[];
  /** What was last reported, in plain words ("stiff neck, temperature 101.4°F"). Used for the nurse-line summary. */
  concern?: string;
  /** While in the future, home dosing is ruled out for this person (a vomited dose, a feverish newborn). */
  noHomeDosingUntil?: number;
}

/** PENDING came from a photo and has not been confirmed by a person: it NEVER reaches a safety check (S6). */
export type RxStatus = "PENDING" | "ACTIVE";

export interface Prescription {
  id: string;
  patientId: string;
  drug: string;
  strength?: string;
  frequency?: string;
  prescriber?: string;
  status: RxStatus;
  source: "photo" | "manual";
  /** Which uploaded image it was read from. Images themselves are not stored. */
  uploadId?: string;
  /** Per-field confidence from the reader, 0 to 1. Low values are highlighted for the human check. */
  confidence?: Record<string, number>;
  /** Things the reader or the checks noticed, e.g. UNRECOGNIZED_DRUG. */
  flags: string[];
  createdAt: number;
  confirmedAt?: number;
}

export type CommitResult =
  | { ok: true; event: DoseEvent; inventoryRemaining?: number; lowStock: boolean; replay: boolean }
  | { ok: false; reason: "LOCKED" | "DAILY_MAX" | "INSUFFICIENT_STOCK"; interval?: IntervalResult };

export interface CommitDoseArgs {
  event: DoseEvent;
  rule: { minIntervalHours: number; maxDosesPer24h: number };
  inventoryItemId?: string;
  now: number;
}

export interface CartLine {
  itemName: string;
  channel: "prime" | "pharmacy" | "fresh";
  priceUsd: number;
  merchantLabel: string;
  /** What a delivery adds to the house (an inventory item and how much), so a delivered order refills the bottle. */
  restocks?: { inventoryId: string; amount: number };
}

/** STAGED -> ORDERED -> DELIVERED, or CANCELLED from STAGED / an order that has not shipped. */
export type CartStatus = "STAGED" | "ORDERED" | "DELIVERED" | "CANCELLED";

export interface Cart {
  cartId: string;
  lines: CartLine[];
  totalUsd: number;
  eta: string;
  status: CartStatus;
  orderId?: string;
  /** Epoch ms. 0 on carts written before these fields existed. */
  createdAt: number;
  createdBy?: string;
  orderedAt?: number;
  orderedBy?: string;
  cancelledAt?: number;
  /** Set exactly once, by the same step that refills the inventory. */
  deliveredAt?: number;
  source?: "voice" | "ui" | "low_stock" | "demo";
}

/** Household used by single-tenant entry points (stdio bin, tests, the unauthenticated demo server). */
export const DEFAULT_HOUSEHOLD_ID = "demo";

/**
 * Multi-tenant entry point. Every read and write goes through an adapter scoped to ONE household,
 * so one household can never read, overwrite or wipe another's data (PRD §8.1).
 */
export interface StorageRoot {
  forHousehold(householdId: string): StorageAdapter;
}

/**
 * Persistence contract (scoped to a single household). `commitDose` MUST be atomic: the interval check, the
 * event write and the inventory decrement succeed or fail together, so two
 * caregivers dosing at once cannot both win. (DynamoDB: TransactWriteItems.)
 */
export interface StorageAdapter {
  /** Wipe this household's state and load the seed. Never touches other households. Demo/test only. */
  reset(seed: SeedData): Promise<void>;
  getPatient(id: string): Promise<Patient | undefined>;
  listPatients(): Promise<Patient[]>;
  getCaregivers(): Promise<Caregiver[]>;
  getLedger(patientId: string): Promise<DoseEvent[]>;
  getEventByKey(idempotencyKey: string): Promise<DoseEvent | undefined>;
  getInventory(): Promise<InventoryItem[]>;
  addObservation(o: Observation): Promise<void>;
  getObservations(patientId: string, type?: ObservationType): Promise<Observation[]>;
  /** Replaces the patient's last-known weight (and when it was taken). */
  setPatientWeight(patientId: string, weightLbs: number, at: number): Promise<void>;
  appendAudit(e: AuditEntry): Promise<void>;
  /** Newest first. */
  getAudit(limit?: number): Promise<AuditEntry[]>;
  getAdvice(patientId?: string): Promise<AdviceMemory[]>;
  commitDose(args: CommitDoseArgs): Promise<CommitResult>;
  saveCart(cart: Cart): Promise<void>;
  getCart(cartId: string): Promise<Cart | undefined>;
  /** Newest first. */
  listCarts(limit?: number): Promise<Cart[]>;
  /**
   * Compare-and-set: applies `patch` ONLY if the cart is currently in one of `from`, and returns the updated cart
   * (undefined when the cart is missing or the status had already moved on). Two caregivers pressing "order" at once
   * therefore place one order, and a delivery refills the inventory once.
   */
  transitionCart(cartId: string, from: CartStatus[], patch: Partial<Omit<Cart, "cartId">>): Promise<Cart | undefined>;
  getEpisodes(patientId?: string): Promise<Episode[]>;
  /** Insert or replace by id. */
  saveEpisode(e: Episode): Promise<void>;
  getPrescriptions(patientId?: string): Promise<Prescription[]>;
  savePrescription(r: Prescription): Promise<void>;
  deletePrescription(id: string): Promise<void>;
  /** Replaces the list of CONFIRMED medicines the safety checks read. */
  setActiveRx(patientId: string, activeRx: string[]): Promise<void>;
  /**
   * Removes the profile and every record about the person: doses (and their idempotency keys), locks, observations,
   * remembered advice, episodes and prescriptions. The audit trail is append-only and is kept: it holds tool names,
   * verdicts and hashes, no names or measurements.
   */
  deletePatient(patientId: string): Promise<void>;
  /** Atomic increment (negative to decrement, floored at 0). Returns the new quantity, or undefined for an unknown item. */
  addInventory(itemId: string, delta: number): Promise<number | undefined>;
}

export interface Notifier {
  /** Returns a message id when one exists. */
  send(kind: "DOSE_LOGGED" | "LOCKOUT_ATTEMPT" | "CRITICAL_BLOCK" | "ORDER_PLACED" | "ORDER_DELIVERED" | "EMERGENCY" | "CHECKIN", text: string): Promise<string | undefined>;
}
