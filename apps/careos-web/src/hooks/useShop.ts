import { useCallback, useEffect, useRef, useState } from "react";
import { api, subscribeShop } from "../api/client";
import type { ShopEvent, ShopScenario, ShopView } from "../api/types";
import { toastFor } from "../lib/shop";

const FALLBACK_POLL_MS = 5_000;
const TICK_MS = 250;
const MAX_EVENTS = 40;
const TOAST_MS = 6_000;

export interface Toast { id: number; text: string; tone: "info" | "good" | "warn" }

export interface Shop {
  view?: ShopView;
  /** Server-aligned "now" (epoch ms), ticking every 250 ms so progress bars move smoothly. */
  now: number;
  connected: boolean;
  error?: string;
  /** Recent change notices, newest last. */
  events: ShopEvent[];
  toasts: Toast[];
  /** The action currently in flight (a cart id, "add:<name>" or a scenario), for disabling buttons. */
  busy?: string;
  add: (itemName: string) => void;
  order: (cartId: string) => void;
  cancel: (cartId: string) => void;
  scenario: (s: ShopScenario) => void;
  dismissToast: (id: number) => void;
}

/**
 * Live state for the Orders screen. The server pushes a small notice whenever anything changes (a cart edit, an order,
 * a new fulfilment stage, a bottle level); each notice triggers a re-read of /api/shop, so what is on screen is always
 * what is stored. A slow poll covers a dropped stream.
 */
export function useShop(): Shop {
  const [view, setView] = useState<ShopView>();
  const [skew, setSkew] = useState(0);
  const [tick, setTick] = useState(() => Date.now());
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>();
  const [events, setEvents] = useState<ShopEvent[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toastId = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const next = await api.getShop();
      setSkew(next.now - Date.now());
      setView(next);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const clock = setInterval(() => setTick(Date.now()), TICK_MS);
    const poll = setInterval(() => void refresh(), FALLBACK_POLL_MS);
    const unsubscribe = subscribeShop(
      (e) => {
        setEvents((prev) => [...prev, e].slice(-MAX_EVENTS));
        const t = toastFor(e);
        if (t) {
          const id = ++toastId.current;
          setToasts((prev) => [...prev, { id, ...t }].slice(-4));
          setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), TOAST_MS);
        }
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void refresh(), 80);
      },
      (up) => { setConnected(up); if (up) void refresh(); },
    );
    return () => { clearInterval(clock); clearInterval(poll); clearTimeout(timer.current); unsubscribe(); };
  }, [refresh]);

  const run = useCallback((key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    fn().then(() => refresh()).catch((e) => setError(e instanceof Error ? e.message : "Something went wrong")).finally(() => setBusy(undefined));
  }, [refresh]);

  return {
    view,
    now: tick + skew,
    connected,
    error,
    events,
    toasts,
    busy,
    add: (name) => run(`add:${name}`, () => api.shopAdd(name)),
    order: (id) => run(id, () => api.shopOrder(id)),
    cancel: (id) => run(id, () => api.shopCancel(id)),
    scenario: (s) => run(s, () => api.shopScenario(s)),
    dismissToast: (id) => setToasts((prev) => prev.filter((t) => t.id !== id)),
  };
}
