import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CareService, MemoryNotifier, createSeed } from "open-caregiver-mcp";
import { DynamoStorage } from "../src/adapters/dynamoStorage.js";

const endpoint = process.env.DDB_ENDPOINT ?? "http://localhost:8000";
const MIN = 60_000;

let storage: DynamoStorage;
let now: number;
let notifier: MemoryNotifier;
let svc: CareService;

beforeAll(async () => {
  const client = new DynamoDBClient({ region: "us-east-1", endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } });
  storage = new DynamoStorage(client, "careos_test");
  try {
    await storage.ensureTable();
  } catch (e) {
    throw new Error(`DynamoDB Local is not reachable at ${endpoint} (${e instanceof Error ? e.message : e}). Start it, or set DDB_ENDPOINT.`);
  }
});

beforeEach(async () => {
  now = Date.UTC(2026, 9, 15, 23, 10);
  notifier = new MemoryNotifier();
  await storage.reset(createSeed(now, { motrinMl: 30 }));
  svc = new CareService(storage, { clock: () => now, notifier, overridePin: "4242" });
});

const log = (caregiver: string, key: string, vol = 2) =>
  svc.logAdministrationEvent({ patient_id: "leo", caregiver_name: caregiver, medication: "Infant Motrin Drops", volume_ml: vol, idempotency_key: key });

describe("DynamoStorage via CareService", () => {
  it("seeds and reads back patients, caregivers and inventory", async () => {
    expect((await storage.listPatients()).map((p) => p.id).sort()).toEqual(["frank", "leo"]);
    expect((await storage.getCaregivers()).length).toBe(2);
    expect((await storage.getInventory()).find((i) => i.id === "infant_motrin_drops")?.remaining).toBe(30);
  });

  it("logs a dose, decrements the bottle exactly, and persists the ledger", async () => {
    const r = await log("Sarah (Mom)", "k1");
    expect(r).toMatchObject({ status: "LOGGED", bottle_remaining_ml: 28, low_stock: false });
    const ledger = await storage.getLedger("leo");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ caregiver: "Sarah (Mom)", volumeMl: 2, ingredient: "ibuprofen" });
  });

  it("intercepts the second caregiver 32 minutes later", async () => {
    await log("Sarah (Mom)", "k1");
    now += 32 * MIN;
    const r = await log("Dad", "k2");
    expect(r).toMatchObject({ status: "REJECTED_LOCKED", violation_type: "DOUBLE_DOSE_LOCKED" });
    expect((r as any).last_dose).toMatchObject({ caregiver: "Sarah (Mom)", minutes_ago: 32 });
  });

  it("exactly one of two simultaneous doses wins, and the bottle is charged once", async () => {
    const [a, b] = await Promise.all([log("Sarah (Mom)", "ka"), log("Dad", "kb")]);
    expect([a.status, b.status].sort()).toEqual(["LOGGED", "REJECTED_LOCKED"]);
    expect(await storage.getLedger("leo")).toHaveLength(1);
    expect((await storage.getInventory()).find((i) => i.id === "infant_motrin_drops")?.remaining).toBe(28);
  });

  it("exactly one of ten simultaneous doses wins", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => log(`caregiver-${i}`, `k${i}`)));
    expect(results.filter((r) => r.status === "LOGGED")).toHaveLength(1);
    expect(results.filter((r) => r.status === "REJECTED_LOCKED")).toHaveLength(9);
    expect(await storage.getLedger("leo")).toHaveLength(1);
    expect((await storage.getInventory()).find((i) => i.id === "infant_motrin_drops")?.remaining).toBe(28);
  });

  it("concurrent retries of the SAME key record one dose and one alert", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => log("Sarah (Mom)", "same")));
    expect(results.every((r) => r.status === "LOGGED")).toBe(true);
    expect(new Set(results.map((r) => r.event_id)).size).toBe(1);
    expect(await storage.getLedger("leo")).toHaveLength(1);
    expect((await storage.getInventory()).find((i) => i.id === "infant_motrin_drops")?.remaining).toBe(28);
  });

  it("a replay after the lock exists returns the original event", async () => {
    const a = await log("Sarah (Mom)", "same");
    const b = await log("Sarah (Mom)", "same");
    expect(b).toMatchObject({ status: "LOGGED", replay: true, event_id: a.event_id });
  });

  it("refuses a dose bigger than the remaining bottle and writes nothing", async () => {
    await storage.reset(createSeed(now, { motrinMl: 1 }));
    const r = await log("Sarah (Mom)", "s1");
    expect(r.status).toBe("REJECTED_STOCK");
    expect(await storage.getLedger("leo")).toHaveLength(0);
    expect((await storage.getInventory()).find((i) => i.id === "infant_motrin_drops")?.remaining).toBe(1);
  });

  it("unlocks after 6 hours and charges the bottle again", async () => {
    await log("Sarah (Mom)", "k1");
    now += 6 * 60 * MIN;
    expect((await log("Dad", "k2")).status).toBe("LOGGED");
    expect((await storage.getInventory()).find((i) => i.id === "infant_motrin_drops")?.remaining).toBe(26);
  });

  it("PIN override persists in the table and unlocks the interval", async () => {
    await log("Sarah (Mom)", "k1");
    now += 5 * MIN;
    expect((await svc.overrideLockout({ patient_id: "leo", ingredient: "ibuprofen", caregiver: "Dad", pin: "4242" })).status).toBe("OVERRIDE_GRANTED");
    expect(await storage.getOverride("leo", "ibuprofen")).toBeGreaterThan(now);
    expect((await log("Dad", "k2")).status).toBe("LOGGED");
  });

  it("stages and confirms a cart through storage", async () => {
    const staged = await svc.stageAmazonCart({ requested_items: [{ item_name: "Infant Motrin Drops", channel: "prime" }, { item_name: "glucose test strips", channel: "pharmacy" }, { item_name: "ginger", channel: "fresh" }] });
    expect(staged.total_usd).toBe(41.29);
    const placed = await svc.confirmAmazonOrder({ cart_id: staged.cart_id as string });
    expect(placed.status).toBe("ORDER_PLACED");
    expect((await storage.getCart(staged.cart_id as string))?.status).toBe("ORDERED");
  });

  it("reset wipes prior events and locks", async () => {
    await log("Sarah (Mom)", "k1");
    await storage.reset(createSeed(now, { motrinMl: 30 }));
    expect(await storage.getLedger("leo")).toHaveLength(0);
    expect((await log("Dad", "k9")).status).toBe("LOGGED");
  });

  it("a seeded dose from Sarah blocks Dad straight away", async () => {
    await storage.reset(createSeed(now, { sarahDosedMinutesAgo: 32, motrinMl: 30 }));
    const r = await log("Dad", "k1");
    expect(r).toMatchObject({ status: "REJECTED_LOCKED" });
    expect((r as any).last_dose.minutes_ago).toBe(32);
  });
});
