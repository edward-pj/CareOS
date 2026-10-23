import { describe, expect, it } from "vitest";
import type { ShopEvent, ShopOrder } from "../api/types";
import { countdown, gaugeFill, progressFraction, relativeTime, toastFor, touched } from "./shop";

const schedule: NonNullable<ShopOrder["schedule"]> = [
  { stage: "PLACED", label: "Order placed", at: 0 },
  { stage: "PACKED", label: "Packed", at: 8_000 },
  { stage: "SHIPPED", label: "Shipped", at: 20_000 },
  { stage: "OUT_FOR_DELIVERY", label: "Out for delivery", at: 38_000 },
  { stage: "DELIVERED", label: "Delivered", at: 60_000 },
];

describe("progressFraction", () => {
  it("is 0 before the order, 1 once delivered, and lands on each stage node exactly", () => {
    expect(progressFraction(schedule, -5)).toBe(0);
    expect(progressFraction(schedule, 0)).toBe(0);
    expect(progressFraction(schedule, 8_000)).toBe(0.25);
    expect(progressFraction(schedule, 20_000)).toBe(0.5);
    expect(progressFraction(schedule, 38_000)).toBe(0.75);
    expect(progressFraction(schedule, 60_000)).toBe(1);
    expect(progressFraction(schedule, 999_999)).toBe(1);
  });
  it("moves smoothly between nodes and never goes backwards", () => {
    expect(progressFraction(schedule, 4_000)).toBeCloseTo(0.125);
    let prev = -1;
    for (let t = 0; t <= 61_000; t += 500) { const f = progressFraction(schedule, t); expect(f).toBeGreaterThanOrEqual(prev); prev = f; }
  });
});

describe("countdown / relativeTime", () => {
  it("formats the time left, and nothing once delivered", () => {
    expect(countdown(schedule, 26_000)).toBe("0:34");
    expect(countdown(schedule, 0)).toBe("1:00");
    expect(countdown(schedule, 60_000)).toBe("");
  });
  it("reads naturally", () => {
    expect(relativeTime(10_000, 9_000)).toBe("just now");
    expect(relativeTime(40_000, 10_000)).toBe("30s ago");
    expect(relativeTime(600_000, 0)).toBe("10m ago");
    expect(relativeTime(3 * 3_600_000, 0)).toBe("3h ago");
    expect(relativeTime(30 * 3_600_000, 0)).toBe("yesterday");
    expect(relativeTime(100 * 3_600_000, 0)).toBe("4d ago");
  });
});

describe("toasts and highlights", () => {
  const ev = (type: ShopEvent["type"], extra: Partial<ShopEvent> = {}): ShopEvent => ({ id: 1, type, at: 1000, summary: "x", ...extra });
  it("announces who did what, but not stage ticks or gauge moves", () => {
    expect(toastFor(ev("order.placed"))?.tone).toBe("good");
    expect(toastFor(ev("order.cancelled"))?.tone).toBe("warn");
    expect(toastFor(ev("inventory.low"))?.tone).toBe("warn");
    expect(toastFor(ev("order.stage"))).toBeUndefined();
    expect(toastFor(ev("inventory.changed"))).toBeUndefined();
  });
  it("flashes only carts touched in the last few seconds", () => {
    const events = [ev("order.placed", { cartId: "a", at: 9_000 }), ev("order.placed", { cartId: "b", at: 1_000 }), ev("shop.updated", { at: 9_500 })];
    expect([...touched(events, 10_000)]).toEqual(["a"]);
  });
});

describe("gaugeFill", () => {
  it("is a 0..1 fraction that grows with stock and never overflows", () => {
    expect(gaugeFill(0, 4)).toBe(0);
    expect(gaugeFill(3.5, 4)).toBeCloseTo(0.219, 2);
    expect(gaugeFill(18.5, 4)).toBeGreaterThan(gaugeFill(3.5, 4));
    expect(gaugeFill(500, 4)).toBe(1);
  });
});
