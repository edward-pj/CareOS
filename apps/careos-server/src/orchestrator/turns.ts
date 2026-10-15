import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export interface StoredEvent { seq: number; type: string; data: unknown }

interface Turn { events: StoredEvent[]; done: boolean; createdAt: number; bus: EventEmitter }

/**
 * Per-turn event log with a cursor. One source feeds both transports: SSE for browsers/tests and a
 * cursor long-poll for Vega, where only XMLHttpRequest and WebSocket are documented (no streaming fetch / EventSource).
 */
export class TurnStore {
  private turns = new Map<string, Turn>();

  constructor(private ttlMs = 10 * 60_000, private maxTurns = 200, private clock: () => number = Date.now) {}

  create(): string {
    this.prune();
    const id = `turn_${randomUUID().slice(0, 12)}`;
    const bus = new EventEmitter();
    bus.setMaxListeners(0);
    this.turns.set(id, { events: [], done: false, createdAt: this.clock(), bus });
    return id;
  }

  has(id: string): boolean { return this.turns.has(id); }

  append(id: string, type: string, data: unknown): void {
    const t = this.turns.get(id);
    if (!t || t.done) return;
    t.events.push({ seq: t.events.length + 1, type, data });
    if (type === "done") t.done = true;
    t.bus.emit("append");
  }

  /** Events with seq > after. */
  after(id: string, after = 0): { events: StoredEvent[]; done: boolean } | undefined {
    const t = this.turns.get(id);
    if (!t) return undefined;
    return { events: t.events.slice(after), done: t.done };
  }

  /** Resolves when there is something newer than `after`, the turn is done, or the timeout/abort fires. */
  wait(id: string, after: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const t = this.turns.get(id);
    if (!t || t.events.length > after || t.done) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); t.bus.off("append", check); signal?.removeEventListener("abort", finish); resolve(); };
      const check = () => { if (t.events.length > after || t.done) finish(); };
      const timer = setTimeout(finish, timeoutMs);
      t.bus.on("append", check);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  private prune(): void {
    const cutoff = this.clock() - this.ttlMs;
    for (const [id, t] of this.turns) if (t.createdAt < cutoff) this.turns.delete(id);
    while (this.turns.size >= this.maxTurns) this.turns.delete(this.turns.keys().next().value!);
  }
}
