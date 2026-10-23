import { describe, expect, it } from "vitest";
import { BedrockLlm } from "../src/orchestrator/bedrock.js";
import { FAIL_CLOSED_MESSAGE } from "open-caregiver-mcp";
import { allowedAmounts, amountsIn, guardReply, kindOf, latestSpeech, SAFE_FALLBACK, unbackedAmounts, wordsToNumber } from "../src/orchestrator/guardrail.js";
import type { LlmClient, LlmMessage, LlmRequest, LlmResponse } from "../src/orchestrator/llm.js";
import { runTurn, trimHistory, type TurnEventType } from "../src/orchestrator/loop.js";
import type { ToolOutcome, ToolRunner } from "../src/orchestrator/mcpClient.js";
import { sanitizeSchema, toLlmTools } from "../src/orchestrator/toolBridge.js";
import { TurnStore } from "../src/orchestrator/turns.js";

describe("toolBridge.sanitizeSchema", () => {
  it("inlines $ref/$defs, flattens literal unions to enum and closes objects", () => {
    const out = sanitizeSchema({
      type: "object",
      properties: {
        unit: { $ref: "#/$defs/Unit" },
        channel: { anyOf: [{ const: "prime" }, { const: "fresh" }] },
        items: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } },
      },
      $defs: { Unit: { type: "string", enum: ["lbs", "kg"] } },
      $schema: "http://json-schema.org/draft-07/schema#",
    });
    expect(out.$defs).toBeUndefined();
    expect(out.$schema).toBeUndefined();
    expect(out.additionalProperties).toBe(false);
    expect(out.properties.unit).toEqual({ type: "string", enum: ["lbs", "kg"] });
    expect(out.properties.channel).toEqual({ type: "string", enum: ["prime", "fresh"] });
    expect(out.properties.items.items.additionalProperties).toBe(false);
  });

  it("fails loudly on a union it cannot express and on cyclic refs", () => {
    expect(() => sanitizeSchema({ type: "object", properties: { a: { anyOf: [{ type: "string" }, { type: "number" }] } } })).toThrow(/anyOf/);
    expect(() => sanitizeSchema({ $ref: "#/$defs/A", $defs: { A: { type: "object", properties: { a: { $ref: "#/$defs/A" } } } } })).toThrow(/\$ref/);
  });

  it("offers every server tool to the model", () => {
    const tools = toLlmTools([
      { name: "plan_medication", inputSchema: { type: "object", properties: {} } },
      { name: "confirm_dose_given", inputSchema: { type: "object", properties: {} } },
    ]);
    expect(tools.map((t) => t.name)).toEqual(["plan_medication", "confirm_dose_given"]);
  });
});

describe("guardrail (Numeric Guard, PRD §4.4)", () => {
  const results = [{ status: "APPROVED", dispense_volume_ml: 1.875, delivered_dose_mg: 75, formulation_label: "Infants' Motrin 50 mg / 1.25 mL", lockout_hours: 6, remaining_minutes: 342, speech: "Stop. Sarah gave it 18 minutes ago, so the next dose is allowed in 5 hours and 42 minutes.", read_verbatim: true }];

  it("collects what the tool results back, by kind of unit: from field names and from amounts written inside speech", () => {
    const a = allowedAmounts(results);
    expect(a.volume).toEqual(expect.arrayContaining([1.875, 1.25]));
    expect(a.mass).toEqual(expect.arrayContaining([75, 50]));
    expect(a.time).toEqual(expect.arrayContaining([6, 342, 18, 5, 42, 360]));
    expect(a.volume).not.toContain(75);
    expect(a.mass).not.toContain(1.875);
  });

  it("allows amounts that a tool returned, regardless of formatting", () => {
    expect(unbackedAmounts("Give 1.875 mL (75 mg).", results)).toEqual([]);
    expect(unbackedAmounts("Give 1.875 milliliters.", results)).toEqual([]);
    expect(unbackedAmounts("Wait 18 minutes, about 6 hours in all.", results)).toEqual([]);
  });

  it("replaces a reply that states an amount no tool returned", () => {
    const g = guardReply("Give 3 mL to be safe.", [{ dispense_volume_ml: 1.875 }]);
    expect(g).toMatchObject({ replaced: true, text: SAFE_FALLBACK, offending: ["3 mL"], draft: "Give 3 mL to be safe." });
  });

  it("polices every unit, not just mg and mL: time, temperature, weight and counts", () => {
    for (const bad of ["Wait 3 hours.", "Give it in 20 minutes.", "He has a 104 degrees fever.", "His fever is 104 °F.", "Give 2 caplets.", "At 30 pounds that is fine.", "Use 4 mg.", "Give 2 tsp."]) {
      expect(guardReply(bad, [{ status: "OK" }]).replaced, bad).toBe(true);
    }
  });

  it("polices spelled-out numbers too, so 'two milliliters' cannot sneak past", () => {
    expect(guardReply("Give two milliliters.", [{ dispense_volume_ml: 1.875 }])).toMatchObject({ replaced: true, offending: ["two milliliters"] });
    expect(guardReply("Give one point eight seven five milliliters.", [{ dispense_volume_ml: 1.875 }]).replaced).toBe(false);
    expect(guardReply("Wait five hours and forty two minutes.", results).replaced).toBe(false);
    expect(guardReply("Wait six hours and fifty minutes.", results)).toMatchObject({ replaced: true }); // 50 exists, but as milligrams
  });

  it("is unit-aware: the mg/mL mix-up is caught even though the number exists in the results", () => {
    const r = [{ delivered_dose_mg: 75, dispense_volume_ml: 1.875 }];
    expect(guardReply("Give 75 mL.", r)).toMatchObject({ replaced: true, offending: ["75 mL"] });
    expect(guardReply("Give 1.875 mg.", r)).toMatchObject({ replaced: true, offending: ["1.875 mg"] });
    expect(guardReply("Give 75 mg.", r).replaced).toBe(false);
    expect(guardReply("Give 1.875 mL.", r).replaced).toBe(false);
    expect(guardReply("Wait 75 minutes.", r).replaced).toBe(true);
    expect(guardReply("He weighs 75 pounds.", r).replaced).toBe(true);
  });

  it("allows whole-number time conversions of what a tool said (360 minutes is 6 hours)", () => {
    expect(guardReply("It unlocks in 6 hours.", [{ remaining_minutes: 360 }]).replaced).toBe(false);
    expect(guardReply("It unlocks in 360 minutes.", [{ lockout_hours: 6 }]).replaced).toBe(false);
    expect(guardReply("It unlocks in 5 hours.", [{ remaining_minutes: 342 }]).replaced).toBe(true); // 5.7 hours is not 5
  });

  it("classifies units", () => {
    expect([kindOf("mL"), kindOf("milligrams"), kindOf("hours"), kindOf("pounds"), kindOf("caplets"), kindOf("degrees"), kindOf("°F")]).toEqual(["volume", "mass", "time", "weight", "count", "temperature", "temperature"]);
  });

  it("does not police numbers that carry no unit", () => {
    expect(guardReply("Call 911 if it gets worse. Option 2 is on the screen.", [])).toMatchObject({ replaced: false });
  });

  it("with no tool results, any dose or time with a unit is unbacked", () => {
    expect(guardReply("Give 5 mL.", []).replaced).toBe(true);
    expect(guardReply("Wait 45 minutes.", []).replaced).toBe(true);
  });

  it("when a draft is replaced and a tool had verbatim speech, THAT speech is what gets said", () => {
    const g = guardReply("Give 3 mL.", results);
    expect(g.text).toBe(results[0]!.speech);
    expect(latestSpeech(results)).toBe(results[0]!.speech);
    expect(latestSpeech([{ speech: "x" }])).toBeUndefined(); // only read_verbatim speech counts
  });

  it("parses number words", () => {
    expect(wordsToNumber(["one", "point", "eight", "seven", "five"])).toBe(1.875);
    expect(wordsToNumber(["twenty-five"])).toBe(25);
    expect(wordsToNumber(["one", "hundred", "and", "five"])).toBe(105);
    expect(wordsToNumber(["three", "thousand"])).toBe(3000);
    expect(wordsToNumber(["point"])).toBeUndefined();
    expect(wordsToNumber(["milk"])).toBeUndefined();
    expect(amountsIn("two caplets and 1000 milligrams").map((x) => x.value)).toEqual([1000, 2]);
  });
});

// ------------------------------------------------------------------ loop
class Scripted implements LlmClient {
  calls: LlmRequest[] = [];
  constructor(private script: LlmResponse[]) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push({ ...req, messages: [...req.messages] });
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    return next;
  }
}
const runner = (fn: (name: string, args: Record<string, unknown>) => ToolOutcome | Promise<ToolOutcome>): ToolRunner => ({
  listTools: async () => [],
  callTool: async (n, a) => fn(n, a),
});
const ctx = { turnId: "t1", activeProfile: "leo", caregiver: "Sarah", nowIso: "2026-10-16T00:00:00Z" };
const text = (t: string): LlmResponse => ({ content: [{ type: "text", text: t }], stopReason: "end_turn" });
const tool = (id: string, name: string, input = {}): LlmResponse["content"][number] => ({ type: "tool_use", id, name, input });
const outcome = (payload: Record<string, unknown>, isError = false): ToolOutcome => ({ text: JSON.stringify(payload), payload, isError });

function collect() {
  const events: Array<{ type: TurnEventType; data: any }> = [];
  return { events, emit: (type: TurnEventType, data: unknown) => events.push({ type, data }) };
}
const base = { tools: [], system: "s", context: ctx };

describe("runTurn", () => {
  it("runs tools, emits the card before the reply, and ends with exactly one done", async () => {
    const { events, emit } = collect();
    const llm = new Scripted([
      { content: [tool("a", "plan_medication")], stopReason: "tool_use" },
      text("Give 2 mL."),
    ]);
    const hist = await runTurn({
      ...base, llm, emit, history: [], transcript: "dose please",
      runner: runner(() => outcome({ status: "APPROVED", dispense_volume_ml: 2, card_type: "SYRINGE_CALIBRATOR" })),
    });
    const types = events.map((e) => e.type);
    expect(types).toEqual(["tool_call", "tool_result", "card", "assistant_delta", "done"]);
    expect(events.find((e) => e.type === "card")!.data.card_type).toBe("SYRINGE_CALIBRATOR");
    expect(hist).toHaveLength(4); // user, assistant(tool_use), user(tool_result), assistant(text)
    // The tool result was fed back to the model.
    const second = llm.calls[1]!.messages.at(-1)!;
    expect(Array.isArray(second.content) && second.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "a" });
  });

  it("runs parallel tool calls and returns all results in one user message", async () => {
    const { emit } = collect();
    const llm = new Scripted([{ content: [tool("a", "x"), tool("b", "y")], stopReason: "tool_use" }, text("ok")]);
    const hist = await runTurn({ ...base, llm, emit, history: [], transcript: "t", runner: runner((n) => outcome({ status: "OK", n })) });
    const results = hist[2]!.content as Array<{ tool_use_id: string }>;
    expect(results.map((r) => r.tool_use_id)).toEqual(["a", "b"]);
  });

  it("replaces an unbacked dose, alerts, and keeps the bad number out of history", async () => {
    const { events, emit } = collect();
    const llm = new Scripted([text("Give 7 mL.")]);
    const hist = await runTurn({ ...base, llm, emit, history: [], transcript: "t", runner: runner(() => outcome({})) });
    expect(events.find((e) => e.type === "assistant_delta")!.data.text).toBe(SAFE_FALLBACK);
    expect(events.some((e) => e.type === "alert" && e.data.kind === "GUARDRAIL_REPLACED")).toBe(true);
    expect(JSON.stringify(hist.at(-1))).not.toContain("7 mL");
  });

  it("raises an alert for blocking statuses", async () => {
    const { events, emit } = collect();
    const llm = new Scripted([{ content: [tool("a", "plan_medication")], stopReason: "tool_use" }, text("Blocked.")]);
    await runTurn({ ...base, llm, emit, history: [], transcript: "t", runner: runner(() => outcome({ status: "BLOCKED", violation_type: "DOUBLE_DOSE_LOCKED", card_type: "DOUBLE_DOSE_INTERCEPT" })) });
    expect(events.find((e) => e.type === "alert")!.data).toMatchObject({ kind: "BLOCKED", violation_type: "DOUBLE_DOSE_LOCKED" });
  });

  it("S2: a throwing tool fails closed. The model is not asked to improvise, and the detail never reaches it", async () => {
    const { events, emit } = collect();
    const llm = new Scripted([{ content: [tool("a", "plan_medication")], stopReason: "tool_use" }, text("Probably about 5 mL is fine.")]);
    const hist = await runTurn({ ...base, llm, emit, history: [], transcript: "t", runner: runner(() => { throw new Error("boom: db.internal:5432"); }) });
    expect(llm.calls).toHaveLength(1); // no second model call
    expect(events.find((e) => e.type === "assistant_delta")!.data.text).toBe(FAIL_CLOSED_MESSAGE);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    expect(JSON.stringify(hist)).not.toMatch(/boom|5432/);
  });

  it("S2: a tool that reports isError fails closed the same way", async () => {
    const { events, emit } = collect();
    const llm = new Scripted([{ content: [tool("a", "plan_medication")], stopReason: "tool_use" }, text("Give 5 mL.")]);
    await runTurn({ ...base, llm, emit, history: [], transcript: "t", runner: runner(() => outcome({ message: "x" }, true)) });
    expect(events.find((e) => e.type === "assistant_delta")!.data.text).toBe(FAIL_CLOSED_MESSAGE);
    expect(llm.calls).toHaveLength(1);
  });

  it("read_verbatim: the reply IS the tool's speech (plus its follow-up) and the model is not asked to rephrase it", async () => {
    const { events, emit } = collect();
    const llm = new Scripted([{ content: [tool("a", "plan_medication")], stopReason: "tool_use" }, text("Give 2 mL, that should be fine.")]);
    const hist = await runTurn({
      ...base, llm, emit, history: [], transcript: "t",
      runner: runner(() => outcome({ status: "APPROVED", card_type: "SYRINGE_CALIBRATOR", speech: "Leo can have 1.875 milliliters of Infants' Motrin.", followup: "Tell me once you've given it.", read_verbatim: true })),
    });
    expect(llm.calls).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result", "card", "assistant_delta", "done"]);
    expect(events.find((e) => e.type === "assistant_delta")!.data).toEqual({ text: "Leo can have 1.875 milliliters of Infants' Motrin.", verbatim: true, followup: "Tell me once you've given it." });
    // History records what was actually said, so the next turn builds on it (not on a model paraphrase).
    expect(JSON.stringify(hist.at(-1))).toContain("Leo can have 1.875 milliliters");
    expect(JSON.stringify(hist)).not.toContain("2 mL");
  });

  it("two verbatim results in one step are both spoken, in order", async () => {
    const { events, emit } = collect();
    const llm = new Scripted([{ content: [tool("a", "log_observation"), tool("b", "plan_medication")], stopReason: "tool_use" }]);
    await runTurn({
      ...base, llm, emit, history: [], transcript: "t",
      runner: runner((n) => outcome({ status: "OK", card_type: null, speech: n === "log_observation" ? "Logged weight." : "Leo can have 1.875 milliliters.", read_verbatim: true })),
    });
    expect(events.find((e) => e.type === "assistant_delta")!.data.text).toBe("Logged weight. Leo can have 1.875 milliliters.");
  });

  it("a non-verbatim result still goes back to the model, whose reply is guarded", async () => {
    const { events, emit } = collect();
    const llm = new Scripted([{ content: [tool("a", "get_household_context")], stopReason: "tool_use" }, text("Leo needs 9 mL.")]);
    await runTurn({ ...base, llm, emit, history: [], transcript: "t", runner: runner(() => outcome({ status: "OK", card_type: null })) });
    expect(llm.calls).toHaveLength(2);
    expect(events.find((e) => e.type === "numeric_guard")!.data).toMatchObject({ kind: "numeric_guard.blocked", offending: ["9 mL"], draft: "Leo needs 9 mL.", replacement: SAFE_FALLBACK });
  });

  it("a guard trip is logged as a numeric_guard event with the draft and what replaced it", async () => {
    const { events, emit } = collect();
    const llm = new Scripted([text("Give 7 mL.")]);
    await runTurn({ ...base, llm, emit, history: [], transcript: "t", runner: runner(() => outcome({})) });
    expect(events.map((e) => e.type)).toEqual(["numeric_guard", "alert", "assistant_delta", "done"]);
    expect(events[0]!.data).toEqual({ kind: "numeric_guard.blocked", offending: ["7 mL"], draft: "Give 7 mL.", replacement: SAFE_FALLBACK });
  });

  it("on model failure: error event, safe reply, one done, and history is not corrupted", async () => {
    const { events, emit } = collect();
    const prior: LlmMessage[] = [{ role: "user", content: "earlier" }, { role: "assistant", content: [{ type: "text", text: "hi" }] }];
    const hist = await runTurn({ ...base, llm: new Scripted([]), emit, history: prior, transcript: "t", runner: runner(() => outcome({})) });
    expect(hist).toBe(prior);
    expect(events.map((e) => e.type)).toEqual(["error", "assistant_delta", "done"]);
    expect(events[1]!.data.text).toBe(FAIL_CLOSED_MESSAGE);
  });

  it("stops a runaway tool loop", async () => {
    const { events, emit } = collect();
    const loop = Array.from({ length: 10 }, () => ({ content: [tool("a", "x")], stopReason: "tool_use" }) as LlmResponse);
    await runTurn({ ...base, llm: new Scripted(loop), emit, history: [], transcript: "t", maxSteps: 3, runner: runner(() => outcome({ status: "OK" })) });
    expect(events.at(-1)!.type).toBe("done");
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});

describe("trimHistory", () => {
  const turn = (n: number): LlmMessage[] => [
    { role: "user", content: `q${n}` },
    { role: "assistant", content: [tool(`id${n}`, "x") as any] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `id${n}`, content: "{}" }] },
    { role: "assistant", content: [{ type: "text", text: `a${n}` }] },
  ];
  it("cuts on turn boundaries so tool_use/tool_result pairs stay together", () => {
    const h = [1, 2, 3, 4].flatMap(turn);
    const t = trimHistory(h, 2);
    expect(t[0]).toEqual({ role: "user", content: "q3" });
    expect(t).toHaveLength(8);
  });
  it("leaves short histories alone", () => {
    const h = turn(1);
    expect(trimHistory(h, 5)).toBe(h);
  });
});

describe("TurnStore", () => {
  it("serves events by cursor and marks done", () => {
    const s = new TurnStore();
    const id = s.create();
    s.append(id, "a", 1);
    s.append(id, "b", 2);
    expect(s.after(id, 0)!.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(s.after(id, 1)!.events.map((e) => e.type)).toEqual(["b"]);
    expect(s.after(id, 2)!.done).toBe(false);
    s.append(id, "done", {});
    s.append(id, "late", 3); // ignored after done
    expect(s.after(id, 2)!.done).toBe(true);
    expect(s.after(id, 0)!.events).toHaveLength(3);
  });

  it("wait resolves on a new event, on timeout, and on abort", async () => {
    const s = new TurnStore();
    const id = s.create();
    const woke = s.wait(id, 0, 2000).then(() => "event");
    setTimeout(() => s.append(id, "x", 1), 10);
    expect(await woke).toBe("event");
    const t0 = Date.now();
    await s.wait(id, 1, 30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    const ac = new AbortController();
    const aborted = s.wait(id, 1, 5000, ac.signal);
    ac.abort();
    await aborted;
  });

  it("evicts the oldest turns past capacity and expired ones", () => {
    let now = 0;
    const s = new TurnStore(1000, 2, () => now);
    const a = s.create(); const b = s.create(); const c = s.create();
    expect(s.has(a)).toBe(false);
    expect(s.has(b) && s.has(c)).toBe(true);
    now = 5000;
    s.create();
    expect(s.has(b)).toBe(false);
  });
});

describe("BedrockLlm", () => {
  it("sends Converse tool config with auto choice; maps text and toolUse blocks and tool results", async () => {
    let input: any;
    const llm = new BedrockLlm({
      region: "us-east-1", modelId: "us.amazon.nova-pro-v1:0",
      client: { converse: async (p: any) => { input = p; return { stopReason: "tool_use", output: { message: { role: "assistant", content: [{ text: "hi" }, { toolUse: { toolUseId: "tu1", name: "n", input: { a: 1 } } }] } } }; } },
    });
    const tools = [{ name: "n", description: "d", input_schema: { type: "object" } }];
    const messages = [
      { role: "user" as const, content: "q" },
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "t0", name: "n", input: {} }] },
      { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "t0", content: "boom", is_error: true }] },
    ];
    const res = await llm.complete({ system: "sys", messages, tools, context: ctx });
    expect(input).toMatchObject({
      modelId: "us.amazon.nova-pro-v1:0",
      system: [{ text: "sys" }],
      toolConfig: { toolChoice: { auto: {} }, tools: [{ toolSpec: { name: "n", description: "d", inputSchema: { json: { type: "object" } } } }] },
      inferenceConfig: { temperature: 0 },
    });
    expect(input.messages[0]).toEqual({ role: "user", content: [{ text: "q" }] });
    expect(input.messages[1].content[0]).toEqual({ toolUse: { toolUseId: "t0", name: "n", input: {} } });
    expect(input.messages[2].content[0]).toEqual({ toolResult: { toolUseId: "t0", content: [{ text: "boom" }], status: "error" } });
    expect(res.stopReason).toBe("tool_use");
    expect(res.content).toEqual([{ type: "text", text: "hi" }, { type: "tool_use", id: "tu1", name: "n", input: { a: 1 } }]);
  });
});
