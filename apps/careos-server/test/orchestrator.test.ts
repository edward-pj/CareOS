import { describe, expect, it } from "vitest";
import { BedrockLlm } from "../src/orchestrator/bedrock.js";
import { guardReply, numbersIn, SAFE_FALLBACK, unbackedAmounts } from "../src/orchestrator/guardrail.js";
import type { LlmClient, LlmMessage, LlmRequest, LlmResponse } from "../src/orchestrator/llm.js";
import { runTurn, trimHistory, type TurnEventType } from "../src/orchestrator/loop.js";
import type { ToolOutcome, ToolRunner } from "../src/orchestrator/mcpClient.js";
import { sanitizeSchema, toClaudeTools } from "../src/orchestrator/toolBridge.js";
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

  it("never offers override_lockout to the model", () => {
    const tools = toClaudeTools([
      { name: "override_lockout", inputSchema: { type: "object", properties: { pin: { type: "string" } } } },
      { name: "verify_medication_safety", inputSchema: { type: "object", properties: {} } },
    ]);
    expect(tools.map((t) => t.name)).toEqual(["verify_medication_safety"]);
    expect(tools[0]!.strict).toBe(true);
  });
});

describe("guardrail", () => {
  const results = [{ status: "APPROVED", dispense_volume_ml: 2, delivered_dose_mg: 80, formulation_label: "Infant drops 50 mg/1.25 mL" }];

  it("collects numbers from tool results", () => {
    expect(numbersIn(results)).toEqual(expect.arrayContaining([2, 80, 50, 1.25]));
  });

  it("allows amounts that a tool returned, regardless of formatting", () => {
    expect(unbackedAmounts("Give 2.00 mL (80 mg).", results)).toEqual([]);
    expect(unbackedAmounts("Give 2 milliliters.", results)).toEqual([]);
  });

  it("replaces a reply that states an amount no tool returned", () => {
    const g = guardReply("Give 3 mL to be safe.", results);
    expect(g.replaced).toBe(true);
    expect(g.text).toBe(SAFE_FALLBACK);
    expect(g.offending).toEqual(["3 mL"]);
  });

  it("does not police non-dose numbers", () => {
    expect(guardReply("Wait 45 minutes.", [])).toMatchObject({ replaced: false });
  });

  it("with no tool results, any dose amount is unbacked", () => {
    expect(guardReply("Give 5 mL.", []).replaced).toBe(true);
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
      { content: [tool("a", "calculate_pediatric_dose")], stopReason: "tool_use" },
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
    const llm = new Scripted([{ content: [tool("a", "verify_medication_safety")], stopReason: "tool_use" }, text("Blocked.")]);
    await runTurn({ ...base, llm, emit, history: [], transcript: "t", runner: runner(() => outcome({ status: "BLOCKED", violation_type: "DOUBLE_DOSE_LOCKED", card_type: "DOUBLE_DOSE_INTERCEPT" })) });
    expect(events.find((e) => e.type === "alert")!.data).toMatchObject({ kind: "BLOCKED", violation_type: "DOUBLE_DOSE_LOCKED" });
  });

  it("survives a throwing tool and reports it to the model as an error result", async () => {
    const { emit } = collect();
    const llm = new Scripted([{ content: [tool("a", "x")], stopReason: "tool_use" }, text("Sorry.")]);
    const hist = await runTurn({ ...base, llm, emit, history: [], transcript: "t", runner: runner(() => { throw new Error("boom"); }) });
    expect(JSON.stringify(hist[2])).toContain("Tool failed: boom");
  });

  it("on model failure: error event, safe reply, one done, and history is not corrupted", async () => {
    const { events, emit } = collect();
    const prior: LlmMessage[] = [{ role: "user", content: "earlier" }, { role: "assistant", content: [{ type: "text", text: "hi" }] }];
    const hist = await runTurn({ ...base, llm: new Scripted([]), emit, history: prior, transcript: "t", runner: runner(() => outcome({})) });
    expect(hist).toBe(prior);
    expect(events.map((e) => e.type)).toEqual(["error", "assistant_delta", "done"]);
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
  it("sends strict tools, auto tool choice and low effort; maps text and tool_use blocks", async () => {
    let params: any;
    const llm = new BedrockLlm({
      region: "us-east-1", modelId: "anthropic.claude-opus-5-5",
      client: { messages: { create: async (p: any) => { params = p; return { stop_reason: "tool_use", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "hi" }, { type: "tool_use", id: "tu1", name: "n", input: { a: 1 } }] }; } } },
    });
    const tools = [{ name: "n", description: "d", input_schema: { type: "object" }, strict: true as const }];
    const res = await llm.complete({ system: "sys", messages: [{ role: "user", content: "q" }], tools, context: ctx });
    expect(params).toMatchObject({ model: "anthropic.claude-opus-5-5", system: "sys", tool_choice: { type: "auto" }, output_config: { effort: "low" }, tools });
    expect(res.stopReason).toBe("tool_use");
    expect(res.content).toEqual([{ type: "text", text: "hi" }, { type: "tool_use", id: "tu1", name: "n", input: { a: 1 } }]);
  });
});
