import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CareService, MemoryAdapter, MemoryNotifier, createSeed } from "open-caregiver-mcp";
import { createApp } from "../src/app.js";
import type { LlmClient, LlmResponse } from "../src/orchestrator/llm.js";
import { Orchestrator } from "../src/orchestrator/index.js";
import { McpToolClient } from "../src/orchestrator/mcpClient.js";
import { MockLlm } from "../src/orchestrator/mock.js";

let server: Server;
let base: string;
let notifier: MemoryNotifier;
let orchestrator: Orchestrator;
let mcp: McpToolClient;

beforeAll(async () => {
  const storage = new MemoryAdapter(createSeed(Date.now()));
  notifier = new MemoryNotifier();
  const service = new CareService(storage, { notifier, overridePin: "4242" });
  mcp = new McpToolClient();
  orchestrator = new Orchestrator({ llm: new MockLlm(), runner: mcp });
  const { app } = createApp({ service, storage, orchestrator, sseHeartbeatMs: 60 });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await mcp.connect(new URL(`${base}/mcp`));
  await orchestrator.init();
});
afterAll(async () => { await mcp.close(); server.closeAllConnections(); server.close(); });

const json = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const reset = (sarahDosedMinutesAgo?: number) => json("/api/demo/reset", sarahDosedMinutesAgo === undefined ? {} : { sarah_dosed_minutes_ago: sarahDosedMinutesAgo });
let n = 0;

interface Ev { seq: number; type: string; data: any }

/** Runs a turn end to end through the cursor long-poll (plain request/response, no streaming). */
async function say(transcript: string, o: { session?: string; profile?: string; caregiver?: string } = {}) {
  const res = await json("/api/converse", { session_id: o.session ?? `s${++n}`, active_profile: o.profile ?? "leo", caregiver: o.caregiver ?? "Sarah (Mom)", transcript });
  expect(res.status).toBe(202);
  const { turn_id } = await res.json();
  const events: Ev[] = [];
  let after = 0;
  for (let i = 0; i < 20; i++) {
    const page = await (await fetch(`${base}/api/turns/${turn_id}/events?after=${after}&wait=5`)).json();
    events.push(...page.events);
    after = page.next;
    if (page.done) break;
  }
  const by = (t: string) => events.filter((e) => e.type === t);
  return { turn_id, events, cards: by("card").map((e) => e.data), alerts: by("alert").map((e) => e.data), reply: String(by("assistant_delta").at(-1)?.data.text ?? ""), done: events.at(-1)?.type === "done" };
}

beforeEach(async () => { await reset(); notifier.sent.length = 0; });

describe("demo flows (mock model, real MCP hop)", () => {
  it("exposes the model-safe tool set only", () => {
    expect(orchestrator.toolNames.sort()).toEqual([
      "calculate_pediatric_dose", "confirm_amazon_order", "log_administration_event",
      "query_pantry_remedies", "stage_amazon_cart", "verify_medication_safety",
    ]);
  });

  it("1. Leo 19 lb fever -> syringe card, 2 mL / 80 mg, spoken verbatim, no guardrail trip", async () => {
    const t = await say("Leo is 19 pounds and has a fever, how much Motrin?");
    expect(t.done).toBe(true);
    expect(t.cards).toHaveLength(1);
    expect(t.cards[0]).toMatchObject({ card_type: "SYRINGE_CALIBRATOR", tool: "calculate_pediatric_dose" });
    expect(t.cards[0].payload).toMatchObject({ status: "APPROVED", dispense_volume_ml: 2, delivered_dose_mg: 80 });
    expect(t.reply).toMatch(/2 mL/);
    expect(t.reply).toMatch(/80 mg/);
    expect(t.alerts.find((a) => a.kind === "GUARDRAIL_REPLACED")).toBeUndefined();
  });

  it("2. Dad logs a dose 32 min after Sarah -> intercept card, SMS-style alert, nothing recorded", async () => {
    await reset(32);
    const t = await say("I gave Leo 2 mL of Motrin", { caregiver: "Dad" });
    expect(t.cards[0]).toMatchObject({ card_type: "DOUBLE_DOSE_INTERCEPT" });
    expect(t.cards[0].payload.last_dose).toMatchObject({ caregiver: "Sarah (Mom)", minutes_ago: 32 });
    expect(t.alerts.some((a) => a.kind === "BLOCKED" && a.violation_type === "DOUBLE_DOSE_LOCKED")).toBe(true);
    expect(t.reply).toMatch(/Sarah \(Mom\) gave/);
    expect(notifier.sent.some((s) => s.kind === "LOCKOUT_ATTEMPT")).toBe(true);
    expect(notifier.sent.some((s) => s.kind === "DOSE_LOGGED")).toBe(false);
  });

  it("3. 'Can Frank take Advil?' -> contraindication shield with the Tylenol alternative", async () => {
    const t = await say("Can Frank take Advil?", { profile: "frank" });
    expect(t.cards[0]).toMatchObject({ card_type: "CONTRAINDICATION_SHIELD" });
    expect(t.cards[0].payload).toMatchObject({ status: "BLOCKED", violation_type: "DRUG_CONTRAINDICATION" });
    expect(t.reply).toMatch(/Blocked/);
    expect(t.reply.toLowerCase()).toMatch(/acetaminophen|tylenol/);
  });

  it("4. Sore throat -> pantry card; honey is capped for Frank and excluded for Leo", async () => {
    const frank = await say("Frank has a sore throat", { profile: "frank" });
    expect(frank.cards[0]).toMatchObject({ card_type: "PANTRY_REMEDY" });
    expect(frank.reply).toMatch(/1\/2 tsp honey/);

    const leo = await say("Leo has a cough", { profile: "leo" });
    expect(JSON.stringify(leo.cards[0]?.payload ?? leo.reply)).not.toMatch(/1 tsp honey/);
  });

  it("5. Low bottle after a dose -> restock carousel -> confirm in the same session", async () => {
    const s = `restock-${++n}`;
    const logged = await say("I gave Leo 2 mL of Motrin", { session: s });
    expect(logged.cards).toHaveLength(0);
    expect(logged.reply).toMatch(/Logged/);
    expect(logged.reply).toMatch(/running low/);
    expect(notifier.sent.some((x) => x.kind === "DOSE_LOGGED")).toBe(true);

    const staged = await say("restock the Motrin", { session: s });
    expect(staged.cards[0]).toMatchObject({ card_type: "AMAZON_RESTOCK_CAROUSEL" });
    expect(staged.cards[0].payload).toMatchObject({ status: "STAGED", confirm_label: "Confirm restock order" });

    const placed = await say("confirm the order", { session: s });
    expect(placed.reply).toMatch(/Order placed \(simulated\)/);
  });

  it("confirming with nothing staged does not place an order", async () => {
    const t = await say("confirm order");
    expect(t.cards).toHaveLength(0);
    expect(t.reply).toMatch(/no restock waiting/i);
  });

  it("asks for a weight instead of guessing", async () => {
    const t = await say("how much Motrin should he get for his fever");
    expect(t.cards).toHaveLength(0);
    expect(t.reply).toMatch(/weigh/i);
  });
});

describe("transports and validation", () => {
  it("SSE stream delivers the same events with ids, ends at done, and resumes after Last-Event-ID", async () => {
    const start = await json("/api/converse", { session_id: `sse-${++n}`, active_profile: "leo", caregiver: "Sarah (Mom)", transcript: "Leo is 19 lbs with a fever" });
    const { turn_id } = await start.json();

    const readAll = async (headers: Record<string, string> = {}) => {
      const res = await fetch(`${base}/api/turns/${turn_id}/stream`, { headers });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const raw = await res.text(); // the server closes the stream after `done`
      return [...raw.matchAll(/id: (\d+)\nevent: (\w+)\n/g)].map((m) => ({ id: Number(m[1]), type: m[2]! }));
    };
    const all = await readAll();
    expect(all.map((e) => e.type)).toEqual(["tool_call", "tool_result", "card", "assistant_delta", "done"]);
    expect(all.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);

    const resumed = await readAll({ "last-event-id": String(all.length - 2) });
    expect(resumed.map((e) => e.type)).toEqual(["assistant_delta", "done"]);
  });

  it("long-poll waits for a slow turn instead of returning empty", async () => {
    const slow: LlmClient = {
      complete: async (): Promise<LlmResponse> => { await new Promise((r) => setTimeout(r, 150)); return { content: [{ type: "text", text: "hello" }], stopReason: "end_turn" }; },
    };
    const o = new Orchestrator({ llm: slow, runner: mcp });
    await o.init();
    const { app } = createApp({ service: new CareService(new MemoryAdapter(createSeed(Date.now()))), storage: new MemoryAdapter(createSeed(Date.now())), orchestrator: o });
    const s = app.listen(0);
    await new Promise((r) => s.once("listening", r));
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    try {
      const body = { session_id: "x", active_profile: "leo", caregiver: "Dad", transcript: "hi" };
      const post = () => fetch(`${b}/api/converse`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const first = await post();
      const { turn_id } = await first.json();
      expect((await post()).status).toBe(409); // one turn per session at a time

      const t0 = Date.now();
      const page = await (await fetch(`${b}/api/turns/${turn_id}/events?after=0&wait=5`)).json();
      expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
      expect(page.events.length).toBeGreaterThan(0);
    } finally { s.closeAllConnections(); s.close(); }
  });

  it("validates input and unknown turns", async () => {
    expect((await json("/api/converse", { session_id: "a", active_profile: "leo", caregiver: "x", transcript: "   " })).status).toBe(400);
    expect((await json("/api/converse", { session_id: "a" })).status).toBe(400);
    expect((await fetch(`${base}/api/turns/nope/events`)).status).toBe(404);
    expect((await fetch(`${base}/api/turns/nope/stream`)).status).toBe(404);
  });

  it("returns 503 when no orchestrator is configured", async () => {
    const svc = new CareService(new MemoryAdapter(createSeed(Date.now())));
    const { app } = createApp({ service: svc, storage: svc.storage });
    const s = app.listen(0);
    await new Promise((r) => s.once("listening", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/converse`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: "a", active_profile: "leo", caregiver: "x", transcript: "hi" }) });
      expect(res.status).toBe(503);
    } finally { s.closeAllConnections(); s.close(); }
  });

  it("the model can never reach override_lockout, even by name", async () => {
    // The tool list offered to the model excludes it, so a hallucinated call would be rejected by the API;
    // here we assert the offered surface and that the PIN path stays on /api/override.
    expect(orchestrator.toolNames).not.toContain("override_lockout");
    await reset(32);
    const res = await json("/api/override", { patient_id: "leo", ingredient: "ibuprofen", caregiver: "Dad", pin: "4242" });
    expect((await res.json()).status).toBe("OVERRIDE_GRANTED");
  });
});
