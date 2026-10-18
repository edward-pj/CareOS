import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  checkInterval,
  type Cart,
  type Caregiver,
  type CommitDoseArgs,
  type CommitResult,
  type DoseEvent,
  type InventoryItem,
  type Notifier,
  type Patient,
  type SeedData,
  type StorageAdapter,
} from "open-caregiver-mcp";

export class SupabaseStorage implements StorageAdapter {
  private client: SupabaseClient;

  constructor(url: string, key: string, client?: SupabaseClient) {
    this.client = client ?? createClient(url, key, { auth: { persistSession: false } });
  }

  async reset(seed: SeedData): Promise<void> {
    // Delete in dependency order
    await this.client.from("dose_ledger").delete().neq("event_id", "");
    await this.client.from("overrides").delete().neq("patient_id", "");
    await this.client.from("carts").delete().neq("cart_id", "");
    await this.client.from("inventory").delete().neq("id", "");
    await this.client.from("caregivers").delete().neq("id", "");
    await this.client.from("patients").delete().neq("id", "");

    // Populate patients
    if (seed.patients.length > 0) {
      const rows = seed.patients.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        dob_ms: p.dobMs,
        weight_lbs: p.weightLbs ?? null,
        active_rx: p.activeRx,
        conditions: p.conditions,
        allergies: p.allergies,
      }));
      const { error } = await this.client.from("patients").insert(rows);
      if (error) throw new Error(`reset patients failed: ${error.message}`);
    }

    // Populate caregivers
    if (seed.caregivers.length > 0) {
      const rows = seed.caregivers.map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone ?? null,
      }));
      const { error } = await this.client.from("caregivers").insert(rows);
      if (error) throw new Error(`reset caregivers failed: ${error.message}`);
    }

    // Populate inventory
    if (seed.inventory.length > 0) {
      const rows = seed.inventory.map((i) => ({
        id: i.id,
        name: i.name,
        ingredient: i.ingredient ?? null,
        unit: i.unit,
        remaining: i.remaining,
        low_threshold: i.lowThreshold,
      }));
      const { error } = await this.client.from("inventory").insert(rows);
      if (error) throw new Error(`reset inventory failed: ${error.message}`);
    }

    // Populate ledger
    if (seed.ledger.length > 0) {
      const rows = seed.ledger.map((e) => ({
        event_id: e.eventId,
        patient_id: e.patientId,
        at: e.at,
        caregiver: e.caregiver,
        medication: e.medication,
        ingredient: e.ingredient,
        volume_ml: e.volumeMl ?? null,
        temperature_f: e.temperatureF ?? null,
        idempotency_key: e.idempotencyKey,
      }));
      const { error } = await this.client.from("dose_ledger").insert(rows);
      if (error) throw new Error(`reset ledger failed: ${error.message}`);
    }
  }

  async getPatient(id: string): Promise<Patient | undefined> {
    const { data, error } = await this.client.from("patients").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`getPatient failed: ${error.message}`);
    if (!data) return undefined;
    return {
      id: data.id,
      name: data.name,
      kind: data.kind,
      dobMs: Number(data.dob_ms),
      weightLbs: data.weight_lbs != null ? Number(data.weight_lbs) : undefined,
      activeRx: data.active_rx ?? [],
      conditions: data.conditions ?? [],
      allergies: data.allergies ?? [],
    };
  }

  async listPatients(): Promise<Patient[]> {
    const { data, error } = await this.client.from("patients").select("*");
    if (error) throw new Error(`listPatients failed: ${error.message}`);
    return (data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      dobMs: Number(row.dob_ms),
      weightLbs: row.weight_lbs != null ? Number(row.weight_lbs) : undefined,
      activeRx: row.active_rx ?? [],
      conditions: row.conditions ?? [],
      allergies: row.allergies ?? [],
    }));
  }

  async getCaregivers(): Promise<Caregiver[]> {
    const { data, error } = await this.client.from("caregivers").select("*");
    if (error) throw new Error(`getCaregivers failed: ${error.message}`);
    return (data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone ?? undefined,
    }));
  }

  async getLedger(patientId: string): Promise<DoseEvent[]> {
    const { data, error } = await this.client
      .from("dose_ledger")
      .select("*")
      .eq("patient_id", patientId)
      .order("at", { ascending: true });
    if (error) throw new Error(`getLedger failed: ${error.message}`);
    return (data ?? []).map((row) => ({
      eventId: row.event_id,
      patientId: row.patient_id,
      at: Number(row.at),
      caregiver: row.caregiver,
      medication: row.medication,
      ingredient: row.ingredient,
      volumeMl: row.volume_ml != null ? Number(row.volume_ml) : undefined,
      temperatureF: row.temperature_f != null ? Number(row.temperature_f) : undefined,
      idempotencyKey: row.idempotency_key,
    }));
  }

  async getEventByKey(idempotencyKey: string): Promise<DoseEvent | undefined> {
    const { data, error } = await this.client
      .from("dose_ledger")
      .select("*")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error) throw new Error(`getEventByKey failed: ${error.message}`);
    if (!data) return undefined;
    return {
      eventId: data.event_id,
      patientId: data.patient_id,
      at: Number(data.at),
      caregiver: data.caregiver,
      medication: data.medication,
      ingredient: data.ingredient,
      volumeMl: data.volume_ml != null ? Number(data.volume_ml) : undefined,
      temperatureF: data.temperature_f != null ? Number(data.temperature_f) : undefined,
      idempotencyKey: data.idempotency_key,
    };
  }

  async getInventory(): Promise<InventoryItem[]> {
    const { data, error } = await this.client.from("inventory").select("*");
    if (error) throw new Error(`getInventory failed: ${error.message}`);
    return (data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      ingredient: row.ingredient ?? undefined,
      unit: row.unit,
      remaining: Number(row.remaining),
      lowThreshold: Number(row.low_threshold),
    }));
  }

  async saveCart(cart: Cart): Promise<void> {
    const { error } = await this.client.from("carts").upsert({
      cart_id: cart.cartId,
      lines: cart.lines,
      total_usd: cart.totalUsd,
      eta: cart.eta,
      status: cart.status,
      order_id: cart.orderId ?? null,
    });
    if (error) throw new Error(`saveCart failed: ${error.message}`);
  }

  async getCart(cartId: string): Promise<Cart | undefined> {
    const { data, error } = await this.client.from("carts").select("*").eq("cart_id", cartId).maybeSingle();
    if (error) throw new Error(`getCart failed: ${error.message}`);
    if (!data) return undefined;
    return {
      cartId: data.cart_id,
      lines: data.lines,
      totalUsd: Number(data.total_usd),
      eta: data.eta,
      status: data.status,
      orderId: data.order_id ?? undefined,
    };
  }

  async setOverride(patientId: string, ingredient: string, expiresAt: number): Promise<void> {
    const { error } = await this.client.from("overrides").upsert({
      patient_id: patientId,
      ingredient,
      expires_at: expiresAt,
    });
    if (error) throw new Error(`setOverride failed: ${error.message}`);
  }

  async getOverride(patientId: string, ingredient: string): Promise<number | undefined> {
    const { data, error } = await this.client
      .from("overrides")
      .select("expires_at")
      .eq("patient_id", patientId)
      .eq("ingredient", ingredient)
      .maybeSingle();
    if (error) throw new Error(`getOverride failed: ${error.message}`);
    return data?.expires_at != null ? Number(data.expires_at) : undefined;
  }

  async commitDose(a: CommitDoseArgs): Promise<CommitResult> {
    const existing = await this.getEventByKey(a.event.idempotencyKey);
    if (existing) {
      const inv = a.inventoryItemId ? await this.getInventoryItem(a.inventoryItemId) : undefined;
      return {
        ok: true,
        event: existing,
        inventoryRemaining: inv?.remaining,
        lowStock: inv ? inv.remaining < inv.lowThreshold : false,
        replay: true,
      };
    }

    const ledger = await this.getLedger(a.event.patientId);
    const interval = checkInterval(ledger, a.event.ingredient, a.rule, a.now);
    if (interval.status === "DAILY_MAX_REACHED") return { ok: false, reason: "DAILY_MAX", interval };
    if (interval.status === "DOUBLE_DOSE_LOCKED" && !a.bypassLock) return { ok: false, reason: "LOCKED", interval };

    const inv = a.inventoryItemId ? await this.getInventoryItem(a.inventoryItemId) : undefined;
    const vol = a.event.volumeMl ?? 0;
    if (inv && inv.unit === "mL" && inv.remaining < vol) {
      return { ok: false, reason: "INSUFFICIENT_STOCK" };
    }

    // Insert dose event
    const { error: insertError } = await this.client.from("dose_ledger").insert({
      event_id: a.event.eventId,
      patient_id: a.event.patientId,
      at: a.event.at,
      caregiver: a.event.caregiver,
      medication: a.event.medication,
      ingredient: a.event.ingredient,
      volume_ml: a.event.volumeMl ?? null,
      temperature_f: a.event.temperatureF ?? null,
      idempotency_key: a.event.idempotencyKey,
    });
    if (insertError) {
      // Check if duplicate idempotency key raced
      const race = await this.getEventByKey(a.event.idempotencyKey);
      if (race) {
        return {
          ok: true,
          event: race,
          inventoryRemaining: inv?.remaining,
          lowStock: inv ? inv.remaining < inv.lowThreshold : false,
          replay: true,
        };
      }
      throw new Error(`commitDose insert failed: ${insertError.message}`);
    }

    let remaining: number | undefined;
    if (inv && inv.unit === "mL" && vol > 0) {
      remaining = Math.round((inv.remaining - vol) * 100) / 100;
      await this.client.from("inventory").update({ remaining }).eq("id", inv.id);
    } else if (inv) {
      remaining = inv.remaining;
    }

    return {
      ok: true,
      event: a.event,
      inventoryRemaining: remaining,
      lowStock: inv && remaining !== undefined ? remaining < inv.lowThreshold : false,
      replay: false,
    };
  }

  private async getInventoryItem(id: string): Promise<InventoryItem | undefined> {
    const { data, error } = await this.client.from("inventory").select("*").eq("id", id).maybeSingle();
    if (error || !data) return undefined;
    return {
      id: data.id,
      name: data.name,
      ingredient: data.ingredient ?? undefined,
      unit: data.unit,
      remaining: Number(data.remaining),
      lowThreshold: Number(data.low_threshold),
    };
  }
}

/** Broadcasts alerts into Supabase Realtime careos_alerts table. */
export class SupabaseNotifier implements Notifier {
  constructor(private client: SupabaseClient) {}

  async send(kind: Parameters<Notifier["send"]>[0], text: string): Promise<string | undefined> {
    try {
      const { data, error } = await this.client
        .from("careos_alerts")
        .insert({ kind, message: text })
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
