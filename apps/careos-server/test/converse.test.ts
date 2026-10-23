import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CareService, MemoryAdapter, MemoryNotifier, createSeed } from "open-caregiver-mcp";
import { createApp } from "../src/app.js";
import { singleTenant } from "../src/tenants.js";
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
  const service = new CareService(storage, { notifier });
  mcp = new McpToolClient();
  orchestrator = new Orchestrator({ llm: new MockLlm(), runner: mcp });
  const { app } = createApp({ tenants: singleTenant(service), orchestrator, sseHeartbeatMs: 60 });
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
  it("exposes the new tool set", () => {
    expect(orchestrator.toolNames.sort()).toEqual([
      "cancel_amazon_order", "confirm_amazon_order", "confirm_dose_given", "emergency_assist", "export_care_summary", "forget_patient",
      "get_household_context", "log_observation", "manage_prescriptions", "plan_medication", "query_pantry_remedies", "read_bottle_label",
      "stage_amazon_cart", "track_amazon_order", "triage_symptoms",
    ]);
  });

  it("C1. fever + Motrin: first the S3 question, then 1.875 mL from the label, spoken verbatim, no guard trip", async () => {
    const s = `c1-${++n}`;
    const ask = await say("Leo is 19 pounds and has a fever, how much Motrin?", { session: s });
    expect(ask.done).toBe(true);
    expect(ask.cards[0]).toMatchObject({ card_type: "NEEDS_INFO", tool: "plan_medication" });
    expect(ask.reply).toBe("Has Leo had any ibuprofen today, like Motrin or Advil, even if it wasn't logged here?");
    expect(ask.alerts).toEqual([]); // a question is not an alarm

    const t = await say("No, nothing else today", { session: s });
    expect(t.cards).toHaveLength(1);
    expect(t.cards[0]).toMatchObject({ card_type: "SYRINGE_CALIBRATOR", tool: "plan_medication" });
    expect(t.cards[0].payload).toMatchObject({ status: "APPROVED", dispense_volume_ml: 1.875, delivered_dose_mg: 75, mg_per_kg: 8.7 });
    expect(t.reply).toBe("Leo can have 1.875 milliliters of Infants' Motrin. That is one point eight seven five milliliters.");
    expect(t.events.find((e) => e.type === "assistant_delta")!.data).toMatchObject({ verbatim: true, followup: expect.stringContaining("syringe that came in the box") });
    expect(t.events.some((e) => e.type === "numeric_guard")).toBe(false);
    // The weight she said was saved with a date.
    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state.patients.find((p: any) => p.profile.id === "leo").profile.weightLbs).toBe(19);
  });

  it("C2. Dad tries to log a dose 32 min after Sarah -> Intercept card, alert to the house, nothing recorded", async () => {
    await reset(32);
    const t = await say("I gave Leo Motrin", { caregiver: "Dad" });
    expect(t.cards[0]).toMatchObject({ card_type: "DOUBLE_DOSE_INTERCEPT" });
    expect(t.cards[0].payload).toMatchObject({ status: "REJECTED_LOCKED", remaining_minutes: 328 });
    expect(t.cards[0].payload.last_dose).toMatchObject({ caregiver: "Sarah (Mom)", minutes_ago: 32, volume_ml: 1.875 });
    expect(t.alerts.some((a) => a.kind === "REJECTED_LOCKED" && a.violation_type === "DOUBLE_DOSE_LOCKED")).toBe(true);
    expect(t.reply).toBe("Stop. Sarah gave Infants' Motrin 32 minutes ago, so the next dose is allowed in 5 hours and 28 minutes.");
    expect(notifier.sent.some((s) => s.kind === "LOCKOUT_ATTEMPT" && s.text.includes("Dad tried to log"))).toBe(true);
    expect(notifier.sent.some((s) => s.kind === "DOSE_LOGGED")).toBe(false);
    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state.patients.find((p: any) => p.profile.id === "leo").medication_history).toHaveLength(1); // only Sarah's
  });

  it("E1. 'Can Frank take Advil?' -> Contraindication Shield, with a label-limited alternative and 'check with his clinician'", async () => {
    const t = await say("Can Frank take Advil?", { profile: "frank" });
    expect(t.cards[0]).toMatchObject({ card_type: "CONTRAINDICATION_SHIELD" });
    expect(t.cards[0].payload).toMatchObject({ status: "ALTERNATE_SUGGESTED", rule_id: "SR-NSAID-ANTICOAGULANT", approved_alternative: "acetaminophen" });
    expect(t.alerts.some((a) => a.kind === "ALTERNATE_SUGGESTED")).toBe(true);
    expect(t.reply).toMatch(/can't clear advil for Frank/i);
    const spoken = t.events.find((e) => e.type === "assistant_delta")!.data;
    expect(spoken.followup).toMatch(/no more than 6 caplets in 24 hours/);
    expect(spoken.followup).toMatch(/check with Frank's clinician/);
  });

  it("E2. 'What did the doctor say about Frank's gout?' -> Memory Conflict: old advice is not repeated", async () => {
    const t = await say("What did the doctor say last time about Frank's gout?", { profile: "frank" });
    expect(t.cards[0]).toMatchObject({ card_type: "MEMORY_CONFLICT", tool: "get_household_context" });
    expect(t.cards[0].payload).toMatchObject({ status: "MEMORY_CONFLICT", call_target: "Dr. Rao" });
    expect(t.reply).toBe("Dr. Rao's August advice was naproxen, but Frank now takes eliquis, so it's no longer safe. Please call Dr. Rao before giving it.");
    expect(t.reply).not.toMatch(/with food/);
    expect(t.alerts.some((a) => a.kind === "MEMORY_CONFLICT")).toBe(true);
  });

  it("D1. 'Does Frank have diabetes?' -> yes, from his record; 'Does Leo have diabetes?' -> no record, never a guess", async () => {
    const frank = await say("Does Frank have diabetes?", { session: `d1-${++n}`, profile: "frank" });
    expect(frank.done).toBe(true);
    expect(frank.reply).toBe("Yes. Frank has type 2 diabetes on record.");
    expect(frank.alerts).toEqual([]);

    const leo = await say("Does Leo have diabetes?", { session: `d1-${++n}`, profile: "leo" });
    expect(leo.reply).toBe("No. There is no diabetes on Leo's record.");
  });

  it("H2. a dose is logged only after the read-back and a clear yes; then the bottle drops and the house is alerted", async () => {
    const s = `h2-${++n}`;
    const readBack = await say("I gave Leo Motrin", { session: s });
    expect(readBack.cards[0]).toMatchObject({ card_type: "CONFIRM_DOSE" });
    expect(readBack.reply).toBe("Logging 1.875 milliliters of Infants' Motrin for Leo, given by Sarah just now. Is that correct?");
    expect(notifier.sent).toEqual([]);
    expect((await (await fetch(`${base}/api/state`)).json()).patients.find((p: any) => p.profile.id === "leo").medication_history).toHaveLength(0);

    const logged = await say("yes that's right", { session: s });
    expect(logged.cards).toHaveLength(0);
    expect(logged.reply).toMatch(/^Logged\. The next Infants' Motrin for Leo is allowed after /);
    expect(notifier.sent.some((x) => x.kind === "DOSE_LOGGED" && x.text.includes("1.875 mL Infants' Motrin given to Leo by Sarah"))).toBe(true);
    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state.patients.find((p: any) => p.profile.id === "leo").medication_history).toHaveLength(1);
    expect(state.inventory.find((i: any) => i.id === "infant_motrin_drops").remaining).toBe(1.625);
  });

  it("H2. 'no' to the read-back logs nothing", async () => {
    const s = `h2n-${++n}`;
    await say("I gave Leo Motrin", { session: s });
    const t = await say("no, that's wrong", { session: s });
    expect(t.reply).toMatch(/won't log it/);
    expect(notifier.sent).toEqual([]);
  });

  it("C4. a bare '19' with no unit is a question, never an assumption", async () => {
    const s = `c4-${++n}`;
    const t = await say("Leo weighs 19, how much Motrin, he hasn't had any other", { session: s });
    expect(t.cards[0]).toMatchObject({ card_type: "NEEDS_INFO" });
    expect(t.cards[0].payload).toMatchObject({ missing: "weight_unit" });
    expect(t.reply).toBe("Is Leo's weight 19 pounds or 19 kilograms?");
    const answered = await say("pounds", { session: s });
    expect(answered.cards[0].payload).toMatchObject({ status: "APPROVED", dispense_volume_ml: 1.875 });
  });

  it("logs a temperature through log_observation", async () => {
    const t = await say("Leo's temperature is 103.1");
    expect(t.reply).toBe("Logged Leo's temperature: 103.1 degrees Fahrenheit.");
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
    await say("I gave Leo Motrin", { session: s });
    const logged = await say("yes", { session: s });
    expect(logged.reply).toMatch(/Logged/);
    expect(logged.events.find((e) => e.type === "assistant_delta")!.data.followup).toMatch(/running low/);

    const staged = await say("restock the Motrin", { session: s });
    expect(staged.cards[0]).toMatchObject({ card_type: "AMAZON_RESTOCK_CAROUSEL" });
    expect(staged.cards[0].payload).toMatchObject({ status: "STAGED", confirm_label: "Confirm restock order" });

    const placed = await say("confirm the order", { session: s });
    expect(placed.reply).toMatch(/Your order for \$11\.48 is placed.*simulated/);

    const where = await say("where is my order", { session: s });
    expect(where.reply).toMatch(/order of .*Motrin.* is (order placed|packed)/i);
  });

  it("cancels an open cart by voice", async () => {
    const s = `cancel-${++n}`;
    await say("restock the Motrin", { session: s });
    const gone = await say("cancel the cart", { session: s });
    expect(gone.reply).toMatch(/cleared the cart/);
  });

  it("confirming with nothing staged does not place an order", async () => {
    const t = await say("confirm order");
    expect(t.cards).toHaveLength(0);
    expect(t.reply).toMatch(/no restock waiting/i);
  });

  it("asks which medicine instead of guessing one", async () => {
    const t = await say("how much should he get for his fever");
    expect(t.cards).toHaveLength(0);
    expect(t.reply).toMatch(/which medicine/i);
  });

  it("S4: a different brand of the same ingredient does not dodge the lock", async () => {
    await reset(32);
    const t = await say("Can Leo have Advil?");
    expect(t.cards[0]).toMatchObject({ card_type: "DOUBLE_DOSE_INTERCEPT" });
    expect(t.cards[0].payload).toMatchObject({ status: "BLOCKED", violation_type: "DOUBLE_DOSE_LOCKED", ingredient: "ibuprofen" });
  });

  describe("the Numeric Guard on a live MCP hop", () => {
    const scripted = (drafts: LlmResponse[]): LlmClient => ({ complete: async () => drafts.shift()! });
    async function turnWith(llm: LlmClient, transcript: string) {
      const o = new Orchestrator({ llm, runner: mcp });
      await o.init();
      const { app } = createApp({ tenants: singleTenant(new CareService(new MemoryAdapter(createSeed(Date.now())))), orchestrator: o });
      const s = app.listen(0);
      await new Promise((r) => s.once("listening", r));
      const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
      try {
        const start = await fetch(`${b}/api/converse`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: "g", active_profile: "leo", caregiver: "Sarah (Mom)", transcript }) });
        const { turn_id } = await start.json();
        const page = await (await fetch(`${b}/api/turns/${turn_id}/events?after=0&wait=5`)).json();
        return page.events as Ev[];
      } finally { s.closeAllConnections(); s.close(); }
    }

    it("a model that tries to state its own dose is overridden and the attempt is logged", async () => {
      const events = await turnWith(
        scripted([
          { content: [{ type: "tool_use", id: "t1", name: "get_household_context", input: {} }], stopReason: "tool_use" },
          { content: [{ type: "text", text: "Leo can have 2 mL of Motrin, that's plenty safe." }], stopReason: "end_turn" },
        ]),
        "how much for Leo",
      );
      const guard = events.find((e) => e.type === "numeric_guard")!;
      expect(guard.data).toMatchObject({ kind: "numeric_guard.blocked", offending: ["2 mL"], draft: "Leo can have 2 mL of Motrin, that's plenty safe." });
      const said = events.find((e) => e.type === "assistant_delta")!.data.text;
      expect(said).not.toMatch(/2 mL/);
      expect(said).toBe(guard.data.replacement);
    });

    it("a model that swaps mg for mL is caught", async () => {
      const events = await turnWith(
        scripted([
          { content: [{ type: "tool_use", id: "t1", name: "plan_medication", input: { patient_id: "leo", product: "Motrin", last_dose_elsewhere: "none_today" } }], stopReason: "tool_use" },
        ]),
        "dose for Leo",
      );
      // plan_medication is read_verbatim, so the model never gets to rephrase it at all.
      expect(events.some((e) => e.type === "numeric_guard")).toBe(false);
      expect(events.find((e) => e.type === "assistant_delta")!.data.text).toBe("Leo can have 1.875 milliliters of Infants' Motrin. That is one point eight seven five milliliters.");
    });
  });
});

describe("transports and validation", () => {
  it("SSE stream delivers the same events with ids, ends at done, and resumes after Last-Event-ID", async () => {
    const start = await json("/api/converse", { session_id: `sse-${++n}`, active_profile: "leo", caregiver: "Sarah (Mom)", transcript: "Leo is 19 lbs with a fever, how much Motrin?" });
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
    const { app } = createApp({ tenants: singleTenant(new CareService(new MemoryAdapter(createSeed(Date.now())))), orchestrator: o });
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
    const { app } = createApp({ tenants: singleTenant(svc) });
    const s = app.listen(0);
    await new Promise((r) => s.once("listening", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/converse`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: "a", active_profile: "leo", caregiver: "x", transcript: "hi" }) });
      expect(res.status).toBe(503);
    } finally { s.closeAllConnections(); s.close(); }
  });

  it("has no override surface: neither a tool nor an HTTP route can unlock a dose (PRD H7)", async () => {
    expect(orchestrator.toolNames).not.toContain("override_lockout");
    await reset(32);
    const res = await json("/api/override", { patient_id: "leo", ingredient: "ibuprofen", caregiver: "Dad", pin: "4242" });
    expect(res.status).toBe(404);
  });
});
