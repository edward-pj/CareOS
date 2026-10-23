import { checkInterval } from "../engines/intervalLock.js";
import type { AdviceMemory, AuditEntry, Cart, CartStatus, Caregiver, Episode, Prescription, CommitDoseArgs, CommitResult, DoseEvent, InventoryItem, Notifier, Observation, ObservationType, Patient, StorageAdapter, StorageRoot } from "./types.js";
import type { SeedData } from "./seed.js";

export class MemoryAdapter implements StorageAdapter {
  private patients = new Map<string, Patient>();
  private caregivers: Caregiver[] = [];
  private inventory = new Map<string, InventoryItem>();
  private ledger: DoseEvent[] = [];
  private carts = new Map<string, Cart>();
  private observations: Observation[] = [];
  private audit: AuditEntry[] = [];
  private advice: AdviceMemory[] = [];
  private episodes = new Map<string, Episode>();
  private prescriptions = new Map<string, Prescription>();

  constructor(seed: SeedData) {
    this.load(seed);
  }

  load(seed: SeedData): void {
    this.patients = new Map(seed.patients.map((p) => [p.id, structuredClone(p)]));
    this.caregivers = structuredClone(seed.caregivers);
    this.inventory = new Map(seed.inventory.map((i) => [i.id, structuredClone(i)]));
    this.ledger = structuredClone(seed.ledger);
    this.carts.clear();
    this.observations = structuredClone(seed.observations);
    this.audit = [];
    this.advice = structuredClone(seed.advice);
    this.episodes.clear();
    this.prescriptions.clear();
  }

  async reset(seed: SeedData) { this.load(seed); }
  async getPatient(id: string) { return this.patients.get(id); }
  async listPatients() { return [...this.patients.values()]; }
  async getCaregivers() { return this.caregivers; }
  async getLedger(patientId: string) { return this.ledger.filter((e) => e.patientId === patientId); }
  async getEventByKey(key: string) { return this.ledger.find((e) => e.idempotencyKey === key); }
  async getInventory() { return [...this.inventory.values()]; }
  async addObservation(o: Observation) { this.observations.push(structuredClone(o)); }
  async getObservations(patientId: string, type?: ObservationType) {
    return this.observations.filter((o) => o.patientId === patientId && (type === undefined || o.type === type)).sort((a, b) => a.at - b.at);
  }
  async setPatientWeight(patientId: string, weightLbs: number, at: number) {
    const p = this.patients.get(patientId);
    if (p) { p.weightLbs = weightLbs; p.weightAt = at; }
  }
  async appendAudit(e: AuditEntry) { this.audit.push(structuredClone(e)); }
  async getAudit(limit = 100) { return [...this.audit].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1)).slice(0, limit); }
  async getAdvice(patientId?: string) { return this.advice.filter((a) => patientId === undefined || a.patientId === patientId); }
  async getEpisodes(patientId?: string) { return [...this.episodes.values()].filter((e) => patientId === undefined || e.patientId === patientId).sort((a, b) => b.openedAt - a.openedAt).map((e) => structuredClone(e)); }
  async saveEpisode(e: Episode) { this.episodes.set(e.id, structuredClone(e)); }
  async getPrescriptions(patientId?: string) { return [...this.prescriptions.values()].filter((r) => patientId === undefined || r.patientId === patientId).sort((a, b) => a.createdAt - b.createdAt).map((r) => structuredClone(r)); }
  async savePrescription(r: Prescription) { this.prescriptions.set(r.id, structuredClone(r)); }
  async deletePrescription(id: string) { this.prescriptions.delete(id); }
  async setActiveRx(patientId: string, activeRx: string[]) { const p = this.patients.get(patientId); if (p) p.activeRx = [...activeRx]; }
  async deletePatient(patientId: string) {
    this.patients.delete(patientId);
    this.ledger = this.ledger.filter((e) => e.patientId !== patientId);
    this.observations = this.observations.filter((o) => o.patientId !== patientId);
    this.advice = this.advice.filter((a) => a.patientId !== patientId);
    for (const [id, e] of this.episodes) if (e.patientId === patientId) this.episodes.delete(id);
    for (const [id, r] of this.prescriptions) if (r.patientId === patientId) this.prescriptions.delete(id);
  }
  async saveCart(cart: Cart) { this.carts.set(cart.cartId, structuredClone(cart)); }
  async getCart(id: string) { const c = this.carts.get(id); return c ? structuredClone(c) : undefined; }
  async listCarts(limit = 50) { return [...this.carts.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map((c) => structuredClone(c)); }
  // No `await` between the check and the write: single-threaded JS makes this a compare-and-set.
  async transitionCart(id: string, from: CartStatus[], patch: Partial<Omit<Cart, "cartId">>) {
    const c = this.carts.get(id);
    if (!c || !from.includes(c.status)) return undefined;
    Object.assign(c, patch);
    return structuredClone(c);
  }
  async addInventory(itemId: string, delta: number) {
    const item = this.inventory.get(itemId);
    if (!item) return undefined;
    item.remaining = Math.max(0, Math.round((item.remaining + delta) * 1000) / 1000);
    return item.remaining;
  }

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
    if (interval.status === "DOUBLE_DOSE_LOCKED") return { ok: false, reason: "LOCKED", interval };

    const item = a.inventoryItemId ? this.inventory.get(a.inventoryItemId) : undefined;
    const vol = a.event.volumeMl ?? 0;
    if (item && item.unit === "mL" && item.remaining < vol) return { ok: false, reason: "INSUFFICIENT_STOCK" };

    this.ledger.push(a.event);
    if (item && item.unit === "mL") item.remaining = Math.round((item.remaining - vol) * 1000) / 1000;
    return { ok: true, event: a.event, inventoryRemaining: item?.remaining, lowStock: item ? item.remaining < item.lowThreshold : false, replay: false };
  }
}

/** In-memory multi-household store: one isolated MemoryAdapter per household id. */
export class MemoryStorage implements StorageRoot {
  private households = new Map<string, MemoryAdapter>();

  forHousehold(householdId: string): StorageAdapter {
    let h = this.households.get(householdId);
    if (!h) {
      h = new MemoryAdapter({ patients: [], caregivers: [], inventory: [], ledger: [], observations: [], advice: [] });
      this.households.set(householdId, h);
    }
    return h;
  }
}

export class MemoryNotifier implements Notifier {
  sent: { kind: string; text: string }[] = [];
  async send(kind: Parameters<Notifier["send"]>[0], text: string) {
    this.sent.push({ kind, text });
    return `mem-${this.sent.length}`;
  }
}
