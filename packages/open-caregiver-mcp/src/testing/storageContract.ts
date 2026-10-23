import { randomUUID } from "node:crypto";
import { createSeed } from "../storage/seed.js";
import type { Cart, DoseEvent, Episode, Prescription, StorageAdapter, StorageRoot } from "../storage/types.js";

/**
 * Behavioural contract every storage backend must satisfy (memory, DynamoDB, Supabase).
 * The test API is injected so this file has no dependency on a particular vitest instance.
 */
export interface TestApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void, timeoutMs?: number) => void;
  expect: (value: unknown) => any;
}

const H = 3_600_000;
const RULE = { minIntervalHours: 6, maxDosesPer24h: 4 };
const NOW = Date.UTC(2026, 9, 15, 23, 10);
const INVENTORY_ID = "infant_motrin_drops";

const event = (key: string, caregiver: string, at: number, volumeMl = 2, patientId = "leo"): DoseEvent => ({
  eventId: `ev-${key}`,
  patientId,
  ingredient: "ibuprofen",
  medication: "Infant Motrin Drops",
  caregiver,
  at,
  volumeMl,
  idempotencyKey: key,
});

const cartRow = (id: string, createdAt: number, over: Partial<Cart> = {}): Cart => ({
  cartId: id,
  lines: [{ itemName: "Infant's Motrin Concentrated Drops (Berry Flavor, 0.5 fl oz)", channel: "prime", priceUsd: 11.48, merchantLabel: "Amazon Prime", restocks: { inventoryId: INVENTORY_ID, amount: 15 } }],
  totalUsd: 11.48,
  eta: "Tomorrow by 8:00 AM",
  status: "STAGED",
  createdAt,
  createdBy: "Sarah (Mom)",
  source: "voice",
  ...over,
});

export interface ContractOptions {
  /** Number of parallel commits in the race test (PRD §4.5 says 50). */
  parallel?: number;
  /** Extra time budget for networked backends. */
  timeoutMs?: number;
}

export function runStorageContract(t: TestApi, name: string, makeRoot: () => Promise<StorageRoot> | StorageRoot, opts: ContractOptions = {}): void {
  const { describe, it, expect } = t;
  const parallel = opts.parallel ?? 50;
  const timeout = opts.timeoutMs ?? 30_000;

  // Each test uses its own household id, so tests never interfere and nothing needs cleaning up.
  async function fresh(motrinMl = 30): Promise<{ root: StorageRoot; store: StorageAdapter; hid: string }> {
    const root = await makeRoot();
    const hid = `t-${randomUUID()}`;
    const store = root.forHousehold(hid);
    await store.reset(createSeed(NOW, { motrinMl }));
    return { root, store, hid };
  }
  const remaining = async (s: StorageAdapter) => (await s.getInventory()).find((i) => i.id === INVENTORY_ID)?.remaining;

  describe(`storage contract: ${name}`, () => {
    it("reads back the seeded household", async () => {
      const { store } = await fresh();
      expect((await store.listPatients()).map((p: { id: string }) => p.id).sort()).toEqual(["frank", "leo"]);
      expect((await store.getPatient("leo"))?.name).toBe("Leo");
      expect((await store.getCaregivers()).length).toBeGreaterThan(0);
      expect(await remaining(store)).toBe(30);
    }, timeout);

    it("commits a dose: ledger row, lock, and inventory decrement together", async () => {
      const { store } = await fresh();
      const res = await store.commitDose({ event: event("k1", "Sarah (Mom)", NOW), rule: RULE, inventoryItemId: INVENTORY_ID, now: NOW });
      expect(res).toMatchObject({ ok: true, replay: false, inventoryRemaining: 28 });
      expect((await store.getLedger("leo")).length).toBe(1);
      expect(await remaining(store)).toBe(28);
    }, timeout);

    it("locks a second caregiver inside the interval and writes nothing", async () => {
      const { store } = await fresh();
      await store.commitDose({ event: event("k1", "Sarah (Mom)", NOW), rule: RULE, inventoryItemId: INVENTORY_ID, now: NOW });
      const later = NOW + 18 * 60_000;
      const res = await store.commitDose({ event: event("k2", "Dad", later), rule: RULE, inventoryItemId: INVENTORY_ID, now: later });
      expect(res).toMatchObject({ ok: false, reason: "LOCKED" });
      expect((await store.getLedger("leo")).length).toBe(1);
      expect(await remaining(store)).toBe(28);
    }, timeout);

    it("unlocks once the interval has elapsed", async () => {
      const { store } = await fresh();
      await store.commitDose({ event: event("k1", "Sarah (Mom)", NOW), rule: RULE, inventoryItemId: INVENTORY_ID, now: NOW });
      const later = NOW + 6 * H;
      expect(await store.commitDose({ event: event("k2", "Dad", later), rule: RULE, inventoryItemId: INVENTORY_ID, now: later })).toMatchObject({ ok: true, replay: false });
    }, timeout);

    it("is idempotent: the same key replays the original and does not double-write", async () => {
      const { store } = await fresh();
      const first = await store.commitDose({ event: event("same", "Sarah (Mom)", NOW), rule: RULE, inventoryItemId: INVENTORY_ID, now: NOW });
      const again = await store.commitDose({ event: event("same", "Sarah (Mom)", NOW + 1000), rule: RULE, inventoryItemId: INVENTORY_ID, now: NOW + 1000 });
      expect(first).toMatchObject({ ok: true, replay: false });
      expect(again).toMatchObject({ ok: true, replay: true });
      expect((await store.getLedger("leo")).length).toBe(1);
      expect(await remaining(store)).toBe(28);
      expect((await store.getEventByKey("same"))?.eventId).toBe("ev-same");
    }, timeout);

    it("enforces the daily maximum", async () => {
      const { store } = await fresh();
      for (let i = 0; i < RULE.maxDosesPer24h; i++) {
        const at = NOW + i * 6 * H;
        expect(await store.commitDose({ event: event(`d${i}`, "Sarah (Mom)", at), rule: RULE, inventoryItemId: INVENTORY_ID, now: at })).toMatchObject({ ok: true });
      }
      const late = NOW + 23 * H;
      expect(await store.commitDose({ event: event("d-extra", "Dad", late), rule: RULE, inventoryItemId: INVENTORY_ID, now: late })).toMatchObject({ ok: false, reason: "DAILY_MAX" });
    }, timeout);

    it("refuses a dose larger than what is left in the bottle", async () => {
      const { store } = await fresh(1);
      const res = await store.commitDose({ event: event("k1", "Sarah (Mom)", NOW, 2), rule: RULE, inventoryItemId: INVENTORY_ID, now: NOW });
      expect(res).toMatchObject({ ok: false, reason: "INSUFFICIENT_STOCK" });
      expect((await store.getLedger("leo")).length).toBe(0);
      expect(await remaining(store)).toBe(1);
    }, timeout);

    it(`${parallel} parallel doses for one patient+ingredient: exactly one wins, nothing is double-written`, async () => {
      const { store } = await fresh(100);
      const settled = await Promise.allSettled(
        Array.from({ length: parallel }, (_, i) =>
          store.commitDose({ event: event(`race-${i}`, i % 2 ? "Sarah (Mom)" : "Dad", NOW), rule: RULE, inventoryItemId: INVENTORY_ID, now: NOW }),
        ),
      );
      const wins = settled.filter((r) => r.status === "fulfilled" && r.value.ok && !r.value.replay);
      expect(wins.length).toBe(1);
      expect((await store.getLedger("leo")).length).toBe(1);
      expect(await remaining(store)).toBe(98);
    }, timeout * 2);

    it("parallel retries of one idempotency key record a single dose", async () => {
      const { store } = await fresh();
      const settled = await Promise.allSettled(
        Array.from({ length: 10 }, () => store.commitDose({ event: event("retry", "Sarah (Mom)", NOW), rule: RULE, inventoryItemId: INVENTORY_ID, now: NOW })),
      );
      const oks = settled.filter((r) => r.status === "fulfilled" && r.value.ok);
      expect(oks.length).toBe(10);
      expect(settled.filter((r) => r.status === "fulfilled" && r.value.ok && !r.value.replay).length).toBe(1);
      expect((await store.getLedger("leo")).length).toBe(1);
      expect(await remaining(store)).toBe(28);
    }, timeout);

    it("keeps sku and amountMg on the ledger row", async () => {
      const { store } = await fresh();
      await store.commitDose({ event: { ...event("k1", "Sarah (Mom)", NOW, 1.875), sku: "infants_motrin_drops", amountMg: 75 }, rule: RULE, inventoryItemId: INVENTORY_ID, now: NOW });
      const [row] = await store.getLedger("leo");
      expect(row).toMatchObject({ sku: "infants_motrin_drops", amountMg: 75, volumeMl: 1.875 });
      expect(await remaining(store)).toBe(28.125);
    }, timeout);

    it("stores observations per patient, filtered by type, oldest first", async () => {
      const { store } = await fresh();
      await store.addObservation({ id: "w2", patientId: "leo", type: "weight", value: 19.5, unit: "lb", at: NOW, source: "Dad" });
      await store.addObservation({ id: "t1", patientId: "leo", type: "temperature", value: 101.2, unit: "F", at: NOW - 1000, source: "Sarah (Mom)" });
      const weights = await store.getObservations("leo", "weight");
      expect(weights.map((o: { id: string }) => o.id)).toEqual(["seed-weight-leo", "w2"]); // the seed's weight, then the new one
      expect((await store.getObservations("leo", "temperature")).map((o: { id: string }) => o.id)).toEqual(["t1"]);
      expect((await store.getObservations("leo")).length).toBe(3);
      expect(await store.getObservations("frank")).toEqual([]);
    }, timeout);

    it("updates a patient's last-known weight together with its date", async () => {
      const { store } = await fresh();
      expect(await store.getPatient("leo")).toMatchObject({ weightLbs: 19 });
      await store.setPatientWeight("leo", 20.5, NOW);
      expect(await store.getPatient("leo")).toMatchObject({ weightLbs: 20.5, weightAt: NOW });
    }, timeout);

    it("appends audit entries and reads them newest first", async () => {
      const { store } = await fresh();
      await store.appendAudit({ id: "a1", at: NOW, tool: "plan_medication", patientId: "leo", inputHash: "h1", verdict: "APPROVED", reasonCodes: ["LABEL_BAND_18_23LB"] });
      await store.appendAudit({ id: "a2", at: NOW + 1000, tool: "plan_medication", patientId: "frank", caregiver: "Dad", inputHash: "h2", verdict: "ALTERNATE_SUGGESTED", reasonCodes: ["SR-NSAID-ANTICOAGULANT"] });
      const log = await store.getAudit(10);
      expect(log.map((e: { id: string }) => e.id)).toEqual(["a2", "a1"]);
      expect(log[0]).toMatchObject({ verdict: "ALTERNATE_SUGGESTED", reasonCodes: ["SR-NSAID-ANTICOAGULANT"], caregiver: "Dad" });
      expect((await store.getAudit(1)).length).toBe(1);
    }, timeout);

    it("returns remembered advice, optionally for one patient", async () => {
      const { store } = await fresh();
      const all = await store.getAdvice();
      expect(all.map((a: { drug: string }) => a.drug)).toEqual(["naproxen"]);
      expect(await store.getAdvice("frank")).toHaveLength(1);
      expect(await store.getAdvice("leo")).toEqual([]);
    }, timeout);

    it("isolates households: no cross-reads, no shared idempotency keys, no shared locks, reset is scoped", async () => {
      const root = await makeRoot();
      const a = root.forHousehold(`t-${randomUUID()}`);
      const b = root.forHousehold(`t-${randomUUID()}`);
      await a.reset(createSeed(NOW, { motrinMl: 30 }));
      await b.reset(createSeed(NOW, { motrinMl: 30 }));

      await a.commitDose({ event: event("shared-key", "Sarah (Mom)", NOW), rule: RULE, inventoryItemId: INVENTORY_ID, now: NOW });

      // B sees none of A's dose, key, lock or inventory change.
      expect((await b.getLedger("leo")).length).toBe(0);
      expect(await b.getEventByKey("shared-key")).toBeUndefined();
      expect(await remaining(b)).toBe(30);
      const inB = await b.commitDose({ event: event("shared-key", "Dad", NOW + 60_000), rule: RULE, inventoryItemId: INVENTORY_ID, now: NOW + 60_000 });
      expect(inB).toMatchObject({ ok: true, replay: false });

      // Wiping B leaves A untouched.
      await b.reset(createSeed(NOW, { motrinMl: 5 }));
      expect((await a.getLedger("leo")).length).toBe(1);
      expect(await remaining(a)).toBe(28);
      expect(await remaining(b)).toBe(5);

      await a.appendAudit({ id: "iso", at: NOW, tool: "plan_medication", inputHash: "x", verdict: "APPROVED", reasonCodes: [] });
      await a.addObservation({ id: "iso-w", patientId: "leo", type: "weight", value: 21, unit: "lb", at: NOW, source: "x" });
      expect(await b.getAudit()).toEqual([]);
      expect((await b.getObservations("leo", "weight")).map((o: { id: string }) => o.id)).toEqual(["seed-weight-leo"]);

      // An unknown household is empty rather than leaking another's data.
      const stranger = root.forHousehold(`t-${randomUUID()}`);
      expect(await stranger.listPatients()).toEqual([]);
      expect(await stranger.getPatient("leo")).toBeUndefined();
    }, timeout);
    it("stores carts with their timestamps and lists them newest first", async () => {
      const { store } = await fresh();
      await store.saveCart(cartRow("c-old", NOW - 5000));
      await store.saveCart(cartRow("c-new", NOW, { createdBy: "Dad" }));
      const got = await store.getCart("c-new");
      expect(got).toMatchObject({ cartId: "c-new", status: "STAGED", createdAt: NOW, createdBy: "Dad", totalUsd: 11.48, source: "voice" });
      expect(got?.lines[0]?.restocks).toEqual({ inventoryId: INVENTORY_ID, amount: 15 });
      expect((await store.listCarts()).map((c: Cart) => c.cartId)).toEqual(["c-new", "c-old"]);
      expect(await store.getCart("missing")).toBeUndefined();
    }, timeout);

    it("transitionCart is a compare-and-set: only a cart in an allowed status moves", async () => {
      const { store } = await fresh();
      await store.saveCart(cartRow("c1", NOW));
      expect(await store.transitionCart("c1", ["ORDERED"], { status: "DELIVERED" })).toBeUndefined();
      const ordered = await store.transitionCart("c1", ["STAGED"], { status: "ORDERED", orderId: "ord_1", orderedAt: NOW + 1, orderedBy: "Dad" });
      expect(ordered).toMatchObject({ status: "ORDERED", orderId: "ord_1", orderedAt: NOW + 1, orderedBy: "Dad", createdBy: "Sarah (Mom)" });
      expect(await store.transitionCart("c1", ["STAGED"], { status: "ORDERED", orderId: "ord_2" })).toBeUndefined();
      expect((await store.getCart("c1"))?.orderId).toBe("ord_1");
      expect(await store.transitionCart("nope", ["STAGED"], { status: "CANCELLED" })).toBeUndefined();
    }, timeout);

    it("20 caregivers pressing order at once place exactly one order", async () => {
      const { store } = await fresh();
      await store.saveCart(cartRow("race", NOW));
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.transitionCart("race", ["STAGED"], { status: "ORDERED", orderId: `ord_${i}`, orderedAt: NOW })));
      const winners = results.filter(Boolean);
      expect(winners.length).toBe(1);
      expect((await store.getCart("race"))?.orderId).toBe(winners[0]?.orderId);
    }, timeout);

    it("addInventory is atomic, floors at zero and ignores unknown items", async () => {
      const { store } = await fresh(10);
      await Promise.all(Array.from({ length: 20 }, () => store.addInventory(INVENTORY_ID, 1.5)));
      expect(await remaining(store)).toBe(40);
      expect(await store.addInventory(INVENTORY_ID, -1000)).toBe(0);
      expect(await remaining(store)).toBe(0);
      expect(await store.addInventory("no_such_item", 5)).toBeUndefined();
    }, timeout);

    it("keeps carts private to their household", async () => {
      const root = await makeRoot();
      const a = root.forHousehold(`t-${randomUUID()}`);
      const b = root.forHousehold(`t-${randomUUID()}`);
      await a.reset(createSeed(NOW));
      await b.reset(createSeed(NOW));
      await a.saveCart(cartRow("same-id", NOW));
      expect(await b.getCart("same-id")).toBeUndefined();
      expect(await b.listCarts()).toEqual([]);
      expect(await b.transitionCart("same-id", ["STAGED"], { status: "CANCELLED" })).toBeUndefined();
      expect((await a.getCart("same-id"))?.status).toBe("STAGED");
      await b.addInventory(INVENTORY_ID, 100);
      expect(await remaining(a)).toBe(3.5);
    }, timeout);
    it("stores episodes newest first and replaces by id", async () => {
      const { store } = await fresh();
      const ep = (id: string, at: number, over: Partial<Episode> = {}): Episode => ({ id, patientId: "leo", status: "OPEN", openedAt: at, updatedAt: at, urgency: "HOME_CARE_OK_WITH_WATCH", redFlags: [], timeline: [{ at, type: "OPENED", text: "fever" }], ...over });
      await store.saveEpisode(ep("e-old", NOW - 1000));
      await store.saveEpisode(ep("e-new", NOW, { redFlags: ["RF-X"] }));
      await store.saveEpisode(ep("e-frank", NOW - 500, { patientId: "frank" }));
      expect((await store.getEpisodes("leo")).map((e: Episode) => e.id)).toEqual(["e-new", "e-old"]);
      expect((await store.getEpisodes()).length).toBe(3);
      await store.saveEpisode(ep("e-new", NOW, { status: "CLOSED", urgency: "CALL_DOCTOR_TODAY", timeline: [{ at: NOW, type: "CLOSED", text: "done" }] }));
      const again = (await store.getEpisodes("leo"))[0]!;
      expect(again).toMatchObject({ id: "e-new", status: "CLOSED", urgency: "CALL_DOCTOR_TODAY" });
      expect(again.timeline).toHaveLength(1);
    }, timeout);

    it("stores prescriptions with status and confidence, and deletes one by id", async () => {
      const { store } = await fresh();
      const rx = (id: string, at: number, over: Partial<Prescription> = {}): Prescription => ({ id, patientId: "frank", drug: "Eliquis", strength: "5 mg", frequency: "twice daily", prescriber: "Dr. Rao", status: "PENDING", source: "photo", uploadId: "up1", confidence: { drug: 0.98, strength: 0.7 }, flags: [], createdAt: at, ...over });
      await store.savePrescription(rx("rx1", NOW));
      await store.savePrescription(rx("rx2", NOW + 1, { drug: "Metformin", strength: "500 mg" }));
      const all = await store.getPrescriptions("frank");
      expect(all.map((r: Prescription) => r.id)).toEqual(["rx1", "rx2"]);
      expect(all[0]).toMatchObject({ status: "PENDING", confidence: { drug: 0.98, strength: 0.7 }, uploadId: "up1" });
      await store.savePrescription(rx("rx1", NOW, { status: "ACTIVE", confirmedAt: NOW + 5 }));
      expect((await store.getPrescriptions("frank"))[0]).toMatchObject({ status: "ACTIVE", confirmedAt: NOW + 5 });
      await store.deletePrescription("rx2");
      expect((await store.getPrescriptions("frank")).map((r: Prescription) => r.id)).toEqual(["rx1"]);
      expect(await store.getPrescriptions("leo")).toEqual([]);
    }, timeout);

    it("setActiveRx replaces the confirmed medicine list", async () => {
      const { store } = await fresh();
      await store.setActiveRx("frank", ["eliquis", "metformin", "tamsulosin"]);
      expect((await store.getPatient("frank"))?.activeRx).toEqual(["eliquis", "metformin", "tamsulosin"]);
      expect((await store.getPatient("leo"))?.activeRx).toEqual([]);
    }, timeout);

    it("deletePatient removes the person and every record about them, and nothing else", async () => {
      const root = await makeRoot();
      const a = root.forHousehold(`t-${randomUUID()}`);
      const b = root.forHousehold(`t-${randomUUID()}`);
      await a.reset(createSeed(NOW, { motrinMl: 30 }));
      await b.reset(createSeed(NOW, { motrinMl: 30 }));
      for (const st of [a, b]) {
        await st.commitDose({ event: event("k-leo", "Sarah (Mom)", NOW), rule: RULE, inventoryItemId: INVENTORY_ID, now: NOW });
        await st.saveEpisode({ id: "ep", patientId: "leo", status: "OPEN", openedAt: NOW, updatedAt: NOW, urgency: "HOME_CARE_OK_WITH_WATCH", redFlags: [], timeline: [] });
        await st.savePrescription({ id: "rx", patientId: "leo", drug: "x", status: "PENDING", source: "photo", flags: [], createdAt: NOW });
        await st.addObservation({ id: "o1", patientId: "leo", type: "temperature", value: 101, unit: "F", at: NOW, source: "x" });
      }
      await a.saveEpisode({ id: "ep-frank", patientId: "frank", status: "OPEN", openedAt: NOW, updatedAt: NOW, urgency: "HOME_CARE_OK_WITH_WATCH", redFlags: [], timeline: [] });

      await a.deletePatient("leo");

      expect(await a.getPatient("leo")).toBeUndefined();
      expect((await a.listPatients()).map((p: { id: string }) => p.id)).toEqual(["frank"]);
      expect(await a.getLedger("leo")).toEqual([]);
      expect(await a.getObservations("leo")).toEqual([]);
      expect(await a.getEpisodes("leo")).toEqual([]);
      expect(await a.getPrescriptions("leo")).toEqual([]);
      expect(await a.getEventByKey("k-leo")).toBeUndefined();
      // Frank, the bottle, the caregivers and Frank's remembered advice are untouched.
      expect((await a.getEpisodes("frank")).length).toBe(1);
      expect((await a.getAdvice("frank")).length).toBe(1);
      expect((await a.getCaregivers()).length).toBeGreaterThan(0);
      // The other household still has all of Leo.
      expect((await b.getLedger("leo")).length).toBe(1);
      expect((await b.getEpisodes("leo")).length).toBe(1);
      expect(await b.getPatient("leo")).toBeDefined();
      // The idempotency key is free again, so a new profile with the same name starts clean.
      await a.reset(createSeed(NOW, { motrinMl: 30 }));
      expect((await a.getLedger("leo")).length).toBe(0);
    }, timeout);
  });
}
