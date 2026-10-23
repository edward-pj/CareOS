import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CareService, MemoryAdapter, MemoryNotifier, createSeed } from "open-caregiver-mcp";
import { createApp } from "../src/app.js";
import { singleTenant } from "../src/tenants.js";

let server: Server;
let base: string;
let notifier: MemoryNotifier;
let storage: MemoryAdapter;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  storage = new MemoryAdapter(createSeed(Date.now()));
  notifier = new MemoryNotifier();
  const service = new CareService(storage, { notifier });
  const { app } = createApp({ tenants: singleTenant(service), sseHeartbeatMs: 60 });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });
beforeEach(async () => { await fetch(`${base}/api/demo/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); });

interface Sse { event?: string; id?: string; data?: any }
/** Reads an SSE stream until `until` is satisfied (or the timeout aborts it). */
async function readSse(path: string, until: (events: Sse[], raw: string) => boolean, headers: Record<string, string> = {}, timeoutMs = 3000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const events: Sse[] = [];
  let raw = "";
  try {
    const res = await fetch(`${base}${path}`, { headers, signal: ac.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
      events.length = 0;
      for (const block of raw.split("\n\n")) {
        const ev: Sse = {};
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) ev.event = line.slice(7);
          else if (line.startsWith("id: ")) ev.id = line.slice(4);
          else if (line.startsWith("data: ")) ev.data = JSON.parse(line.slice(6));
        }
        if (ev.event) events.push(ev);
      }
      if (until(events, raw)) break;
    }
  } catch (e) {
    if (!(e instanceof Error && e.name === "AbortError")) throw e;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return { events, raw };
}

async function mcpClient() {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return c;
}
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("REST", () => {
  it("healthz; no CORS headers by default (same-origin web app)", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(await res.json()).toMatchObject({ ok: true, mcp: { transport: "streamable-http", stateless: true }, auth: "open-loopback" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("CORS preflight only when an origin is explicitly allowed", async () => {
    const service = new CareService(new MemoryAdapter(createSeed(Date.now())));
    const { app } = createApp({ tenants: singleTenant(service), allowedOrigin: "http://localhost:6274" });
    const s = app.listen(0);
    await new Promise((r) => s.once("listening", r));
    try {
      const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/state`;
      const pre = await fetch(url, { method: "OPTIONS" });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-origin")).toBe("http://localhost:6274");
      expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");
      expect(pre.headers.get("access-control-allow-headers")).not.toContain("mcp-session-id");
    } finally { s.closeAllConnections(); s.close(); }
  });

  it("GET /api/state returns patients, caregivers and inventory", async () => {
    const s = await (await fetch(`${base}/api/state`)).json();
    expect(s.patients.map((p: any) => p.profile.id).sort()).toEqual(["frank", "leo"]);
    expect(s.patients.find((p: any) => p.profile.id === "leo").profile.weight_kg).toBe(8.62);
    expect(s.caregivers.map((c: any) => c.name)).toContain("Sarah (Mom)");
    expect(s.inventory.find((i: any) => i.id === "infant_motrin_drops")).toBeTruthy();
  });

  it("demo reset can pre-load Mom's dose so Dad is locked out immediately", async () => {
    await post("/api/demo/reset", { sarah_dosed_minutes_ago: 32 });
    const s = await (await fetch(`${base}/api/state`)).json();
    const leo = s.patients.find((p: any) => p.profile.id === "leo");
    expect(leo.active_locks[0]).toMatchObject({ ingredient: "ibuprofen", status: "DOUBLE_DOSE_LOCKED" });
    const c = await mcpClient();
    const r = await c.callTool({ name: "confirm_dose_given", arguments: { patient_id: "infant_leo", product: "Motrin", caregiver_id: "Dad" } });
    expect(r.structuredContent).toMatchObject({ status: "REJECTED_LOCKED", card_type: "DOUBLE_DOSE_INTERCEPT", violation_type: "DOUBLE_DOSE_LOCKED" });
    await c.close();
  });

  it("/api/inspect exposes the stored ledger, audit trail, observations and remembered advice (read-only)", async () => {
    await post("/api/demo/reset", { sarah_dosed_minutes_ago: 20 });
    const c = await mcpClient();
    await c.callTool({ name: "plan_medication", arguments: { patient_id: "frank", product: "Advil" } });
    await c.close();
    const r = await (await fetch(`${base}/api/inspect`)).json();
    expect(r.backend).toBe("memory");
    expect(r.ledger[0]).toMatchObject({ patientId: "leo", caregiver: "Sarah (Mom)", volumeMl: 1.875, amountMg: 75 });
    expect(r.audit[0]).toMatchObject({ tool: "plan_medication", verdict: "ALTERNATE_SUGGESTED", reasonCodes: expect.arrayContaining(["SR-NSAID-ANTICOAGULANT"]) });
    expect(r.observations.some((o: any) => o.type === "weight" && o.patientId === "leo")).toBe(true);
    expect(r.advice[0]).toMatchObject({ drug: "naproxen", givenBy: "Dr. Rao" });
    expect((await fetch(`${base}/api/inspect`, { method: "POST" })).status).toBe(404); // read-only
  });

  it("rejects bad demo-reset input with 400", async () => {
    expect((await post("/api/demo/reset", { sarah_dosed_minutes_ago: -5 })).status).toBe(400);
  });

  it("exposes no override route: a lock cannot be bypassed over HTTP (PRD H7)", async () => {
    expect((await post("/api/override", { patient_id: "leo", ingredient: "ibuprofen", caregiver: "Dad", pin: "4242" })).status).toBe(404);
  });
});

describe("Trace stream", () => {
  it("replays classified frames for tool calls, including blocked ones", async () => {
    const c = await mcpClient();
    await c.callTool({ name: "plan_medication", arguments: { patient_id: "infant_leo", product: "Motrin", weight_value: 19, weight_unit: "lb", last_dose_elsewhere: "none_today" } });
    await c.callTool({ name: "plan_medication", arguments: { patient_id: "elder_frank", product: "advil" } });
    await c.close();

    const { events } = await readSse("/api/trace", (e) => e.filter((x) => x.data?.kind === "blocked").length >= 1);
    const frames = events.map((e) => e.data);
    const call = frames.find((f) => f.kind === "call" && f.tool === "plan_medication");
    expect(call.summary).toContain('"weight_value":19');
    const ok = frames.find((f) => f.kind === "result" && f.tool === "plan_medication");
    expect(ok.summary).toContain('"dispense_volume_ml":1.875');
    const blocked = frames.find((f) => f.kind === "blocked");
    expect(blocked).toMatchObject({ tool: "plan_medication", dir: "out" });
    expect(blocked.summary).toContain("DRUG_CONTRAINDICATION");
    expect(events.every((e) => e.id === String(e.data.id))).toBe(true);
  });

  it("streams frames live to an already-connected viewer", async () => {
    const watching = readSse("/api/trace", (e) => e.some((x) => x.data?.kind === "result" && x.data?.tool === "query_pantry_remedies"));
    await sleep(150);
    const c = await mcpClient();
    await c.callTool({ name: "query_pantry_remedies", arguments: { patient_id: "frank", symptom: "sore_throat" } });
    await c.close();
    const { events } = await watching;
    expect(events.some((x) => x.data.kind === "result" && x.data.tool === "query_pantry_remedies")).toBe(true);
  });

  it("resumes after Last-Event-ID without resending old frames", async () => {
    const c = await mcpClient();
    await c.callTool({ name: "query_pantry_remedies", arguments: { patient_id: "frank", symptom: "cough" } });
    // Cursor = last frame that exists before the second call (stop once the first call's result is in).
    const first = await readSse("/api/trace", (e) => e.some((x) => x.data?.kind === "result" && x.data?.tool === "query_pantry_remedies"));
    const lastId = first.events[first.events.length - 1]!.id!;
    await c.callTool({ name: "query_pantry_remedies", arguments: { patient_id: "frank", symptom: "nausea" } });
    await c.close();
    const { events } = await readSse("/api/trace", (e) => e.some((x) => x.data?.kind === "result" && x.data?.tool === "query_pantry_remedies"), { "last-event-id": lastId });
    const summaries = events.map((e) => e.data.summary as string);
    expect(summaries.some((s) => s.includes('"symptom":"nausea"'))).toBe(true); // new call is delivered
    expect(summaries.some((s) => s.includes('"symptom":"cough"'))).toBe(false); // old call is not resent
    expect(events.every((e) => Number(e.id) > Number(lastId))).toBe(true);
  });

  it("sends heartbeat comments on an idle stream", async () => {
    const { raw } = await readSse("/api/trace", (_e, r) => (r.match(/:ping/g) ?? []).length >= 2, {}, 2000);
    expect((raw.match(/:ping/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("reset clears the buffer", async () => {
    const c = await mcpClient();
    await c.callTool({ name: "query_pantry_remedies", arguments: { patient_id: "frank", symptom: "cough" } });
    await c.close();
    await post("/api/demo/reset", {});
    const { events } = await readSse("/api/trace", () => false, {}, 300);
    expect(events).toHaveLength(0);
  });
});
