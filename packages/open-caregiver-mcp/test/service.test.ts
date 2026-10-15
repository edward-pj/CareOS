import { beforeEach, describe, expect, it } from "vitest";
import { CareService, MemoryAdapter, MemoryNotifier, createSeed } from "../src/server.js";

const MIN = 60_000;
let now: number;
let notifier: MemoryNotifier;
let svc: CareService;

beforeEach(() => {
  now = Date.UTC(2026, 9, 15, 23, 10);
  notifier = new MemoryNotifier();
  svc = new CareService(new MemoryAdapter(createSeed(now, { motrinMl: 15 })), { clock: () => now, notifier, overridePin: "4242" });
});

const dose = (extra = {}) => svc.calculatePediatricDose({ patient_id: "infant_leo", weight_value: 19, weight_unit: "lbs", medication: "ibuprofen", formulation: "infant_drops", ...extra });
const log = (caregiver: string, key: string, vol = 2) => svc.logAdministrationEvent({ patient_id: "infant_leo", caregiver_name: caregiver, medication: "Infant Motrin Drops", volume_ml: vol, idempotency_key: key });

describe("Leo dosing flow", () => {
  it("calculates 2.00 mL with a syringe card", async () => {
    const r = await dose();
    expect(r).toMatchObject({ status: "APPROVED", dispense_volume_ml: 2, delivered_dose_mg: 80, target_dose_mg: 86.18, card_type: "SYRINGE_CALIBRATOR", lockout_hours: 6 });
  });

  it("logs, notifies, decrements the bottle and flags low stock", async () => {
    const r = await log("Sarah (Mom)", "k1");
    expect(r).toMatchObject({ status: "LOGGED", bottle_remaining_ml: 13, low_stock: false });
    expect(notifier.sent[0]!.text).toMatch(/2\.0 mL Infant Motrin Drops administered to Leo by Sarah \(Mom\)/);
  });

  it("intercepts Dad 32 minutes later with Mom's details", async () => {
    await log("Sarah (Mom)", "k1");
    now += 32 * MIN;
    const r = await log("Dad", "k2");
    expect(r).toMatchObject({ status: "REJECTED_LOCKED", violation_type: "DOUBLE_DOSE_LOCKED", card_type: "DOUBLE_DOSE_INTERCEPT" });
    expect((r as any).last_dose).toMatchObject({ caregiver: "Sarah (Mom)", minutes_ago: 32 });
    expect((r as any).remaining_minutes).toBe(328);
    expect(notifier.sent.some((n) => n.kind === "LOCKOUT_ATTEMPT")).toBe(true);
  });

  it("a brand name does not dodge the ingredient lock", async () => {
    await log("Sarah (Mom)", "k1");
    now += 10 * MIN;
    const r = await svc.verifyMedicationSafety({ patient_id: "leo", proposed_medication: "Advil", administration_intent: false });
    expect(r).toMatchObject({ status: "BLOCKED" });
  });

  it("exactly one of two simultaneous doses wins", async () => {
    const [a, b] = await Promise.all([log("Sarah (Mom)", "ka"), log("Dad", "kb")]);
    expect([a.status, b.status].sort()).toEqual(["LOGGED", "REJECTED_LOCKED"]);
  });

  it("is idempotent on a retried key", async () => {
    const a = await log("Sarah (Mom)", "same");
    const b = await log("Sarah (Mom)", "same");
    expect(b).toMatchObject({ status: "LOGGED", replay: true, event_id: a.event_id });
    expect(notifier.sent.filter((n) => n.kind === "DOSE_LOGGED")).toHaveLength(1);
  });

  it("refuses an overdose volume even if the model asks for it", async () => {
    expect((await log("Dad", "big", 5)).status).toBe("REJECTED_OVERDOSE");
  });

  it("unlocks after 6 hours", async () => {
    await log("Sarah (Mom)", "k1");
    now += 6 * 60 * MIN;
    expect((await log("Dad", "k2")).status).toBe("LOGGED");
  });

  it("PIN override unlocks the interval; wrong PINs lock out", async () => {
    await log("Sarah (Mom)", "k1");
    now += 5 * MIN;
    expect((await svc.overrideLockout({ patient_id: "leo", ingredient: "ibuprofen", caregiver: "Dad", pin: "0000" })).status).toBe("OVERRIDE_DENIED");
    expect((await svc.overrideLockout({ patient_id: "leo", ingredient: "ibuprofen", caregiver: "Dad", pin: "4242" })).status).toBe("OVERRIDE_GRANTED");
    expect((await log("Dad", "k2")).status).toBe("LOGGED");
    for (let i = 0; i < 3; i++) await svc.overrideLockout({ patient_id: "leo", ingredient: "ibuprofen", caregiver: "Mallory", pin: "1111" });
    const locked = await svc.overrideLockout({ patient_id: "leo", ingredient: "ibuprofen", caregiver: "Mallory", pin: "4242" });
    expect(locked.status).toBe("OVERRIDE_DENIED");
  });
});

describe("low stock", () => {
  it("flags low stock and suggests a restock when the bottle runs low", async () => {
    const low = new CareService(new MemoryAdapter(createSeed(now, { motrinMl: 3.5 })), { clock: () => now, notifier });
    const r = await low.logAdministrationEvent({ patient_id: "leo", caregiver_name: "Sarah (Mom)", medication: "Infant Motrin Drops", volume_ml: 2, idempotency_key: "s1" });
    expect(r).toMatchObject({ status: "LOGGED", bottle_remaining_ml: 1.5, low_stock: true });
    expect(r.suggested_restock_items).toEqual(["Infant's Motrin Concentrated Drops"]);
  });

  it("refuses a dose larger than what is left in the bottle", async () => {
    const low = new CareService(new MemoryAdapter(createSeed(now, { motrinMl: 1 })), { clock: () => now, notifier });
    const r = await low.logAdministrationEvent({ patient_id: "leo", caregiver_name: "Sarah (Mom)", medication: "Infant Motrin Drops", volume_ml: 2, idempotency_key: "s2" });
    expect(r.status).toBe("REJECTED_STOCK");
  });
});

describe("Frank", () => {
  it("blocks Advil against Eliquis with a Tylenol alternative", async () => {
    const r = await svc.verifyMedicationSafety({ patient_id: "elder_frank", proposed_medication: "advil", administration_intent: true });
    expect(r).toMatchObject({ status: "BLOCKED", violation_type: "DRUG_CONTRAINDICATION", severity: "CRITICAL", conflicting_rx: "eliquis", approved_alternative: "acetaminophen", card_type: "CONTRAINDICATION_SHIELD" });
    expect(notifier.sent.some((n) => n.kind === "CRITICAL_BLOCK")).toBe(true);
  });

  it("returns the glycemic-capped ginger-lemon remedy", async () => {
    const r = await svc.queryPantryRemedies({ patient_id: "frank", symptom: "sore_throat" });
    expect(r).toMatchObject({ status: "MATCH_FOUND", card_type: "PANTRY_REMEDY" });
    expect(JSON.stringify(r)).toContain("1/2 tsp honey");
  });

  it("log_administration cannot bypass the contraindication", async () => {
    const r = await svc.logAdministrationEvent({ patient_id: "frank", caregiver_name: "Frank", medication: "Advil", volume_ml: 0 });
    expect(r.status).toBe("REJECTED_UNSAFE");
  });
});

describe("Leo pantry & cart", () => {
  it("never offers honey to the infant", async () => {
    const r = await svc.queryPantryRemedies({ patient_id: "leo", symptom: "sore_throat" });
    expect(JSON.stringify(r)).not.toContain("1 tsp honey");
    expect((r as any).excluded_items.some((e: any) => e.item === "honey")).toBe(true);
  });

  it("stages the PRD's cart for $41.29 then confirms once", async () => {
    const staged = await svc.stageAmazonCart({ requested_items: [{ item_name: "Infant Motrin Drops", channel: "prime" }, { item_name: "Diabetic Glucose Test Strips", channel: "pharmacy" }, { item_name: "ginger and lemons", channel: "fresh" }] });
    expect(staged).toMatchObject({ status: "STAGED", total_usd: 41.29, card_type: "AMAZON_RESTOCK_CAROUSEL" });
    const id = staged.cart_id as string;
    const a = await svc.confirmAmazonOrder({ cart_id: id });
    const b = await svc.confirmAmazonOrder({ cart_id: id });
    expect(a.status).toBe("ORDER_PLACED");
    expect(b).toMatchObject({ already_ordered: true, order_id: a.order_id });
  });
});
