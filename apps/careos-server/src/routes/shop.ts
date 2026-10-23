import express, { type Express, type Response } from "express";
import { z } from "zod";
import type { AuthContext } from "../auth.js";
import { openSse } from "../sse.js";
import type { PublishedShopEvent, ShopBus } from "../shop.js";
import type { TenantResolver } from "../tenants.js";

const addBody = z.object({ items: z.array(z.object({ item_name: z.string().trim().min(1).max(120) })).min(1).max(20) });
const SCENARIOS = ["dad_orders", "low_stock", "fast_forward", "reset_orders"] as const;
const scenarioParam = z.enum(SCENARIOS);

interface Deps {
  tenants: TenantResolver;
  bus: ShopBus;
  heartbeatMs: number;
  who: (res: Response) => AuthContext;
}

/** The simulated Amazon storefront for a household: read model, live change stream, actions, and presenter scenarios. */
export function registerShopRoutes(app: Express, { tenants, bus, heartbeatMs, who }: Deps) {
  const svc = (res: Response) => tenants(who(res).householdId).service;
  const ctx = (res: Response) => ({ caregiverId: who(res).caregiverId });

  app.get("/api/shop", async (_req, res, next) => {
    try { res.json(await svc(res).shop.view()); } catch (e) { next(e); }
  });

  // A change notice, not the data: the screen re-reads /api/shop when one arrives, so it can never drift from storage.
  app.get("/api/shop/stream", (req, res) => {
    const hid = who(res).householdId;
    const sse = openSse(req, res, heartbeatMs);
    sse.send("hello", { household_id: hid });
    const onEvent = (e: PublishedShopEvent) => { if (e.householdId === hid) sse.send("shop", e, e.id); };
    bus.on("event", onEvent);
    res.on("close", () => bus.off("event", onEvent));
  });

  app.post("/api/shop/cart", express.json({ limit: "8kb" }), async (req, res, next) => {
    try {
      const { items } = addBody.parse(req.body);
      res.json(await svc(res).shop.stage(items, ctx(res), "ui"));
    } catch (e) { next(e); }
  });

  app.post("/api/shop/carts/:id/order", async (req, res, next) => {
    try { res.json(await svc(res).confirmAmazonOrder({ cart_id: String(req.params.id) }, ctx(res))); } catch (e) { next(e); }
  });

  app.post("/api/shop/carts/:id/cancel", async (req, res, next) => {
    try { res.json(await svc(res).cancelAmazonOrder({ cart_id: String(req.params.id) }, ctx(res))); } catch (e) { next(e); }
  });

  // ---- presenter scenarios: things that would otherwise need a second person or a day of waiting
  app.post("/api/demo/shop/:scenario", async (req, res, next) => {
    try {
      const scenario = scenarioParam.parse(req.params.scenario);
      const { service, storage } = tenants(who(res).householdId);
      const now = service.now();
      const caregivers = await storage.getCaregivers();
      const other = caregivers.find((c) => c.id !== who(res).caregiverId) ?? caregivers[0];
      const asOther = { caregiverId: other?.id };

      if (scenario === "dad_orders") {
        // A different caregiver stages and orders from their own phone; every open screen should show it appear.
        const staged = await service.shop.stage([{ item_name: "Infant Tylenol" }], asOther, "demo");
        if (staged.status !== "STAGED") { res.json(staged); return; }
        res.json(await service.confirmAmazonOrder({ cart_id: String(staged.cart_id) }, asOther));
        return;
      }
      if (scenario === "low_stock") {
        // The Motrin bottle drops below its threshold, as if a dose were just logged: a restock suggestion should appear.
        const bottle = (await storage.getInventory()).find((i) => i.id === "infant_motrin_drops");
        if (!bottle) { res.status(404).json({ error: "no_motrin_bottle" }); return; }
        const left = await storage.addInventory(bottle.id, -(bottle.remaining - Math.max(0, bottle.lowThreshold - 2)));
        service.shop.noteInventory({ id: bottle.id, name: bottle.name, remaining: left ?? 0, lowThreshold: bottle.lowThreshold }, "Demo");
        res.json({ ok: true, remaining: left });
        return;
      }
      if (scenario === "fast_forward") {
        // Skip the wait: every order in flight arrives now.
        const n = await service.shop.skipToDelivery();
        if (n === 0) { res.status(409).json({ error: "no_order_in_flight" }); return; }
        res.json({ ok: true, delivered: n });
        return;
      }
      // reset_orders: drop carts and orders only (doses and bottles are untouched).
      for (const c of await storage.listCarts()) {
        if (c.status === "STAGED" || c.status === "ORDERED") await storage.transitionCart(c.cartId, [c.status], { status: "CANCELLED", cancelledAt: now });
      }
      service.shop.announce("Orders were cleared", "Demo");
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
}
