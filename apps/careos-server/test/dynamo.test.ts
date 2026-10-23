import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CareService, MemoryNotifier, createSeed } from "open-caregiver-mcp";
import { runStorageContract } from "open-caregiver-mcp/testing";
import { DynamoRoot, DynamoStorage } from "../src/adapters/dynamoStorage.js";

const endpoint = process.env.DDB_ENDPOINT ?? "http://localhost:8000";
const MIN = 60_000;

let root: DynamoRoot;
let storage: DynamoStorage;
let now: number;
let notifier: MemoryNotifier;
let svc: CareService;

beforeAll(async () => {
  const client = new DynamoDBClient({ region: "us-east-1", endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } });
  root = new DynamoRoot(client, "careos_test");
  storage = root.forHousehold("service-tests");
  try {
    await root.ensureTable();
  } catch (e) {
    throw new Error(`DynamoDB Local is not reachable at ${endpoint} (${e instanceof Error ? e.message : e}). Start it, or set DDB_ENDPOINT.`);
  }
});

beforeEach(async () => {
  now = Date.UTC(2026, 9, 15, 23, 10);
  notifier = new MemoryNotifier();
  await storage.reset(createSeed(now, { motrinMl: 30 }));
  svc = new CareService(storage, { clock: () => now, notifier, signingSecret: "dynamo-test" });
});

/** The full two-step flow against DynamoDB: read the entry back, then confirm with the token. */
const ctx = { caregiverId: "sarah" };
async function give(caregiver: string, product = "Motrin") {
  const r = await svc.confirmDoseGiven({ patient_id: "leo", product, caregiver_id: caregiver }, ctx);
  if (r.status !== "NEEDS_CONFIRMATION") return r;
  return svc.confirmDoseGiven({ patient_id: "leo", product, caregiver_id: caregiver, confirmation_token: r.confirmation_token as string }, ctx);
}
const bottle = async () => (await storage.getInventory()).find((i) => i.id === "infant_motrin_drops")?.remaining;

describe("CareService on DynamoDB", () => {
  it("seeds everything the safety pipeline needs, including the dated weight and remembered advice", async () => {
    expect((await storage.listPatients()).map((p) => p.id).sort()).toEqual(["frank", "leo"]);
    expect(await storage.getPatient("leo")).toMatchObject({ weightLbs: 19, weightAt: now - 2 * 86_400_000 });
    expect((await storage.getObservations("leo", "weight")).length).toBe(1);
    expect((await storage.getAdvice("frank")).map((a) => a.drug)).toEqual(["naproxen"]);
    expect(await bottle()).toBe(30);
  });

  it("plans 1.875 mL, reads it back, logs it, and persists the ledger, bottle, lock and audit trail", async () => {
    expect(await svc.planMedication({ patient_id: "leo", product: "Motrin", last_dose_elsewhere: "none_today" }, ctx)).toMatchObject({ status: "APPROVED", dispense_volume_ml: 1.875 });
    const r = await give("Sarah (Mom)");
    expect(r).toMatchObject({ status: "LOGGED", bottle_remaining_ml: 28.125, low_stock: false });
    const ledger = await storage.getLedger("leo");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ caregiver: "Sarah (Mom)", volumeMl: 1.875, amountMg: 75, sku: "infants_motrin_drops", ingredient: "ibuprofen" });
    expect((await storage.getAudit(10)).map((e) => e.tool)).toEqual(["confirm_dose_given", "confirm_dose_given", "plan_medication"]);
  });

  it("intercepts the second caregiver 32 minutes later", async () => {
    await give("Sarah (Mom)");
    now += 32 * MIN;
    const r = await svc.planMedication({ patient_id: "leo", product: "Motrin" }, ctx);
    expect(r).toMatchObject({ status: "BLOCKED", violation_type: "DOUBLE_DOSE_LOCKED", remaining_minutes: 328 });
    expect((r as any).last_dose).toMatchObject({ caregiver: "Sarah (Mom)", minutes_ago: 32 });
  });

  it("both caregivers read back, then confirm at once: exactly one dose, the bottle charged once", async () => {
    const [ra, rb] = await Promise.all([
      svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: "Sarah (Mom)" }, ctx),
      svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: "Dad" }, ctx),
    ]);
    const go = (who: string, r: Record<string, unknown>) => svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: who, confirmation_token: r.confirmation_token as string }, ctx);
    const results = await Promise.all([go("Sarah (Mom)", ra), go("Dad", rb)]);
    expect(results.map((r) => r.status).sort()).toEqual(["LOGGED", "REJECTED_LOCKED"]);
    expect(await storage.getLedger("leo")).toHaveLength(1);
    expect(await bottle()).toBe(28.125);
  });

  it("ten distinct confirmations at once: exactly one dose wins", async () => {
    // Distinct given-times make ten genuinely different confirmations (identical ones are deliberate replays, tested below).
    const people = ["Sarah (Mom)", "Dad"];
    const args = (i: number) => ({ patient_id: "leo", product: "Motrin", caregiver_id: people[i % 2]!, given_minutes_ago: i });
    const tokens = await Promise.all(Array.from({ length: 10 }, (_, i) => svc.confirmDoseGiven(args(i), ctx)));
    expect(new Set(tokens.map((t) => t.confirmation_token)).size).toBe(10);
    const results = await Promise.all(tokens.map((t, i) => svc.confirmDoseGiven({ ...args(i), confirmation_token: t.confirmation_token as string }, ctx)));
    expect(results.filter((r) => r.status === "LOGGED")).toHaveLength(1);
    expect(results.filter((r) => r.status === "REJECTED_LOCKED")).toHaveLength(9);
    expect(await storage.getLedger("leo")).toHaveLength(1);
    expect(await bottle()).toBe(28.125);
  });

  it("retrying one confirmation concurrently records one dose, one bottle charge, one alert", async () => {
    const first = await svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: "Sarah (Mom)" }, ctx);
    const retry = () => svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: "Sarah (Mom)", confirmation_token: first.confirmation_token as string }, ctx);
    const results = await Promise.all(Array.from({ length: 5 }, retry));
    expect(results.every((r) => r.status === "LOGGED")).toBe(true);
    expect(new Set(results.map((r) => r.event_id)).size).toBe(1);
    expect(await storage.getLedger("leo")).toHaveLength(1);
    expect(await bottle()).toBe(28.125);
    expect(notifier.sent.filter((m) => m.kind === "DOSE_LOGGED")).toHaveLength(1);
  });

  it("a later retry replays the original event even though its own lock now exists", async () => {
    const first = await svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: "Sarah (Mom)" }, ctx);
    const token = first.confirmation_token as string;
    const a = await svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: "Sarah (Mom)", confirmation_token: token }, ctx);
    const b = await svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: "Sarah (Mom)", confirmation_token: token }, ctx);
    expect(b).toMatchObject({ status: "LOGGED", replay: true, event_id: a.event_id });
  });

  it("refuses a dose bigger than the remaining bottle and writes nothing", async () => {
    await storage.reset(createSeed(now, { motrinMl: 1 }));
    expect((await give("Sarah (Mom)")).status).toBe("REJECTED_STOCK");
    expect(await storage.getLedger("leo")).toHaveLength(0);
    expect(await bottle()).toBe(1);
  });

  it("unlocks after 6 hours and charges the bottle again", async () => {
    await give("Sarah (Mom)");
    now += 6 * 60 * MIN;
    expect((await give("Dad")).status).toBe("LOGGED");
    expect(await bottle()).toBe(26.25);
  });

  it("a weight reported while planning is stored with its date", async () => {
    await svc.planMedication({ patient_id: "leo", product: "Motrin", last_dose_elsewhere: "none_today", weight_value: 20, weight_unit: "lb" }, ctx);
    expect(await storage.getPatient("leo")).toMatchObject({ weightLbs: 20, weightAt: now });
    expect((await storage.getObservations("leo", "weight")).map((o) => o.value)).toEqual([19, 20]);
  });

  it("stages and confirms a cart through storage", async () => {
    const staged = await svc.stageAmazonCart({ requested_items: [{ item_name: "Infant Motrin Drops", channel: "prime" }, { item_name: "glucose test strips", channel: "pharmacy" }, { item_name: "ginger", channel: "fresh" }] });
    expect(staged.total_usd).toBe(41.29);
    const placed = await svc.confirmAmazonOrder({ cart_id: staged.cart_id as string });
    expect(placed.status).toBe("ORDER_PLACED");
    expect((await storage.getCart(staged.cart_id as string))?.status).toBe("ORDERED");
  });

  it("reset wipes prior events, locks, observations and audit", async () => {
    await give("Sarah (Mom)");
    await storage.reset(createSeed(now, { motrinMl: 30 }));
    expect(await storage.getLedger("leo")).toHaveLength(0);
    expect(await storage.getAudit()).toHaveLength(0);
    expect(await storage.getObservations("leo")).toHaveLength(1); // just the seed weight
    expect((await give("Dad")).status).toBe("LOGGED");
  });

  it("a seeded dose from Sarah blocks Dad straight away", async () => {
    await storage.reset(createSeed(now, { sarahDosedMinutesAgo: 32, motrinMl: 30 }));
    const r = await svc.planMedication({ patient_id: "leo", product: "Motrin" }, ctx);
    expect(r).toMatchObject({ status: "BLOCKED", violation_type: "DOUBLE_DOSE_LOCKED" });
    expect((r as any).last_dose.minutes_ago).toBe(32);
  });
});

// Same behavioural contract as the memory backend, including the 50-way race and cross-household isolation.
runStorageContract({ describe, it, expect }, "dynamodb", () => root, { timeoutMs: 60_000 });
