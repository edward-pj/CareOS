import { describe, expect, it } from "vitest";
import type { PatientSnapshot, TurnEvent } from "../api/types";
import { alertFor, conversationReducer, initialConversation, lastHeard, lastToolUsed, spokenText, type ConversationState } from "./conversation";
import { toCurl, shellQuote } from "./curl";
import { EMERGENCY, telHref } from "./emergency";
import { DESIGN, fitScale } from "./fit";
import { presets } from "./presets";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings";

const run = (events: TurnEvent[], start: ConversationState = initialConversation) =>
  events.reduce((s, event) => conversationReducer(s, { type: "turn_event", turnId: "t1", event }), start);

describe("alerts: questions are not alarms, refusals are", () => {
  it.each([
    ["BLOCKED", "DOUBLE_DOSE_LOCKED", /given too recently/],
    ["BLOCKED", "DAILY_MAX", /Daily maximum/],
    ["ALTERNATE_SUGGESTED", "DRUG_CONTRAINDICATION", /not safe with current prescriptions/],
    ["ALTERNATE_SUGGESTED", null, /safer option/],
    ["NEEDS_CLINICIAN", null, /Ask a clinician/],
    ["MEMORY_CONFLICT", null, /no longer safe/],
    ["REJECTED_LOCKED", "DOUBLE_DOSE_LOCKED", /given too recently/],
    ["BLOCKED", "ALLERGY", /allergy/],
    ["BLOCKED", "PRODUCT_NOT_FOR_PATIENT", /not labelled/],
  ])("%s / %s", (kind, violation, want) => expect(alertFor(kind, violation)).toMatch(want));

  it("NEEDS_INFO, NEEDS_CONFIRMATION and LOGGED raise no alert", () => {
    for (const k of ["NEEDS_INFO", "NEEDS_CONFIRMATION", "LOGGED", "APPROVED", "GUARDRAIL_REPLACED"]) expect(alertFor(k)).toBeUndefined();
  });

  it("a blocked tool result turns its step red; a question does not", () => {
    const s = run([
      { seq: 1, type: "tool_call", data: { id: "a", name: "plan_medication", input: {} } },
      { seq: 2, type: "tool_result", data: { id: "a", name: "plan_medication", status: "ALTERNATE_SUGGESTED", is_error: false } },
      { seq: 3, type: "tool_call", data: { id: "b", name: "plan_medication", input: {} } },
      { seq: 4, type: "tool_result", data: { id: "b", name: "plan_medication", status: "NEEDS_INFO", is_error: false } },
    ]);
    expect(s.steps.map((x) => x.state)).toEqual(["blocked", "ok"]);
  });
});

describe("assistant replies keep the tool's follow-up separate, and speech includes both", () => {
  it("stores followup on the message", () => {
    const s = run([{ seq: 1, type: "assistant_delta", data: { text: "Leo can have 1.875 milliliters.", verbatim: true, followup: "Tell me once you've given it." } }]);
    expect(s.messages[0]).toMatchObject({ text: "Leo can have 1.875 milliliters.", followup: "Tell me once you've given it." });
    expect(spokenText(s.messages[0]!)).toBe("Leo can have 1.875 milliliters. Tell me once you've given it.");
    expect(spokenText({ text: "Hi" })).toBe("Hi");
  });
});

describe("Numeric Guard log", () => {
  const ev: TurnEvent = { seq: 3, type: "numeric_guard", data: { kind: "numeric_guard.blocked", offending: ["2 mL"], draft: "Give 2 mL.", replacement: "Leo can have 1.875 milliliters." } };

  it("records the discarded draft and what replaced it, and tells the caregiver", () => {
    const s = run([ev]);
    expect(s.guardLog).toHaveLength(1);
    expect(s.guardLog[0]).toMatchObject({ offending: ["2 mL"], draft: "Give 2 mL.", replacement: "Leo can have 1.875 milliliters." });
    expect(s.alertText).toMatch(/never gave/);
  });

  it("survives new turns (it is a session log) but is capped", () => {
    let s = run([ev]);
    s = conversationReducer(s, { type: "user_sent", id: "u", text: "next" });
    expect(s.guardLog).toHaveLength(1);
    for (let i = 0; i < 30; i++) s = run([{ ...ev, seq: 100 + i }], s);
    expect(s.guardLog.length).toBe(20);
  });
});

describe("what Alexa heard / tool used", () => {
  it("reports the last user utterance and the last tool", () => {
    let s = conversationReducer(initialConversation, { type: "user_sent", id: "u1", text: "I gave Leo Motrin" });
    s = run([{ seq: 1, type: "tool_call", data: { id: "a", name: "confirm_dose_given", input: {} } }], s);
    expect(lastHeard(s)).toBe("I gave Leo Motrin");
    expect(lastToolUsed(s)).toBe("confirm_dose_given");
    expect(lastHeard(initialConversation)).toBeUndefined();
  });
});

describe("presets follow the active person", () => {
  const snap = (kind: "infant" | "elder", name: string, weightLbs?: number) => ({ profile: { id: name.toLowerCase(), name, kind, weightLbs } }) as unknown as PatientSnapshot;
  const cg = [{ id: "sarah", name: "Sarah (Mom)" }, { id: "dad", name: "Dad" }];

  it("a baby gets the dosing flow with the weight on file", () => {
    const p = presets(snap("infant", "Leo", 19), cg, "Sarah (Mom)");
    expect(p[0]).toBe("Leo has a fever and weighs 19 lbs. How much Motrin?");
    expect(p).toContain("I gave Leo Motrin");
    expect(p).toContain("Switch caregiver shift to Dad");
  });

  it("an adult gets the contraindication and memory-conflict flows", () => {
    const p = presets(snap("elder", "Frank"), cg, "Dad");
    expect(p[0]).toBe("Can Frank take Advil?");
    expect(p).toContain("What did the doctor say last time about Frank's gout?");
    expect(p).toContain("Switch caregiver shift to Sarah (Mom)");
  });
});

describe("copy as curl", () => {
  const frame = { dir: "in" as const, message: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "plan_medication", arguments: { product: "Children's Motrin" } } } };

  it("reproduces the request, reads the token from the environment, and survives an apostrophe", () => {
    const c = toCurl(frame, "http://127.0.0.1:8787/")!;
    expect(c).toContain("curl -s -X POST 'http://127.0.0.1:8787/mcp'");
    expect(c).toContain(`-H "authorization: Bearer $CAREOS_TOKEN"`);
    expect(c).toContain("accept: application/json, text/event-stream");
    expect(c).toContain(`Children'\\''s Motrin`);
    expect(c).not.toMatch(/Bearer [A-Za-z0-9]{8,}/);
  });

  it("only requests can be replayed", () => {
    expect(toCurl({ ...frame, dir: "out" }, "http://x")).toBeUndefined();
  });

  it("quotes safely", () => expect(shellQuote("a'b")).toBe(`'a'\\''b'`));
});

describe("emergency fallback (S8: no server needed)", () => {
  it("has a number and a tel: link for each locale, and generic first-aid steps that never mention a medicine dose", () => {
    expect(EMERGENCY.US.number).toBe("911");
    expect(EMERGENCY.IN.number).toBe("112");
    expect(telHref(EMERGENCY.US.number)).toBe("tel:911");
    expect(EMERGENCY.US.poison.tel).toBe("18002221222");
    for (const e of Object.values(EMERGENCY)) {
      expect(e.steps.length).toBeGreaterThanOrEqual(4);
      expect(e.steps.join(" ")).not.toMatch(/\d+\s*(mg|ml)\b/i);
      expect(e.steps.join(" ")).toMatch(/Do not give food, drink or any medicine/);
    }
  });
});

describe("settings", () => {
  it("round-trips through storage", () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    saveSettings({ ...DEFAULT_SETTINGS, highContrast: true, screenless: true }, storage);
    expect(loadSettings(storage)).toEqual({ highContrast: true, reducedMotion: false, screenless: true, speakReplies: true });
  });

  it("falls back to defaults when storage is missing, corrupt or throws", () => {
    expect(loadSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings({ getItem: () => "{not json" })).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings({ getItem: () => { throw new Error("blocked"); } })).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(DEFAULT_SETTINGS, { setItem: () => { throw new Error("quota"); } })).not.toThrow();
  });
});

describe("fit to window", () => {
  it("scales the 1920x1080 canvas down to fit, never up", () => {
    expect(fitScale(1920, 1080)).toBe(1);
    expect(fitScale(3840, 2160)).toBe(1);
    expect(fitScale(960, 1080)).toBe(0.5);
    expect(fitScale(1920, 540)).toBe(0.5);
    expect(fitScale(1280, 800)).toBeCloseTo(0.6667, 3);
    expect(fitScale(0, 0)).toBe(1);
    expect(DESIGN).toEqual({ width: 1920, height: 1080 });
  });
});
