import type { SupabaseClient } from "@supabase/supabase-js";
import {
  checkInterval,
  DEFAULT_HOUSEHOLD_ID,
  type AdviceMemory,
  type AuditEntry,
  type Observation,
  type ObservationType,
  type Cart,
  type CartStatus,
  type Episode,
  type Prescription,
  type Caregiver,
  type CommitDoseArgs,
  type CommitResult,
  type DoseEvent,
  type InventoryItem,
  type Notifier,
  type Patient,
  type SeedData,
  type StorageAdapter,
  type StorageRoot,
} from "open-caregiver-mcp";

type Row = Record<string, any>;

const toPatient = (r: Row): Patient => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  dobMs: Number(r.dob_ms),
  weightLbs: r.weight_lbs != null ? Number(r.weight_lbs) : undefined,
  weightAt: r.weight_at != null ? Number(r.weight_at) : undefined,
  activeRx: r.active_rx ?? [],
  conditions: r.conditions ?? [],
  allergies: r.allergies ?? [],
});

const toEvent = (r: Row): DoseEvent => ({
  eventId: r.event_id,
  patientId: r.patient_id,
  at: Number(r.at),
  caregiver: r.caregiver,
  medication: r.medication,
  ingredient: r.ingredient,
  volumeMl: r.volume_ml != null ? Number(r.volume_ml) : undefined,
  temperatureF: r.temperature_f != null ? Number(r.temperature_f) : undefined,
  idempotencyKey: r.idempotency_key,
  sku: r.sku ?? undefined,
  amountMg: r.amount_mg != null ? Number(r.amount_mg) : undefined,
});

const toInventory = (r: Row): InventoryItem => ({
  id: r.id,
  name: r.name,
  ingredient: r.ingredient ?? undefined,
  sku: r.sku ?? undefined,
  unit: r.unit,
  remaining: Number(r.remaining),
  lowThreshold: Number(r.low_threshold),
});

const cartPatchToRow = (p: Partial<Omit<Cart, "cartId">>): Row => {
  const row: Row = {};
  if (p.lines !== undefined) row.lines = p.lines;
  if (p.totalUsd !== undefined) row.total_usd = p.totalUsd;
  if (p.eta !== undefined) row.eta = p.eta;
  if (p.status !== undefined) row.status = p.status;
  if (p.orderId !== undefined) row.order_id = p.orderId;
  if (p.createdAt !== undefined) row.created_at_ms = p.createdAt;
  if (p.createdBy !== undefined) row.created_by = p.createdBy;
  if (p.orderedAt !== undefined) row.ordered_at_ms = p.orderedAt;
  if (p.orderedBy !== undefined) row.ordered_by = p.orderedBy;
  if (p.cancelledAt !== undefined) row.cancelled_at_ms = p.cancelledAt;
  if (p.deliveredAt !== undefined) row.delivered_at_ms = p.deliveredAt;
  if (p.source !== undefined) row.source = p.source;
  return row;
};
const cartToRow = (c: Cart): Row => ({ ...cartPatchToRow(c), order_id: c.orderId ?? null });
const toCart = (r: Row): Cart => ({
  cartId: r.cart_id,
  lines: r.lines,
  totalUsd: Number(r.total_usd),
  eta: r.eta,
  status: r.status,
  orderId: r.order_id ?? undefined,
  createdAt: Number(r.created_at_ms ?? 0),
  createdBy: r.created_by ?? undefined,
  orderedAt: r.ordered_at_ms != null ? Number(r.ordered_at_ms) : undefined,
  orderedBy: r.ordered_by ?? undefined,
  cancelledAt: r.cancelled_at_ms != null ? Number(r.cancelled_at_ms) : undefined,
  deliveredAt: r.delivered_at_ms != null ? Number(r.delivered_at_ms) : undefined,
  source: r.source ?? undefined,
});

/**
 * Supabase (Postgres) backend, scoped to one household. Every query filters on household_id and every
 * write sets it. The dose commit is the `commit_dose` SQL function (scripts/supabase-schema.sql), which runs
 * the interval check, ledger insert, inventory decrement and lock upsert in a single transaction.
 */
export class SupabaseStorage implements StorageAdapter {
  constructor(private client: SupabaseClient, readonly householdId = DEFAULT_HOUSEHOLD_ID) {}

  private fail(what: string, error: { message: string }): never {
    throw new Error(`${what} failed: ${error.message}`);
  }

  async reset(seed: SeedData): Promise<void> {
    const hid = this.householdId;
    // Children before parents. Only THIS household's rows are touched.
    // (audit_log is append-only by design and is not wiped.)
    for (const table of ["dose_ledger", "dose_locks", "observations", "advice_memory", "episodes", "prescriptions", "carts", "inventory", "caregivers", "patients"]) {
      const { error } = await this.client.from(table).delete().eq("household_id", hid);
      if (error) this.fail(`reset ${table}`, error);
    }
    const household = await this.client.from("households").upsert({ id: hid, name: hid });
    if (household.error) this.fail("reset household", household.error);

    const insert = async (table: string, rows: Row[]) => {
      if (rows.length === 0) return;
      const { error } = await this.client.from(table).insert(rows.map((r) => ({ household_id: hid, ...r })));
      if (error) this.fail(`reset ${table}`, error);
    };
    await insert("patients", seed.patients.map((p) => ({
      id: p.id, name: p.name, kind: p.kind, dob_ms: p.dobMs, weight_lbs: p.weightLbs ?? null, weight_at: p.weightAt ?? null,
      active_rx: p.activeRx, conditions: p.conditions, allergies: p.allergies,
    })));
    await insert("caregivers", seed.caregivers.map((c) => ({ id: c.id, name: c.name, phone: c.phone ?? null })));
    await insert("inventory", seed.inventory.map((i) => ({
      id: i.id, name: i.name, ingredient: i.ingredient ?? null, sku: i.sku ?? null, unit: i.unit, remaining: i.remaining, low_threshold: i.lowThreshold,
    })));
    await insert("dose_ledger", seed.ledger.map((e) => ({
      event_id: e.eventId, patient_id: e.patientId, at: e.at, caregiver: e.caregiver, medication: e.medication,
      ingredient: e.ingredient, volume_ml: e.volumeMl ?? null, temperature_f: e.temperatureF ?? null, idempotency_key: e.idempotencyKey,
      sku: e.sku ?? null, amount_mg: e.amountMg ?? null,
    })));
    await insert("observations", seed.observations.map((o) => ({ id: o.id, patient_id: o.patientId, type: o.type, value: o.value, unit: o.unit, at: o.at, source: o.source })));
    await insert("advice_memory", seed.advice.map((a) => ({ id: a.id, patient_id: a.patientId, topic: a.topic, advice: a.advice, drug: a.drug, given_by: a.givenBy, at: a.at })));
  }

  async getPatient(id: string): Promise<Patient | undefined> {
    const { data, error } = await this.client.from("patients").select("*").eq("household_id", this.householdId).eq("id", id).maybeSingle();
    if (error) this.fail("getPatient", error);
    return data ? toPatient(data) : undefined;
  }

  async listPatients(): Promise<Patient[]> {
    const { data, error } = await this.client.from("patients").select("*").eq("household_id", this.householdId);
    if (error) this.fail("listPatients", error);
    return (data ?? []).map(toPatient);
  }

  async getCaregivers(): Promise<Caregiver[]> {
    const { data, error } = await this.client.from("caregivers").select("*").eq("household_id", this.householdId);
    if (error) this.fail("getCaregivers", error);
    return (data ?? []).map((r) => ({ id: r.id, name: r.name, phone: r.phone ?? undefined }));
  }

  async getLedger(patientId: string): Promise<DoseEvent[]> {
    const { data, error } = await this.client
      .from("dose_ledger")
      .select("*")
      .eq("household_id", this.householdId)
      .eq("patient_id", patientId)
      .order("at", { ascending: true });
    if (error) this.fail("getLedger", error);
    return (data ?? []).map(toEvent);
  }

  async getEventByKey(idempotencyKey: string): Promise<DoseEvent | undefined> {
    const { data, error } = await this.client
      .from("dose_ledger")
      .select("*")
      .eq("household_id", this.householdId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error) this.fail("getEventByKey", error);
    return data ? toEvent(data) : undefined;
  }

  async getInventory(): Promise<InventoryItem[]> {
    const { data, error } = await this.client.from("inventory").select("*").eq("household_id", this.householdId);
    if (error) this.fail("getInventory", error);
    return (data ?? []).map(toInventory);
  }

  private async getInventoryItem(id: string): Promise<InventoryItem | undefined> {
    const { data, error } = await this.client.from("inventory").select("*").eq("household_id", this.householdId).eq("id", id).maybeSingle();
    if (error) this.fail("getInventoryItem", error);
    return data ? toInventory(data) : undefined;
  }

  async addObservation(o: Observation): Promise<void> {
    const { error } = await this.client.from("observations").insert({
      household_id: this.householdId, id: o.id, patient_id: o.patientId, type: o.type, value: o.value, unit: o.unit, at: o.at, source: o.source,
    });
    if (error) this.fail("addObservation", error);
  }

  async getObservations(patientId: string, type?: ObservationType): Promise<Observation[]> {
    let q = this.client.from("observations").select("*").eq("household_id", this.householdId).eq("patient_id", patientId);
    if (type) q = q.eq("type", type);
    const { data, error } = await q.order("at", { ascending: true });
    if (error) this.fail("getObservations", error);
    return (data ?? []).map((r) => ({ id: r.id, patientId: r.patient_id, type: r.type, value: Number(r.value), unit: r.unit, at: Number(r.at), source: r.source }));
  }

  async setPatientWeight(patientId: string, weightLbs: number, at: number): Promise<void> {
    const { error } = await this.client.from("patients").update({ weight_lbs: weightLbs, weight_at: at }).eq("household_id", this.householdId).eq("id", patientId);
    if (error) this.fail("setPatientWeight", error);
  }

  async appendAudit(e: AuditEntry): Promise<void> {
    const { error } = await this.client.from("audit_log").insert({
      household_id: this.householdId, id: e.id, at: e.at, tool: e.tool, patient_id: e.patientId ?? null, caregiver: e.caregiver ?? null,
      input_hash: e.inputHash, verdict: e.verdict, reason_codes: e.reasonCodes,
    });
    if (error) this.fail("appendAudit", error);
  }

  async getAudit(limit = 100): Promise<AuditEntry[]> {
    const { data, error } = await this.client.from("audit_log").select("*").eq("household_id", this.householdId).order("at", { ascending: false }).order("id", { ascending: false }).limit(limit);
    if (error) this.fail("getAudit", error);
    return (data ?? []).map((r) => ({ id: r.id, at: Number(r.at), tool: r.tool, patientId: r.patient_id ?? undefined, caregiver: r.caregiver ?? undefined, inputHash: r.input_hash, verdict: r.verdict, reasonCodes: r.reason_codes ?? [] }));
  }

  async getAdvice(patientId?: string): Promise<AdviceMemory[]> {
    let q = this.client.from("advice_memory").select("*").eq("household_id", this.householdId);
    if (patientId) q = q.eq("patient_id", patientId);
    const { data, error } = await q;
    if (error) this.fail("getAdvice", error);
    return (data ?? []).map((r) => ({ id: r.id, patientId: r.patient_id, topic: r.topic, advice: r.advice, drug: r.drug, givenBy: r.given_by, at: Number(r.at) }));
  }

  async getEpisodes(patientId?: string): Promise<Episode[]> {
    let q = this.client.from("episodes").select("data").eq("household_id", this.householdId);
    if (patientId) q = q.eq("patient_id", patientId);
    const { data, error } = await q.order("opened_at", { ascending: false });
    if (error) this.fail("getEpisodes", error);
    return (data ?? []).map((r) => r.data as Episode);
  }

  async saveEpisode(e: Episode): Promise<void> {
    const { error } = await this.client.from("episodes").upsert({ household_id: this.householdId, id: e.id, patient_id: e.patientId, status: e.status, opened_at: e.openedAt, data: e });
    if (error) this.fail("saveEpisode", error);
  }

  async getPrescriptions(patientId?: string): Promise<Prescription[]> {
    let q = this.client.from("prescriptions").select("data").eq("household_id", this.householdId);
    if (patientId) q = q.eq("patient_id", patientId);
    const { data, error } = await q.order("created_at_ms", { ascending: true });
    if (error) this.fail("getPrescriptions", error);
    return (data ?? []).map((r) => r.data as Prescription);
  }

  async savePrescription(r: Prescription): Promise<void> {
    const { error } = await this.client.from("prescriptions").upsert({ household_id: this.householdId, id: r.id, patient_id: r.patientId, status: r.status, created_at_ms: r.createdAt, data: r });
    if (error) this.fail("savePrescription", error);
  }

  async deletePrescription(id: string): Promise<void> {
    const { error } = await this.client.from("prescriptions").delete().eq("household_id", this.householdId).eq("id", id);
    if (error) this.fail("deletePrescription", error);
  }

  async setActiveRx(patientId: string, activeRx: string[]): Promise<void> {
    const { error } = await this.client.from("patients").update({ active_rx: activeRx }).eq("household_id", this.householdId).eq("id", patientId);
    if (error) this.fail("setActiveRx", error);
  }

  /** Every table that references patients(household_id, id) cascades, so one delete removes the whole person. */
  async deletePatient(patientId: string): Promise<void> {
    const { error } = await this.client.from("patients").delete().eq("household_id", this.householdId).eq("id", patientId);
    if (error) this.fail("deletePatient", error);
  }

  async saveCart(cart: Cart): Promise<void> {
    const { error } = await this.client.from("carts").upsert({ household_id: this.householdId, cart_id: cart.cartId, ...cartToRow(cart) });
    if (error) this.fail("saveCart", error);
  }

  async getCart(cartId: string): Promise<Cart | undefined> {
    const { data, error } = await this.client.from("carts").select("*").eq("household_id", this.householdId).eq("cart_id", cartId).maybeSingle();
    if (error) this.fail("getCart", error);
    return data ? toCart(data) : undefined;
  }

  async listCarts(limit = 50): Promise<Cart[]> {
    const { data, error } = await this.client.from("carts").select("*").eq("household_id", this.householdId).order("created_at_ms", { ascending: false }).limit(limit);
    if (error) this.fail("listCarts", error);
    return (data ?? []).map(toCart);
  }

  /** One UPDATE ... WHERE status IN (...) RETURNING: Postgres makes the check and the write a single atomic step. */
  async transitionCart(cartId: string, from: CartStatus[], patch: Partial<Omit<Cart, "cartId">>): Promise<Cart | undefined> {
    const { data, error } = await this.client.from("carts").update(cartPatchToRow(patch)).eq("household_id", this.householdId).eq("cart_id", cartId).in("status", from).select();
    if (error) this.fail("transitionCart", error);
    return data && data.length > 0 ? toCart(data[0]!) : undefined;
  }

  async addInventory(itemId: string, delta: number): Promise<number | undefined> {
    const { data, error } = await this.client.rpc("add_inventory", { p_household: this.householdId, p_item: itemId, p_delta: delta });
    if (error) this.fail("addInventory", error);
    return data === null || data === undefined ? undefined : Number(data);
  }

  /** One round trip, one transaction: see `commit_dose` in scripts/supabase-schema.sql. */
  async commitDose(a: CommitDoseArgs): Promise<CommitResult> {
    const e = a.event;
    const { data, error } = await this.client.rpc("commit_dose", {
      p_household: this.householdId,
      p_event: {
        event_id: e.eventId,
        patient_id: e.patientId,
        at: e.at,
        caregiver: e.caregiver,
        medication: e.medication,
        ingredient: e.ingredient,
        volume_ml: e.volumeMl ?? null,
        temperature_f: e.temperatureF ?? null,
        idempotency_key: e.idempotencyKey,
        sku: e.sku ?? null,
        amount_mg: e.amountMg ?? null,
      },
      p_min_interval_hours: a.rule.minIntervalHours,
      p_max_doses: a.rule.maxDosesPer24h,
      p_inventory_item: a.inventoryItemId ?? null,
      p_now: a.now,
    });
    if (error) this.fail("commitDose", error);

    const status = (data as { status?: string } | null)?.status;
    switch (status) {
      case "OK": {
        const remaining = (data as { inventory_remaining?: number | null }).inventory_remaining;
        const inv = a.inventoryItemId ? await this.getInventoryItem(a.inventoryItemId) : undefined;
        return {
          ok: true,
          event: e,
          inventoryRemaining: remaining != null ? Number(remaining) : inv?.remaining,
          lowStock: inv ? inv.remaining < inv.lowThreshold : false,
          replay: false,
        };
      }
      case "REPLAY": {
        const prior = await this.getEventByKey(e.idempotencyKey);
        if (!prior) throw new Error("commitDose: replay reported but no ledger row was found");
        const inv = a.inventoryItemId ? await this.getInventoryItem(a.inventoryItemId) : undefined;
        return { ok: true, event: prior, inventoryRemaining: inv?.remaining, lowStock: inv ? inv.remaining < inv.lowThreshold : false, replay: true };
      }
      case "LOCKED":
      case "DAILY_MAX": {
        // The decision was made in SQL; rebuild the card details with the same pure engine the other backends use.
        const interval = checkInterval(await this.getLedger(e.patientId), e.ingredient, a.rule, a.now);
        return { ok: false, reason: status === "DAILY_MAX" ? "DAILY_MAX" : "LOCKED", interval };
      }
      case "INSUFFICIENT_STOCK":
        return { ok: false, reason: "INSUFFICIENT_STOCK" };
      default:
        throw new Error(`commitDose: unexpected result ${JSON.stringify(data)}`);
    }
  }
}

/** Multi-tenant entry point: one SupabaseStorage per household over a shared client. */
/** Every table and the columns the adapter reads or writes; the preflight selects each one. */
const REQUIRED_SCHEMA: Record<string, string> = {
  households: "id",
  patients: "id",
  caregivers: "id",
  inventory: "id",
  dose_ledger: "event_id",
  dose_locks: "patient_id",
  careos_alerts: "id",
  observations: "at",
  advice_memory: "id",
  audit_log: "id",
  carts: "cart_id,lines,status,created_at_ms,created_by,ordered_at_ms,ordered_by,cancelled_at_ms,delivered_at_ms,source",
  episodes: "id,opened_at,data",
  prescriptions: "id,created_at_ms,data",
};

export class SupabaseRoot implements StorageRoot {
  constructor(private client: SupabaseClient) {}

  /** Fails at boot, with the fix, when the database is behind scripts/supabase-schema.sql (instead of on the first request). */
  async assertSchema(): Promise<void> {
    const problems: string[] = [];
    for (const [table, columns] of Object.entries(REQUIRED_SCHEMA)) {
      const { error } = await this.client.from(table).select(columns).limit(1);
      if (error) problems.push(`${table}: ${error.message}`);
    }
    if (problems.length > 0) {
      throw new Error(`Supabase schema is out of date:\n  - ${problems.join("\n  - ")}\nRun scripts/supabase-schema.sql (re-runnable) in the Supabase SQL editor, then restart.`);
    }
  }

  forHousehold(householdId: string): SupabaseStorage {
    return new SupabaseStorage(this.client, householdId);
  }
}

/** Writes alerts into the Realtime-enabled careos_alerts table (in-app fallback while SNS is unavailable). */
export class SupabaseNotifier implements Notifier {
  constructor(private client: SupabaseClient, private householdId = DEFAULT_HOUSEHOLD_ID) {}

  async send(kind: Parameters<Notifier["send"]>[0], text: string): Promise<string | undefined> {
    try {
      const { data, error } = await this.client
        .from("careos_alerts")
        .insert({ household_id: this.householdId, kind, message: text })
        .select("id")
        .single();
      if (error) {
        console.error(`[supabase-alert] failed: ${error.message}`);
        return undefined;
      }
      return String(data?.id);
    } catch (e) {
      console.error("[supabase-alert] exception:", e);
      return undefined;
    }
  }
}
