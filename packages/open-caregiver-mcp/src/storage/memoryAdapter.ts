import { checkInterval } from "../engines/intervalLock.js";
import type { Cart, Caregiver, CommitDoseArgs, CommitResult, DoseEvent, InventoryItem, Notifier, Patient, StorageAdapter } from "./types.js";
import type { SeedData } from "./seed.js";

export class MemoryAdapter implements StorageAdapter {
  private patients = new Map<string, Patient>();
  private caregivers: Caregiver[] = [];
  private inventory = new Map<string, InventoryItem>();
  private ledger: DoseEvent[] = [];
  private carts = new Map<string, Cart>();
  private overrides = new Map<string, number>();

  constructor(seed: SeedData) {
    this.load(seed);
  }

  load(seed: SeedData): void {
    this.patients = new Map(seed.patients.map((p) => [p.id, structuredClone(p)]));
    this.caregivers = structuredClone(seed.caregivers);
    this.inventory = new Map(seed.inventory.map((i) => [i.id, structuredClone(i)]));
    this.ledger = structuredClone(seed.ledger);
    this.carts.clear();
    this.overrides.clear();
  }

  async getPatient(id: string) { return this.patients.get(id); }
  async listPatients() { return [...this.patients.values()]; }
  async getCaregivers() { return this.caregivers; }
  async getLedger(patientId: string) { return this.ledger.filter((e) => e.patientId === patientId); }
  async getEventByKey(key: string) { return this.ledger.find((e) => e.idempotencyKey === key); }
  async getInventory() { return [...this.inventory.values()]; }
  async saveCart(cart: Cart) { this.carts.set(cart.cartId, structuredClone(cart)); }
  async getCart(id: string) { return this.carts.get(id); }
  async setOverride(p: string, ing: string, exp: number) { this.overrides.set(`${p}:${ing}`, exp); }
  async getOverride(p: string, ing: string) { return this.overrides.get(`${p}:${ing}`); }

  // No `await` between the checks and the writes: single-threaded JS makes this atomic.
  async commitDose(a: CommitDoseArgs): Promise<CommitResult> {
    const existing = this.ledger.find((e) => e.idempotencyKey === a.event.idempotencyKey);
    if (existing) {
      const item = a.inventoryItemId ? this.inventory.get(a.inventoryItemId) : undefined;
      return { ok: true, event: existing, inventoryRemaining: item?.remaining, lowStock: item ? item.remaining < item.lowThreshold : false, replay: true };
    }
    const own = this.ledger.filter((e) => e.patientId === a.event.patientId);
    const interval = checkInterval(own, a.event.ingredient, a.rule, a.now);
    if (interval.status === "DAILY_MAX_REACHED") return { ok: false, reason: "DAILY_MAX", interval };
    if (interval.status === "DOUBLE_DOSE_LOCKED" && !a.bypassLock) return { ok: false, reason: "LOCKED", interval };

    const item = a.inventoryItemId ? this.inventory.get(a.inventoryItemId) : undefined;
    const vol = a.event.volumeMl ?? 0;
    if (item && item.unit === "mL" && item.remaining < vol) return { ok: false, reason: "INSUFFICIENT_STOCK" };

    this.ledger.push(a.event);
    if (item && item.unit === "mL") item.remaining = Math.round((item.remaining - vol) * 100) / 100;
    return { ok: true, event: a.event, inventoryRemaining: item?.remaining, lowStock: item ? item.remaining < item.lowThreshold : false, replay: false };
  }
}

export class MemoryNotifier implements Notifier {
  sent: { kind: string; text: string }[] = [];
  async send(kind: Parameters<Notifier["send"]>[0], text: string) {
    this.sent.push({ kind, text });
    return `mem-${this.sent.length}`;
  }
}
