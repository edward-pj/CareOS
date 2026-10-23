import { EventEmitter } from "node:events";
import { DEMO_TIMELINE, type ShopEvent, type ShopTimeline } from "open-caregiver-mcp";
import type { TenantResolver } from "./tenants.js";

export interface PublishedShopEvent extends ShopEvent {
  id: number;
  householdId: string;
}

/** Fan-out of shopping changes, tagged by household. Feeds the live Orders screen (GET /api/shop/stream). */
export class ShopBus extends EventEmitter {
  private seq = 0;
  constructor() { super(); this.setMaxListeners(0); }

  publish(householdId: string, e: ShopEvent): PublishedShopEvent {
    const out = { ...e, id: ++this.seq, householdId };
    this.emit("event", out);
    return out;
  }
}

/** Scales the ~1 minute demo schedule to `seconds` of total delivery time. */
export function timelineFor(seconds: number): ShopTimeline {
  const k = (seconds * 1000) / DEMO_TIMELINE.deliveredMs;
  return {
    packedMs: Math.round(DEMO_TIMELINE.packedMs * k),
    shippedMs: Math.round(DEMO_TIMELINE.shippedMs * k),
    outForDeliveryMs: Math.round(DEMO_TIMELINE.outForDeliveryMs * k),
    deliveredMs: Math.round(DEMO_TIMELINE.deliveredMs * k),
  };
}

/**
 * Time advances orders even when nobody is looking, so something has to notice "packed", "shipped" and "delivered".
 * Only households with an order in flight are polled; a household is dropped once nothing is left to deliver.
 */
export class ShopTicker {
  private watched = new Set<string>();
  private timer?: NodeJS.Timeout;
  private busy = false;
  private lastError = new Map<string, string>();

  constructor(private tenants: TenantResolver, private bus: ShopBus, private intervalMs = 1000) {
    bus.on("event", (e: PublishedShopEvent) => { if (e.type === "order.placed") this.watch(e.householdId); });
  }

  watch(householdId: string) { this.watched.add(householdId); }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  /** One pass over the watched households. Exposed for tests. */
  async runOnce() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const hid of [...this.watched]) {
        try {
          const { active } = await this.tenants(hid).service.shop.tick();
          this.lastError.delete(hid);
          if (!active) this.watched.delete(hid);
        } catch (e) {
          // The tick runs every second: log a given failure once, not once a second.
          const msg = e instanceof Error ? e.message : String(e);
          if (this.lastError.get(hid) !== msg) console.error(`[shop] tick failed for ${hid}:`, e);
          this.lastError.set(hid, msg);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
