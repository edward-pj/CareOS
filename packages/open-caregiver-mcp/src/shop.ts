import { randomUUID } from "node:crypto";
import type { Payload } from "./contracts.js";
import { CATALOG, findCatalogEntry } from "./data/catalog.js";
import { canCancel, DEMO_TIMELINE, ORDER_STAGES, stageAt, stageSchedule, STAGE_LABEL, type OrderStage, type ShopTimeline } from "./engines/shopTimeline.js";
import { plural } from "./engines/speech.js";
import type { Cart, Notifier, StorageAdapter } from "./storage/types.js";

/** Something changed in the household's shopping state. The server fans these out so every open screen updates live. */
export type ShopEventType =
  | "cart.staged"
  | "cart.discarded"
  | "order.placed"
  | "order.stage"
  | "order.delivered"
  | "order.cancelled"
  | "inventory.changed"
  | "inventory.low"
  | "shop.updated";

export interface ShopEvent {
  type: ShopEventType;
  at: number;
  actor?: string;
  cartId?: string;
  orderId?: string;
  stage?: OrderStage;
  /** One human sentence for the activity feed. */
  summary: string;
}

export interface ShopOptions {
  clock: () => number;
  timeline?: ShopTimeline;
  notifier?: Notifier;
  onEvent?: (e: ShopEvent) => void;
}

export interface ShopContext {
  caregiverId?: string;
}

export type Source = NonNullable<Cart["source"]>;

const usd = (n: number) => `$${n.toFixed(2)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Simulated Amazon storefront for the household: one shared cart, orders that move through fulfilment, and a delivery
 * that refills the matching bottle. No real purchase ever happens. Every state change goes through a compare-and-set on
 * the cart's status, so two caregivers acting at once cannot double-order or double-restock.
 */
export class ShopService {
  private timeline: ShopTimeline;
  /** Last stage we announced per order, so a stage change is announced once. In memory by design: it only suppresses repeats. */
  private seenStage = new Map<string, OrderStage>();

  constructor(private storage: StorageAdapter, private opts: ShopOptions) {
    this.timeline = opts.timeline ?? DEMO_TIMELINE;
  }

  private now() { return this.opts.clock(); }

  private emit(e: Omit<ShopEvent, "at">) {
    try { this.opts.onEvent?.({ ...e, at: this.now() }); } catch (err) { console.error("[shop] event listener failed:", err); }
  }

  private async actor(ctx: ShopContext): Promise<string> {
    if (!ctx.caregiverId) return "Someone";
    const all = await this.storage.getCaregivers();
    const id = ctx.caregiverId.trim().toLowerCase();
    return all.find((c) => c.id === id || c.name.toLowerCase() === id || c.name.toLowerCase().split(/\s+/)[0] === id)?.name ?? ctx.caregiverId;
  }

  // ---------------------------------------------------------------- staging

  /** Adds items to the household's open cart (creating it if needed). Unknown items are reported, never guessed. */
  async stage(items: { item_name: string }[], ctx: ShopContext = {}, source: Source = "voice"): Promise<Payload> {
    const found: Cart["lines"] = [];
    const unavailable: string[] = [];
    for (const it of items) {
      const c = findCatalogEntry(it.item_name);
      if (!c) { unavailable.push(it.item_name); continue; }
      if (!found.some((l) => l.itemName === c.name)) found.push({ itemName: c.name, channel: c.channel, priceUsd: c.priceUsd, merchantLabel: c.merchantLabel, restocks: c.restocks });
    }
    if (found.length === 0) return { status: "NOTHING_STAGED", unavailable_items: unavailable, speech: "I couldn't find that in the store, so nothing was added.", card_type: null };

    const carts = await this.storage.listCarts();
    const onTheWay = new Set(carts.filter((c) => c.status === "ORDERED").flatMap((c) => c.lines.map((l) => l.itemName)));
    const alreadyOnOrder = found.filter((l) => onTheWay.has(l.itemName)).map((l) => l.itemName);
    const by = await this.actor(ctx);

    // One shared cart: add to the open one if there is one.
    let cart = carts.find((c) => c.status === "STAGED");
    if (cart) {
      const lines = [...cart.lines, ...found.filter((n) => !cart!.lines.some((l) => l.itemName === n.itemName))];
      const updated = await this.storage.transitionCart(cart.cartId, ["STAGED"], { lines, totalUsd: round2(lines.reduce((s, l) => s + l.priceUsd, 0)) });
      if (updated) cart = updated;
      else cart = undefined; // it was ordered or discarded a moment ago: start a fresh one
    }
    if (!cart) {
      cart = { cartId: `cart_${randomUUID().slice(0, 8)}`, lines: found, totalUsd: round2(found.reduce((s, l) => s + l.priceUsd, 0)), eta: "Tomorrow by 8:00 AM", status: "STAGED", createdAt: this.now(), createdBy: by, source };
      await this.storage.saveCart(cart);
    }
    this.emit({ type: "cart.staged", actor: by, cartId: cart.cartId, summary: `${by} added ${found.map((l) => l.itemName.split(" (")[0]).join(", ")} to the cart` });

    const dupe = alreadyOnOrder.length > 0 ? `${alreadyOnOrder[0]!.split(" (")[0]} is already on its way.` : undefined;
    return {
      status: "STAGED",
      cart_id: cart.cartId,
      items: cart.lines.map((l) => ({ name: l.itemName, channel: l.channel, merchant: l.merchantLabel, price_usd: l.priceUsd })),
      total_usd: cart.totalUsd,
      eta: cart.eta,
      // Label for the on-screen confirm control (a button in the web app); also what a caregiver can say.
      confirm_label: "Confirm restock order",
      unavailable_items: unavailable,
      already_on_order: alreadyOnOrder,
      speech: `Your cart has ${plural(cart.lines.length, "item")}, ${usd(cart.totalUsd)} in total, arriving ${cart.eta.toLowerCase()}. Say confirm to place the order.`,
      followup: dupe,
      reason_codes: alreadyOnOrder.length ? ["SIMULATED_ORDER", "ALREADY_ON_ORDER"] : ["SIMULATED_ORDER"],
      sources: [],
      read_verbatim: true,
      card_type: "AMAZON_RESTOCK_CAROUSEL",
    };
  }

  // ---------------------------------------------------------------- ordering

  async order(cartId: string, ctx: ShopContext = {}): Promise<Payload> {
    const cart = await this.storage.getCart(cartId);
    if (!cart) return { status: "NOT_FOUND", speech: "I can't find that cart.", card_type: null };
    if (cart.status === "CANCELLED") return { status: "CART_CANCELLED", speech: "That cart was cancelled. Ask me to restock and I'll start a new one.", card_type: null };
    if (cart.status !== "STAGED") return this.alreadyOrdered(cart);

    const by = await this.actor(ctx);
    const orderId = `ord_${randomUUID().slice(0, 8)}`;
    const placed = await this.storage.transitionCart(cartId, ["STAGED"], { status: "ORDERED", orderId, orderedAt: this.now(), orderedBy: by });
    if (!placed) {
      // Someone else got there first (or cancelled it): report what actually happened.
      const now = await this.storage.getCart(cartId);
      return now && now.status !== "STAGED" && now.status !== "CANCELLED" ? this.alreadyOrdered(now) : { status: "CART_CANCELLED", speech: "That cart was cancelled.", card_type: null };
    }
    this.seenStage.set(orderId, "PLACED");
    this.emit({ type: "order.placed", actor: by, cartId, orderId, stage: "PLACED", summary: `${by} placed an order for ${plural(placed.lines.length, "item")} (${usd(placed.totalUsd)})` });
    await this.opts.notifier?.send("ORDER_PLACED", `CareOS: ${by} ordered ${plural(placed.lines.length, "item")} (${usd(placed.totalUsd)}), arriving ${placed.eta.toLowerCase()}.`).catch(() => undefined);
    return {
      status: "ORDER_PLACED",
      simulated: true,
      order_id: orderId,
      cart_id: cartId,
      total_usd: placed.totalUsd,
      eta: placed.eta,
      speech: `Done. Your order for ${usd(placed.totalUsd)} is placed and arriving ${placed.eta.toLowerCase()}. This is a simulated order.`,
      reason_codes: ["SIMULATED_ORDER"],
      sources: [],
      read_verbatim: true,
      card_type: null,
    };
  }

  private alreadyOrdered(cart: Cart): Payload {
    return { status: "ORDER_PLACED", simulated: true, already_ordered: true, order_id: cart.orderId, cart_id: cart.cartId, total_usd: cart.totalUsd, eta: cart.eta, speech: "That order was already placed.", reason_codes: ["SIMULATED_ORDER", "ALREADY_ORDERED"], sources: [], read_verbatim: true, card_type: null };
  }

  // ---------------------------------------------------------------- cancelling

  /** Discards an open cart, or cancels an order that has not shipped. */
  async cancel(cartId: string, ctx: ShopContext = {}): Promise<Payload> {
    const cart = await this.storage.getCart(cartId);
    if (!cart) return { status: "NOT_FOUND", speech: "I can't find that order.", card_type: null };
    if (cart.status === "CANCELLED") return { status: "CANCELLED", already_cancelled: true, cart_id: cartId, speech: "That was already cancelled.", reason_codes: ["ALREADY_CANCELLED"], sources: [], read_verbatim: true, card_type: null };
    const by = await this.actor(ctx);

    if (cart.status === "STAGED") {
      const gone = await this.storage.transitionCart(cartId, ["STAGED"], { status: "CANCELLED", cancelledAt: this.now() });
      if (gone) this.emit({ type: "cart.discarded", actor: by, cartId, summary: `${by} cleared the cart` });
      return gone
        ? { status: "CANCELLED", cart_id: cartId, speech: "I've cleared the cart.", reason_codes: ["CART_DISCARDED"], sources: [], read_verbatim: true, card_type: null }
        : this.cancel(cartId, ctx); // it was ordered a moment ago: fall through to the order rules
    }

    const stage = cart.status === "DELIVERED" ? "DELIVERED" : stageAt(cart.orderedAt ?? 0, this.now(), this.timeline);
    if (!canCancel(stage)) {
      return { status: "CANNOT_CANCEL", cart_id: cartId, order_id: cart.orderId, stage, speech: stage === "DELIVERED" ? "That order has already arrived." : "That order has already shipped, so it can't be cancelled here. You can return it when it arrives.", reason_codes: ["ORDER_ALREADY_SHIPPED"], sources: [], read_verbatim: true, card_type: null };
    }
    const cancelled = await this.storage.transitionCart(cartId, ["ORDERED"], { status: "CANCELLED", cancelledAt: this.now() });
    if (!cancelled) return { status: "CANNOT_CANCEL", cart_id: cartId, order_id: cart.orderId, speech: "That order has just shipped, so it can't be cancelled here.", reason_codes: ["ORDER_ALREADY_SHIPPED"], sources: [], read_verbatim: true, card_type: null };
    this.emit({ type: "order.cancelled", actor: by, cartId, orderId: cart.orderId, summary: `${by} cancelled the order for ${usd(cart.totalUsd)}` });
    return { status: "CANCELLED", cart_id: cartId, order_id: cart.orderId, speech: `Cancelled. Nothing will be charged.`, reason_codes: ["ORDER_CANCELLED"], sources: [], read_verbatim: true, card_type: null };
  }

  // ---------------------------------------------------------------- tracking

  /** "Where's my order?": the newest order that has not arrived (or the one named). */
  async track(a: { order_id?: string } = {}): Promise<Payload> {
    await this.tick();
    const carts = await this.storage.listCarts();
    const live = carts.filter((c) => c.status === "ORDERED" || c.status === "DELIVERED");
    const hit = a.order_id ? live.find((c) => c.orderId === a.order_id || c.cartId === a.order_id) : live.find((c) => c.status === "ORDERED") ?? live[0];
    if (!hit) return { status: "NO_ORDER", speech: "You don't have any orders right now.", reason_codes: ["NO_ORDER"], sources: [], read_verbatim: true, card_type: null };
    const stage = hit.status === "DELIVERED" ? "DELIVERED" : stageAt(hit.orderedAt ?? 0, this.now(), this.timeline);
    const names = hit.lines.map((l) => l.itemName.split(" (")[0]).join(", ");
    return {
      status: "ORDER_STATUS",
      order_id: hit.orderId,
      cart_id: hit.cartId,
      stage,
      stage_label: STAGE_LABEL[stage],
      total_usd: hit.totalUsd,
      eta: hit.eta,
      speech: stage === "DELIVERED" ? `Your order of ${names} has arrived.` : `Your order of ${names} is ${STAGE_LABEL[stage].toLowerCase()}. It's due ${hit.eta.toLowerCase()}.`,
      reason_codes: ["ORDER_STATUS"],
      sources: [],
      read_verbatim: true,
      card_type: null,
    };
  }

  // ---------------------------------------------------------------- clock: stage changes and deliveries

  /**
   * Advances time-driven state: announces new stages and, when an order is delivered, refills the inventory exactly once.
   * Safe to call from any number of places; returns whether any order is still in flight.
   */
  async tick(): Promise<{ active: boolean }> {
    const now = this.now();
    const carts = await this.storage.listCarts();
    let active = false;
    for (const cart of carts) {
      if (cart.status !== "ORDERED" || !cart.orderId) continue;
      const stage = stageAt(cart.orderedAt ?? 0, now, this.timeline);
      if (stage === "DELIVERED") { await this.deliver(cart); continue; }
      active = true;
      const seen = this.seenStage.get(cart.orderId);
      if (seen !== undefined && seen !== stage) {
        this.emit({ type: "order.stage", cartId: cart.cartId, orderId: cart.orderId, stage, summary: `Order ${STAGE_LABEL[stage].toLowerCase()}` });
      }
      this.seenStage.set(cart.orderId, stage);
    }
    return { active };
  }

  /**
   * Claim first, then restock. The claim (ORDERED -> DELIVERED) succeeds for exactly one caller; only that caller adds stock.
   * If the process dies between the two steps the bottle is left short, never over-counted: for a medicine cabinet,
   * "we think we have more than we do" is the dangerous direction.
   */
  private async deliver(cart: Cart) {
    const claimed = await this.storage.transitionCart(cart.cartId, ["ORDERED"], { status: "DELIVERED", deliveredAt: this.now() });
    if (!claimed) return;
    this.seenStage.delete(cart.orderId!);
    const restocked: string[] = [];
    const inventory = await this.storage.getInventory();
    for (const line of claimed.lines) {
      if (!line.restocks) continue;
      const remaining = await this.storage.addInventory(line.restocks.inventoryId, line.restocks.amount);
      const item = inventory.find((i) => i.id === line.restocks!.inventoryId);
      if (remaining !== undefined && item) {
        restocked.push(`${item.name} +${line.restocks.amount}${item.unit === "mL" ? " mL" : ""}`);
        this.emit({ type: "inventory.changed", cartId: cart.cartId, orderId: cart.orderId, summary: `${item.name} restocked (${remaining}${item.unit === "mL" ? " mL" : ""} now)` });
      }
    }
    this.emit({ type: "order.delivered", cartId: cart.cartId, orderId: cart.orderId, stage: "DELIVERED", summary: restocked.length ? `Delivered. Restocked: ${restocked.join(", ")}` : "Delivered" });
    await this.opts.notifier?.send("ORDER_DELIVERED", `CareOS: your order arrived${restocked.length ? ` (${restocked.join(", ")})` : ""}.`).catch(() => undefined);
  }

  /** Demo helper: makes every order in flight look as if it was placed one full delivery time ago, then lets the clock deliver it. */
  async skipToDelivery(): Promise<number> {
    const inFlight = (await this.storage.listCarts()).filter((c) => c.status === "ORDERED");
    const start = this.now() - this.timeline.deliveredMs;
    for (const c of inFlight) await this.storage.transitionCart(c.cartId, ["ORDERED"], { orderedAt: Math.min(c.orderedAt ?? start, start) });
    await this.tick();
    return inFlight.length;
  }

  /** Tells open screens to re-read everything (demo reset, bulk changes). */
  announce(summary: string, actor?: string) { this.emit({ type: "shop.updated", actor, summary }); }

  /** Called when a bottle changes outside the shop (a logged dose), so open screens move the gauge and surface a suggestion. */
  noteInventory(item: { id: string; name: string; remaining: number; lowThreshold: number }, actor?: string) {
    this.emit({ type: "inventory.changed", actor, summary: `${item.name}: ${item.remaining} left` });
    if (item.remaining < item.lowThreshold) this.emit({ type: "inventory.low", actor, summary: `${item.name} is running low` });
  }

  // ---------------------------------------------------------------- the screen's read model

  async view() {
    await this.tick();
    const now = this.now();
    const [carts, inventory] = await Promise.all([this.storage.listCarts(), this.storage.getInventory()]);

    const open = carts.filter((c) => c.status === "STAGED" || c.status === "ORDERED");
    const covered = new Set(open.flatMap((c) => c.lines.map((l) => l.restocks?.inventoryId).filter(Boolean) as string[]));

    const suggestions = inventory
      .filter((i) => i.unit !== "pantry" && i.remaining < i.lowThreshold && !covered.has(i.id))
      .map((i) => ({ i, c: CATALOG.find((e) => e.restocks?.inventoryId === i.id) }))
      .filter((x) => x.c)
      .map(({ i, c }) => ({ inventory_id: i.id, name: i.name, remaining: i.remaining, unit: i.unit, item_name: c!.name, price_usd: c!.priceUsd, channel: c!.channel, merchant: c!.merchantLabel }));

    const view = (c: Cart) => {
      const stage: OrderStage | undefined = c.status === "ORDERED" ? stageAt(c.orderedAt ?? 0, now, this.timeline) : c.status === "DELIVERED" ? "DELIVERED" : undefined;
      return {
        cart_id: c.cartId,
        order_id: c.orderId ?? null,
        status: c.status,
        stage: stage ?? null,
        stage_label: stage ? STAGE_LABEL[stage] : null,
        can_cancel: c.status === "STAGED" || (c.status === "ORDERED" && stage !== undefined && canCancel(stage)),
        lines: c.lines.map((l) => ({ name: l.itemName, channel: l.channel, merchant: l.merchantLabel, price_usd: l.priceUsd, restocks: l.restocks ?? null })),
        total_usd: c.totalUsd,
        eta: c.eta,
        created_at: c.createdAt,
        created_by: c.createdBy ?? null,
        ordered_at: c.orderedAt ?? null,
        ordered_by: c.orderedBy ?? null,
        delivered_at: c.deliveredAt ?? null,
        cancelled_at: c.cancelledAt ?? null,
        schedule: c.orderedAt !== undefined ? stageSchedule(c.orderedAt, this.timeline).map((s) => ({ stage: s.stage, label: STAGE_LABEL[s.stage], at: s.at })) : null,
      };
    };

    const activity = carts
      .flatMap((c) => {
        const items = plural(c.lines.length, "item");
        const rows: { at: number; text: string; cart_id: string }[] = [];
        if (c.createdAt) rows.push({ at: c.createdAt, text: `${c.createdBy ?? "Someone"} started a cart (${items})`, cart_id: c.cartId });
        if (c.orderedAt) rows.push({ at: c.orderedAt, text: `${c.orderedBy ?? "Someone"} placed an order (${usd(c.totalUsd)})`, cart_id: c.cartId });
        if (c.deliveredAt) rows.push({ at: c.deliveredAt, text: `Order delivered (${items})`, cart_id: c.cartId });
        if (c.cancelledAt) rows.push({ at: c.cancelledAt, text: c.orderedAt ? "Order cancelled" : "Cart cleared", cart_id: c.cartId });
        return rows;
      })
      .sort((a, b) => b.at - a.at)
      .slice(0, 25);

    return {
      now,
      simulated: true,
      stages: ORDER_STAGES.map((s) => ({ stage: s, label: STAGE_LABEL[s] })),
      delivery_seconds: Math.round(this.timeline.deliveredMs / 1000),
      cart: carts.filter((c) => c.status === "STAGED").map(view)[0] ?? null,
      orders: carts.filter((c) => c.status !== "STAGED").map(view),
      suggestions,
      supplies: inventory.map((i) => ({ id: i.id, name: i.name, remaining: i.remaining, unit: i.unit, low_threshold: i.lowThreshold, low: i.unit !== "pantry" && i.remaining < i.lowThreshold })),
      catalog: CATALOG.map((c) => ({ name: c.name, channel: c.channel, merchant: c.merchantLabel, price_usd: c.priceUsd, restocks: c.restocks ?? null })),
      activity,
    };
  }
}
