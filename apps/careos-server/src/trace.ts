import { EventEmitter } from "node:events";
import type { Frame } from "open-caregiver-mcp/http";

export type TraceKind = "call" | "result" | "blocked" | "error" | "other";

export interface TraceEvent {
  id: number;
  ts: number;
  dir: "in" | "out";
  kind: TraceKind;
  method?: string;
  tool?: string;
  summary: string;
  message: unknown;
}

const BLOCKING = /^(BLOCKED|REJECTED_.*|OVERRIDE_DENIED|SEEK_CARE)$/;
const short = (v: unknown, n = 160) => { const s = JSON.stringify(v) ?? ""; return s.length > n ? `${s.slice(0, n)}…` : s; };

/** Ring buffer + fan-out of every JSON-RPC frame crossing /mcp. Feeds the inspector drawer. */
export class TraceBus extends EventEmitter {
  private ring: TraceEvent[] = [];
  private seq = 0;
  /** request id -> tool name, so a result frame can name the tool it answers. */
  private pending = new Map<string, string>();

  constructor(private capacity = 500) { super(); this.setMaxListeners(0); }

  push(frame: Frame): TraceEvent {
    const e = this.classify(frame);
    this.ring.push(e);
    if (this.ring.length > this.capacity) this.ring.shift();
    this.emit("event", e);
    return e;
  }

  since(id = 0): TraceEvent[] { return this.ring.filter((e) => e.id > id); }
  clear(): void { this.ring = []; this.pending.clear(); }

  private classify(f: Frame): TraceEvent {
    const m = f.message as Record<string, any>;
    const base = { id: ++this.seq, ts: f.ts, dir: f.dir, message: f.message };
    const key = `${f.sessionId ?? ""}:${m.id}`;

    if (f.dir === "in" && m.method === "tools/call") {
      const tool = String(m.params?.name);
      this.pending.set(key, tool);
      return { ...base, kind: "call", method: "tools/call", tool, summary: `tools/call: ${tool} ${short(m.params?.arguments)}` };
    }
    if (f.dir === "in" && typeof m.method === "string") {
      const extra = m.method === "resources/read" ? ` ${m.params?.uri}` : "";
      return { ...base, kind: "other", method: m.method, summary: `${m.method}${extra}` };
    }
    if (f.dir === "out" && m.error) {
      this.pending.delete(key);
      return { ...base, kind: "error", summary: `error ${m.error.code}: ${m.error.message}` };
    }
    if (f.dir === "out" && m.result) {
      const tool = this.pending.get(key);
      this.pending.delete(key);
      const sc = m.result.structuredContent as Record<string, unknown> | undefined;
      if (tool && sc) {
        const status = String(sc.status);
        const keep = Object.fromEntries(Object.entries(sc).filter(([k]) => ["status", "violation_type", "dispense_volume_ml", "next_eligible_time", "total_usd", "card_type"].includes(k)));
        return { ...base, kind: BLOCKING.test(status) || m.result.isError ? "blocked" : "result", tool, summary: `tool_result: ${short(keep)}` };
      }
      if (tool) return { ...base, kind: m.result.isError ? "error" : "result", tool, summary: `tool_result: ${short(m.result.content?.[0]?.text)}` };
      return { ...base, kind: "other", summary: Array.isArray(m.result.tools) ? `tools/list -> ${m.result.tools.length} tools` : "result" };
    }
    return { ...base, kind: "other", method: m.method, summary: String(m.method ?? "message") };
  }
}
