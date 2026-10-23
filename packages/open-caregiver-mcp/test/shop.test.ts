import { beforeEach, describe, expect, it } from "vitest";
import { CareService, DEMO_TIMELINE, MemoryAdapter, createSeed, stageAt, type ShopEvent } from "../src/server.js";
import { NOW } from "./helpers.js";

let now: number;
let storage: MemoryAdapter;
let svc: CareService;
let events: ShopEvent[];

const sarah = { caregiverId: "sarah" };
const dad = { caregiverId: "dad" };
const MOTRIN = [{ item_name: "Infant Motrin Drops" }];
const stock = async (id: string) => (await storage.getInventory()).find((i) => i.id === id)!.remaining;
const seconds = (s: number) => { now += s * 1000; };
const types = () => events.map((e) => e.type);

beforeEach(() => {
  now = NOW;
  events = [];
  storage = new MemoryAdapter(createSeed(now));
  svc = new CareService(storage, { clock: () => now, signingSecret: "test", onShopEvent: (e) => events.push(e) });
});

describe("staging: one shared household cart", () => {
  it("adds to the open cart instead of creating a second one, and de-duplicates", async () => {
    const a = await svc.stageAmazonCart({ requested_items: MOTRIN }, sarah);
    const b = await svc.stageAmazonCart({ requested_items: [{ item_name: "test strips" }, { item_name: "motrin" }] }, dad);
    expect(b.cart_id).toBe(a.cart_id);
    expect((b.items as unknown[]).length).toBe(2);
    expect(b.total_usd).toBe(36.47);
    expect((await storage.listCarts()).length).toBe(1);
    expect(events.map((e) => e.actor)).toEqual(["Sarah (Mom)", "Dad"]);
  });

  it("never guesses: an unknown item is reported and nothing is staged for it", async () => {
    const r = await svc.stageAmazonCart({ requested_items: [{ item_name: "unicorn tears" }] }, sarah);
    expect(r).toMatchObject({ status: "NOTHING_STAGED", unavailable_items: ["unicorn tears"] });
    expect(await storage.listCarts()).toEqual([]);
    const mixed = await svc.stageAmazonCart({ requested_items: [{ item_name: "unicorn tears" }, ...MOTRIN] }, sarah);
    expect(mixed).toMatchObject({ status: "STAGED", unavailable_items: ["unicorn tears"] });
  });

  it("speaks the total from the tool and marks the order as simulated", async () => {
    const r = await svc.stageAmazonCart({ requested_items: MOTRIN }, sarah);
    expect(r).toMatchObject({ read_verbatim: true, card_type: "AMAZON_RESTOCK_CAROUSEL" });
    expect(r.speech).toContain("$11.48");
    const placed = await svc.confirmAmazonOrder({ cart_id: r.cart_id as string }, sarah);
    expect(placed).toMatchObject({ status: "ORDER_PLACED", simulated: true });
    expect(placed.speech).toContain("simulated");
  });

  it("warns when an item is already on its way, without blocking", async () => {
    const first = await svc.stageAmazonCart({ requested_items: MOTRIN }, sarah);
    await svc.confirmAmazonOrder({ cart_id: first.cart_id as string }, sarah);
    const again = await svc.stageAmazonCart({ requested_items: MOTRIN }, dad);
    expect(again).toMatchObject({ status: "STAGED", already_on_order: [expect.stringContaining("Motrin")] });
    expect(again.cart_id).not.toBe(first.cart_id);
    expect(again.followup).toContain("already on its way");
  });
});

describe("ordering", () => {
  it("places an order once, attributed to the caregiver, and replays safely", async () => {
    const { cart_id } = await svc.stageAmazonCart({ requested_items: MOTRIN }, sarah);
    const a = await svc.confirmAmazonOrder({ cart_id: cart_id as string }, dad);
    const b = await svc.confirmAmazonOrder({ cart_id: cart_id as string }, sarah);
    expect(a.status).toBe("ORDER_PLACED");
    expect(b).toMatchObject({ already_ordered: true, order_id: a.order_id });
    expect((await storage.getCart(cart_id as string))?.orderedBy).toBe("Dad");
    expect(types().filter((t) => t === "order.placed")).toHaveLength(1);
  });

  it("two caregivers pressing order at the same instant place exactly one order", async () => {
    const { cart_id } = await svc.stageAmazonCart({ requested_items: MOTRIN }, sarah);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => svc.confirmAmazonOrder({ cart_id: cart_id as string }, i % 2 ? dad : sarah)));
    expect(new Set(results.map((r) => r.order_id)).size).toBe(1);
    expect(results.filter((r) => !r.already_ordered)).toHaveLength(1);
    expect(types().filter((t) => t === "order.placed")).toHaveLength(1);
  });

  it("unknown or cancelled carts cannot be ordered", async () => {
    expect(await svc.confirmAmazonOrder({ cart_id: "nope" }, sarah)).toMatchObject({ status: "NOT_FOUND" });
    const { cart_id } = await svc.stageAmazonCart({ requested_items: MOTRIN }, sarah);
    await svc.cancelAmazonOrder({ cart_id: cart_id as string }, sarah);
    expect(await svc.confirmAmazonOrder({ cart_id: cart_id as string }, sarah)).toMatchObject({ status: "CART_CANCELLED" });
  });
});

describe("who did it", () => {
  it("an explicit caregiver_id (the speaker) wins over the signed-in caregiver", async () => {
    const staged = await svc.stageAmazonCart({ requested_items: MOTRIN, caregiver_id: "Dad" }, sarah);
    const placed = await svc.confirmAmazonOrder({ cart_id: staged.cart_id as string, caregiver_id: "Dad" }, sarah);
    expect(placed.status).toBe("ORDER_PLACED");
    expect((await storage.getCart(staged.cart_id as string))).toMatchObject({ createdBy: "Dad", orderedBy: "Dad" });
  });
  it("with no explicit caregiver the signed-in one is used, and with neither it says Someone", async () => {
    await svc.stageAmazonCart({ requested_items: MOTRIN }, sarah);
    expect((await storage.listCarts())[0]!.createdBy).toBe("Sarah (Mom)");
    await svc.cancelAmazonOrder({ cart_id: (await storage.listCarts())[0]!.cartId });
    seconds(1);
    await svc.stageAmazonCart({ requested_items: MOTRIN });
    expect((await storage.listCarts())[0]!.createdBy).toBe("Someone");
  });
});

describe("fulfilment clock", () => {
  it("skipToDelivery delivers every order in flight and refills once", async () => {
    const before = await stock("infant_motrin_drops");
    const a = await svc.stageAmazonCart({ requested_items: MOTRIN }, sarah);
    await svc.confirmAmazonOrder({ cart_id: a.cart_id as string }, sarah);
    const b = await svc.stageAmazonCart({ requested_items: [{ item_name: "tylenol" }] }, dad);
    await svc.confirmAmazonOrder({ cart_id: b.cart_id as string }, dad);
    expect(await svc.shop.skipToDelivery()).toBe(2);
    expect((await storage.listCarts()).every((c) => c.status === "DELIVERED")).toBe(true);
    expect(await stock("infant_motrin_drops")).toBe(before + 15);
    expect(await svc.shop.skipToDelivery()).toBe(0);
    expect(await stock("infant_motrin_drops")).toBe(before + 15);
  });

  async function placed() {
    const { cart_id } = await svc.stageAmazonCart({ requested_items: MOTRIN }, sarah);
    await svc.confirmAmazonOrder({ cart_id: cart_id as string }, sarah);
    return cart_id as string;
  }

  it("stage is a pure function of time since the order", () => {
    const t0 = 1_000;
    expect(stageAt(t0, t0, DEMO_TIMELINE)).toBe("PLACED");
    expect(stageAt(t0, t0 + DEMO_TIMELINE.packedMs, DEMO_TIMELINE)).toBe("PACKED");
    expect(stageAt(t0, t0 + DEMO_TIMELINE.shippedMs - 1, DEMO_TIMELINE)).toBe("PACKED");
    expect(stageAt(t0, t0 + DEMO_TIMELINE.shippedMs, DEMO_TIMELINE)).toBe("SHIPPED");
    expect(stageAt(t0, t0 + DEMO_TIMELINE.deliveredMs, DEMO_TIMELINE)).toBe("DELIVERED");
  });

  it("announces each stage once, in order", async () => {
    await placed();
    for (const s of [3, 6, 9, 15, 25]) { seconds(s); await svc.shop.tick(); await svc.shop.tick(); }
    const stages = events.filter((e) => e.type === "order.stage").map((e) => e.stage);
    expect(stages).toEqual([...new Set(stages)]);
    expect(stages[0]).toBe("PACKED");
    expect(stages).toContain("OUT_FOR_DELIVERY");
  });

  it("a delivery refills the bottle exactly once, even if many screens poll at the same moment", async () => {
    const before = await stock("infant_motrin_drops");
    await placed();
    seconds(DEMO_TIMELINE.deliveredMs / 1000 + 1);
    await Promise.all(Array.from({ length: 15 }, () => svc.shop.tick()));
    await svc.shop.view();
    expect(await stock("infant_motrin_drops")).toBe(before + 15);
    expect(types().filter((t) => t === "order.delivered")).toHaveLength(1);
    expect((await storage.listCarts())[0]).toMatchObject({ status: "DELIVERED" });
  });

  it("tracking speaks the current stage, then 'arrived'", async () => {
    expect(await svc.trackAmazonOrder({})).toMatchObject({ status: "NO_ORDER" });
    await placed();
    seconds(25);
    const mid = await svc.trackAmazonOrder({});
    expect(mid).toMatchObject({ status: "ORDER_STATUS", stage: "SHIPPED", read_verbatim: true });
    seconds(60);
    expect(await svc.trackAmazonOrder({})).toMatchObject({ stage: "DELIVERED", speech: expect.stringContaining("arrived") });
  });
});

describe("cancelling", () => {
  it("clears an open cart", async () => {
    const { cart_id } = await svc.stageAmazonCart({ requested_items: MOTRIN }, sarah);
    expect(await svc.cancelAmazonOrder({ cart_id: cart_id as string }, sarah)).toMatchObject({ status: "CANCELLED" });
    expect(types()).toContain("cart.discarded");
    expect((await svc.shop.view()).cart).toBeNull();
  });

  it("cancels an order that has not shipped, and a cancelled order never restocks", async () => {
    const before = await stock("infant_motrin_drops");
    const { cart_id } = await svc.stageAmazonCart({ requested_items: MOTRIN }, sarah);
    await svc.confirmAmazonOrder({ cart_id: cart_id as string }, sarah);
    seconds(5);
    expect(await svc.cancelAmazonOrder({ cart_id: cart_id as string }, dad)).toMatchObject({ status: "CANCELLED" });
    seconds(120);
    await svc.shop.tick();
    expect(await stock("infant_motrin_drops")).toBe(before);
    expect(types()).not.toContain("order.delivered");
    expect(await svc.cancelAmazonOrder({ cart_id: cart_id as string }, dad)).toMatchObject({ status: "CANCELLED", already_cancelled: true });
  });

  it("refuses once the order has shipped, and after delivery", async () => {
    const { cart_id } = await svc.stageAmazonCart({ requested_items: MOTRIN }, sarah);
    await svc.confirmAmazonOrder({ cart_id: cart_id as string }, sarah);
    seconds(25);
    expect(await svc.cancelAmazonOrder({ cart_id: cart_id as string }, sarah)).toMatchObject({ status: "CANNOT_CANCEL", reason_codes: ["ORDER_ALREADY_SHIPPED"] });
    seconds(60);
    await svc.shop.tick();
    expect(await svc.cancelAmazonOrder({ cart_id: cart_id as string }, sarah)).toMatchObject({ status: "CANNOT_CANCEL", stage: "DELIVERED" });
  });
});

describe("the screen's read model", () => {
  it("suggests the low items that have a catalog match and are not already covered", async () => {
    const v = await svc.shop.view();
    expect(v.simulated).toBe(true);
    expect(v.suggestions.map((s) => s.inventory_id).sort()).toEqual(["infant_motrin_drops", "test_strips"]);
    await svc.stageAmazonCart({ requested_items: MOTRIN }, sarah);
    expect((await svc.shop.view()).suggestions.map((s) => s.inventory_id)).toEqual(["test_strips"]);
  });

  it("reports cart, orders, supplies and an activity feed newest first, with the numbers the server computed", async () => {
    const { cart_id } = await svc.stageAmazonCart({ requested_items: [...MOTRIN, { item_name: "ginger" }] }, sarah);
    seconds(2);
    await svc.confirmAmazonOrder({ cart_id: cart_id as string }, dad);
    await svc.stageAmazonCart({ requested_items: [{ item_name: "chamomile" }] }, sarah);
    const v = await svc.shop.view();
    expect(v.cart).toMatchObject({ status: "STAGED", total_usd: 3.99 });
    expect(v.orders[0]).toMatchObject({ status: "ORDERED", stage: "PLACED", can_cancel: true, total_usd: 16.3, ordered_by: "Dad" });
    expect(v.orders[0]!.schedule!.map((s) => s.stage)).toEqual(["PLACED", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]);
    expect(v.activity[0]!.at).toBeGreaterThanOrEqual(v.activity[v.activity.length - 1]!.at);
    expect(v.supplies.find((s) => s.id === "infant_motrin_drops")).toMatchObject({ low: true, unit: "mL" });
    expect(v.delivery_seconds).toBe(60);
  });
});

describe("bottle changes outside the shop", () => {
  it("logging a dose moves the gauge and, when the bottle runs low, raises a low-stock event", async () => {
    const r = await svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: "Sarah (Mom)", bottle_concentration: undefined }, sarah);
    const done = await svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: "Sarah (Mom)", confirmation_token: r.confirmation_token as string }, sarah);
    expect(done.status).toBe("LOGGED");
    expect(types()).toEqual(expect.arrayContaining(["inventory.changed", "inventory.low"]));
    expect(events.find((e) => e.type === "inventory.changed")?.summary).toContain("Motrin");
  });
});
