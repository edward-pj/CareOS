import type { ShopEvent, ShopOrder } from "../api/types";

// Pure helpers for the Orders screen. Anything with a number the user reads (prices, totals, stock, stages) is copied from
// the server; what is computed here is only layout: how far along a progress bar is, and how long ago something happened.

/** 0..1 across the whole delivery timeline, moving smoothly between stage boundaries. */
export function progressFraction(schedule: NonNullable<ShopOrder["schedule"]>, now: number): number {
  if (schedule.length < 2) return 0;
  if (now <= schedule[0]!.at) return 0;
  const last = schedule[schedule.length - 1]!;
  if (now >= last.at) return 1;
  for (let i = 0; i < schedule.length - 1; i++) {
    const a = schedule[i]!;
    const b = schedule[i + 1]!;
    if (now >= a.at && now < b.at) return (i + (now - a.at) / (b.at - a.at)) / (schedule.length - 1);
  }
  return 1;
}

/** "just now", "12s ago", "3m ago", "2h ago", "yesterday". */
export function relativeTime(now: number, at: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return h < 48 ? "yesterday" : `${Math.floor(h / 24)}d ago`;
}

/** "0:34" until the last scheduled stage; empty once it has passed. */
export function countdown(schedule: NonNullable<ShopOrder["schedule"]>, now: number): string {
  const end = schedule[schedule.length - 1]!.at;
  const ms = end - now;
  if (ms <= 0) return "";
  const t = Math.ceil(ms / 1000);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** Events worth a toast. Stage ticks and gauge moves are shown in place, not announced. */
export function toastFor(e: ShopEvent): { text: string; tone: "info" | "good" | "warn" } | undefined {
  switch (e.type) {
    case "cart.staged": return { text: e.summary, tone: "info" };
    case "order.placed": return { text: e.summary, tone: "good" };
    case "order.delivered": return { text: e.summary, tone: "good" };
    case "order.cancelled":
    case "cart.discarded": return { text: e.summary, tone: "warn" };
    case "inventory.low": return { text: e.summary, tone: "warn" };
    default: return undefined;
  }
}

/** Cart ids that a recent event touched, so the screen can flash them. */
export function touched(events: ShopEvent[], now: number, windowMs = 4000): Set<string> {
  return new Set(events.filter((e) => e.cartId && now - e.at < windowMs).map((e) => e.cartId!));
}

/** Gauge fill, 0..1. Visual only: the number printed next to it is always the server's. */
export function gaugeFill(remaining: number, lowThreshold: number): number {
  const full = Math.max(lowThreshold * 4, remaining, 1);
  return Math.max(0, Math.min(1, remaining / full));
}
