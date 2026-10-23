import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStorage, createSeed } from "open-caregiver-mcp";
import { createApp } from "../src/app.js";
import { TokenAuth } from "../src/auth.js";
import { ShopBus, ShopTicker, timelineFor } from "../src/shop.js";
import { createTenants } from "../src/tenants.js";

const A = "household-a-sarah-token-0001";
const A2 = "household-a-dad-token-000003";
const B = "household-b-maya-token-00002";

let server: Server;
let base: string;
let now = Date.UTC(2026, 9, 19, 12, 0);
let ticker: ShopTicker;
const bus = new ShopBus();

beforeAll(async () => {
  const auth = TokenAuth.fromSpec(`${A}=hh-a:sarah, ${A2}=hh-a:dad, ${B}=hh-b:maya`);
  const root = new MemoryStorage();
  for (const h of auth.households()) await root.forHousehold(h).reset(createSeed(now));
  const tenants = createTenants(root, { clock: () => now, shopTimeline: timelineFor(60), onShopEvent: (h, e) => bus.publish(h, e) });
  ticker = new ShopTicker(tenants, bus);
  const { app } = createApp({ tenants, auth, shopBus: bus, sseHeartbeatMs: 60 });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });

const call = (token: string | undefined, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
const shop = async (token: string) => (await call(token, "GET", "/api/shop")).json() as Promise<any>;

/** Opens the live stream and collects `shop` events until closed. */
async function listen(token: string) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/shop/stream`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
  const events: any[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (type === "shop" && data) events.push(JSON.parse(data));
        }
      }
    } catch { /* aborted */ }
  })();
  return { events, close: () => { ac.abort(); return pump; } };
}
const until = async (cond: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); } };

describe("/api/shop", () => {
  it("requires a bearer token", async () => {
    expect((await call(undefined, "GET", "/api/shop")).status).toBe(401);
    expect((await call(undefined, "GET", "/api/shop/stream")).status).toBe(401);
    expect((await call(undefined, "POST", "/api/shop/cart", { items: [{ item_name: "motrin" }] })).status).toBe(401);
  });

  it("starts with low-stock suggestions, no cart and no orders", async () => {
    const v = await shop(A);
    expect(v).toMatchObject({ simulated: true, cart: null, orders: [], delivery_seconds: 60 });
    expect(v.suggestions.map((s: any) => s.inventory_id).sort()).toEqual(["infant_motrin_drops", "test_strips"]);
  });

  it("add to cart -> order -> deliver, with the bottle refilled, and every step pushed live to the other caregiver", async () => {
    const dad = await listen(A2);
    const before = (await shop(A)).supplies.find((s: any) => s.id === "infant_motrin_drops").remaining;

    const staged: any = await (await call(A, "POST", "/api/shop/cart", { items: [{ item_name: "Infant Motrin Drops" }] })).json();
    expect(staged).toMatchObject({ status: "STAGED", card_type: "AMAZON_RESTOCK_CAROUSEL" });
    await until(() => dad.events.some((e) => e.type === "cart.staged"));
    expect(dad.events[0].actor).toBe("Sarah (Mom)");

    const placed: any = await (await call(A2, "POST", `/api/shop/carts/${staged.cart_id}/order`)).json();
    expect(placed).toMatchObject({ status: "ORDER_PLACED", simulated: true });
    expect((await shop(A)).orders[0]).toMatchObject({ status: "ORDERED", stage: "PLACED", ordered_by: "Dad", can_cancel: true });

    now += 25_000;
    await ticker.runOnce();
    expect((await shop(A)).orders[0].stage).toBe("SHIPPED");
    expect((await shop(A)).orders[0].can_cancel).toBe(false);

    now += 40_000;
    await ticker.runOnce();
    const done = await shop(A);
    expect(done.orders[0]).toMatchObject({ status: "DELIVERED", stage: "DELIVERED" });
    expect(done.supplies.find((s: any) => s.id === "infant_motrin_drops").remaining).toBe(before + 15);
    await until(() => dad.events.some((e) => e.type === "order.delivered"));
    expect(dad.events.map((e) => e.type)).toEqual(expect.arrayContaining(["cart.staged", "order.placed", "order.stage", "order.delivered", "inventory.changed"]));
    await dad.close();
  });

  it("cancel works before shipping and is refused after; unknown carts 404-style", async () => {
    const staged: any = await (await call(A, "POST", "/api/shop/cart", { items: [{ item_name: "test strips" }] })).json();
    await call(A, "POST", `/api/shop/carts/${staged.cart_id}/order`);
    const ok: any = await (await call(A, "POST", `/api/shop/carts/${staged.cart_id}/cancel`)).json();
    expect(ok.status).toBe("CANCELLED");

    const s2: any = await (await call(A, "POST", "/api/shop/cart", { items: [{ item_name: "chamomile" }] })).json();
    await call(A, "POST", `/api/shop/carts/${s2.cart_id}/order`);
    now += 30_000;
    const refused: any = await (await call(A, "POST", `/api/shop/carts/${s2.cart_id}/cancel`)).json();
    expect(refused).toMatchObject({ status: "CANNOT_CANCEL" });
    expect(await (await call(A, "POST", "/api/shop/carts/nope/cancel")).json()).toMatchObject({ status: "NOT_FOUND" });
  });

  it("validates input", async () => {
    expect((await call(A, "POST", "/api/shop/cart", { items: [] })).status).toBe(400);
    expect((await call(A, "POST", "/api/shop/cart", { items: [{ item_name: "" }] })).status).toBe(400);
  });
});

describe("household isolation", () => {
  it("one household cannot see, order, cancel or hear about another's cart", async () => {
    const listenB = await listen(B);
    const a: any = await (await call(A, "POST", "/api/shop/cart", { items: [{ item_name: "ginger" }] })).json();
    expect(await (await call(B, "POST", `/api/shop/carts/${a.cart_id}/order`)).json()).toMatchObject({ status: "NOT_FOUND" });
    expect(await (await call(B, "POST", `/api/shop/carts/${a.cart_id}/cancel`)).json()).toMatchObject({ status: "NOT_FOUND" });
    expect((await shop(B)).cart).toBeNull();
    expect((await shop(B)).orders).toEqual([]);
    await new Promise((r) => setTimeout(r, 80));
    expect(listenB.events).toEqual([]);
    await listenB.close();
  });
});

describe("presenter scenarios", () => {
  it("dad_orders: a different caregiver orders, and it shows who", async () => {
    const before = (await shop(A)).orders.length;
    const r: any = await (await call(A, "POST", "/api/demo/shop/dad_orders")).json();
    expect(r.status).toBe("ORDER_PLACED");
    const v = await shop(A);
    expect(v.orders.length).toBe(before + 1);
    expect(v.orders[0].ordered_by).toBe("Dad");
  });

  it("low_stock drops the Motrin bottle and surfaces a suggestion; fast_forward delivers and refills", async () => {
    await call(A, "POST", "/api/demo/reset");
    await call(A, "POST", "/api/demo/shop/low_stock");
    let v = await shop(A);
    expect(v.supplies.find((s: any) => s.id === "infant_motrin_drops").low).toBe(true);
    expect(v.suggestions.map((s: any) => s.inventory_id)).toContain("infant_motrin_drops");

    const staged: any = await (await call(A, "POST", "/api/shop/cart", { items: [{ item_name: "motrin" }] })).json();
    await call(A, "POST", `/api/shop/carts/${staged.cart_id}/order`);
    expect((await shop(A)).suggestions.map((s: any) => s.inventory_id)).not.toContain("infant_motrin_drops");
    expect((await call(A, "POST", "/api/demo/shop/fast_forward")).status).toBe(200);
    v = await shop(A);
    expect(v.orders[0].status).toBe("DELIVERED");
    expect(v.supplies.find((s: any) => s.id === "infant_motrin_drops").low).toBe(false);
  });

  it("fast_forward with nothing in flight is a 409, unknown scenarios are 400", async () => {
    await call(A, "POST", "/api/demo/shop/reset_orders");
    expect((await call(A, "POST", "/api/demo/shop/fast_forward")).status).toBe(409);
    expect((await call(A, "POST", "/api/demo/shop/launch_missiles")).status).toBe(400);
  });
});

describe("ticker", () => {
  it("stops watching a household once nothing is in flight", async () => {
    await call(A, "POST", "/api/demo/shop/reset_orders");
    await ticker.runOnce();
    const watched = (ticker as unknown as { watched: Set<string> }).watched;
    expect(watched.has("hh-a")).toBe(false);
  });
});
