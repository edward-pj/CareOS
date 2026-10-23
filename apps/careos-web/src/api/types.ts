// Mirrors the careos-server HTTP contract (GET /api/state, POST /api/converse, turn event stream).
// Hand-written so the browser bundle never imports server packages.

export type LockStatus = "DOUBLE_DOSE_LOCKED" | "DAILY_MAX_REACHED";

export interface PatientProfile {
  id: string;
  name: string;
  kind: "infant" | "elder";
  dobMs: number;
  weightLbs?: number;
  weightAt?: number;
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
  amountMg?: number;
  sku?: string;
}

export interface Observation {
  id: string;
  patientId: string;
  type: "temperature" | "weight" | "glucose" | "blood_pressure" | "wet_diapers";
  value: number;
  unit: string;
  /** Epoch ms. */
  at: number;
  source: string;
}

export interface ActiveLock {
  ingredient: string;
  status: LockStatus;
  next_eligible_time: string;
}

export interface PatientSnapshot {
  profile: PatientProfile;
  medication_history: DoseLedgerEntry[];
  observations: Observation[];
  active_locks: ActiveLock[];
  weight_days_ago: number | null;
}

export interface Caregiver {
  id: string;
  name: string;
}

export interface InventoryItem {
  id: string;
  name: string;
  sku?: string;
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
  | "LABEL_LENS";

/** The Numeric Guard replaced a model draft that stated a number no tool had returned. */
export interface NumericGuardEvent {
  kind: "numeric_guard.blocked";
  offending: string[];
  draft: string;
  replacement: string;
}

export type TurnEvent =
  | { seq: number; type: "assistant_delta"; data: { text: string; verbatim?: boolean; followup?: string } }
  | { seq: number; type: "tool_call"; data: { id: string; name: string; input: Record<string, unknown> } }
  | { seq: number; type: "tool_result"; data: { id: string; name: string; status?: string; is_error: boolean } }
  | { seq: number; type: "card"; data: { card_type: CardType; tool: string; payload: Record<string, unknown> } }
  | { seq: number; type: "alert"; data: { kind: string; violation_type?: string | null; offending?: string[]; tool?: string } }
  | { seq: number; type: "numeric_guard"; data: NumericGuardEvent }
  | { seq: number; type: "error"; data: { message: string } }
  | { seq: number; type: "done"; data: Record<string, never> };

export const TURN_EVENT_TYPES = ["assistant_delta", "tool_call", "tool_result", "card", "alert", "numeric_guard", "error", "done"] as const;

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
  householdId?: string;
  kind: "call" | "result" | "blocked" | "error" | "other";
  method?: string;
  tool?: string;
  summary: string;
  message: unknown;
}

export interface AuditEntry {
  id: string;
  at: number;
  tool: string;
  patientId?: string;
  caregiver?: string;
  inputHash: string;
  verdict: string;
  reasonCodes: string[];
}

export interface AdviceMemory {
  id: string;
  patientId: string;
  topic: string;
  advice: string;
  drug: string;
  givenBy: string;
  at: number;
}

/** GET /api/inspect: read-only view of what is stored for this household. */
export interface InspectResponse {
  backend: string;
  household_id: string;
  ledger: DoseLedgerEntry[];
  observations: Observation[];
  audit: AuditEntry[];
  advice: AdviceMemory[];
  episodes: InspectEpisode[];
  prescriptions: InspectPrescription[];
}

export interface InspectEpisode { id: string; patientId: string; status: "OPEN" | "CLOSED"; urgency: string; openedAt: number; updatedAt: number; redFlags: string[]; timeline: { at: number; type: string; text: string }[] }
export interface InspectPrescription { id: string; patientId: string; drug: string; strength?: string; status: "PENDING" | "ACTIVE"; source: string; flags: string[] }

/** GET /healthz */
export interface Health {
  ok: boolean;
  name: string;
  version: string;
  mcp: { endpoint: string; transport: string; spec: string; stateless: boolean };
  auth: string;
}

// ------------------------------------------------------------------ simulated Amazon storefront (GET /api/shop)

export type OrderStage = "PLACED" | "PACKED" | "SHIPPED" | "OUT_FOR_DELIVERY" | "DELIVERED";
export type ShopChannel = "prime" | "pharmacy" | "fresh";

export interface ShopLine {
  name: string;
  channel: ShopChannel;
  merchant: string;
  price_usd: number;
  restocks: { inventoryId: string; amount: number } | null;
}

/** A cart (status STAGED) or an order (ORDERED / DELIVERED / CANCELLED). Every number and label here comes from the server. */
export interface ShopOrder {
  cart_id: string;
  order_id: string | null;
  status: "STAGED" | "ORDERED" | "DELIVERED" | "CANCELLED";
  stage: OrderStage | null;
  stage_label: string | null;
  can_cancel: boolean;
  lines: ShopLine[];
  total_usd: number;
  eta: string;
  created_at: number;
  created_by: string | null;
  ordered_at: number | null;
  ordered_by: string | null;
  delivered_at: number | null;
  cancelled_at: number | null;
  schedule: { stage: OrderStage; label: string; at: number }[] | null;
}

export interface ShopView {
  /** Server clock (epoch ms) when this view was built. */
  now: number;
  simulated: true;
  stages: { stage: OrderStage; label: string }[];
  delivery_seconds: number;
  cart: ShopOrder | null;
  orders: ShopOrder[];
  suggestions: { inventory_id: string; name: string; remaining: number; unit: string; item_name: string; price_usd: number; channel: ShopChannel; merchant: string }[];
  supplies: { id: string; name: string; remaining: number; unit: "mL" | "count" | "pantry"; low_threshold: number; low: boolean }[];
  catalog: { name: string; channel: ShopChannel; merchant: string; price_usd: number; restocks: { inventoryId: string; amount: number } | null }[];
  activity: { at: number; text: string; cart_id: string }[];
}

export type ShopEventType = "cart.staged" | "cart.discarded" | "order.placed" | "order.stage" | "order.delivered" | "order.cancelled" | "inventory.changed" | "inventory.low" | "shop.updated";

/** A change notice pushed on GET /api/shop/stream. The screen re-reads /api/shop when one arrives. */
export interface ShopEvent {
  id: number;
  type: ShopEventType;
  at: number;
  actor?: string;
  cartId?: string;
  orderId?: string;
  stage?: OrderStage;
  summary: string;
}

export type ShopScenario = "dad_orders" | "low_stock" | "fast_forward" | "reset_orders";
