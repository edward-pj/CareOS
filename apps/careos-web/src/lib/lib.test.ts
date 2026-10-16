import { describe, expect, it } from "vitest";
import type { PatientSnapshot, TurnEvent } from "../api/types";
import { conversationReducer, initialConversation, parseShiftSwitch, type ConversationState } from "./conversation";
import { buildHandoff } from "./handoff";
import { formatRemaining } from "./time";

const run = (events: TurnEvent[], start: ConversationState = initialConversation) =>
  events.reduce((s, event) => conversationReducer(s, { type: "turn_event", turnId: "t1", event }), start);

describe("conversationReducer", () => {
  const sent = conversationReducer(initialConversation, { type: "user_sent", id: "u1", text: "can frank take nyquil" });

  it("tracks a tool call through to a blocked result and its card payload", () => {
    const s = run(
      [
        { seq: 1, type: "tool_call", data: { id: "a", name: "verify_medication_safety", input: { patient_id: "frank" } } },
        { seq: 2, type: "tool_result", data: { id: "a", name: "verify_medication_safety", status: "BLOCKED", is_error: false } },
        { seq: 3, type: "card", data: { card_type: "CONTRAINDICATION_SHIELD", tool: "verify_medication_safety", payload: { clinical_rationale: "x" } } },
        { seq: 4, type: "alert", data: { kind: "BLOCKED", violation_type: "DRUG_CONTRAINDICATION" } },
        { seq: 5, type: "assistant_delta", data: { text: "Blocked." } },
        { seq: 6, type: "done", data: {} },
      ],
      sent,
    );
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0]).toMatchObject({ state: "blocked", status: "BLOCKED", payload: { clinical_rationale: "x" } });
    expect(s.card?.cardType).toBe("CONTRAINDICATION_SHIELD");
    expect(s.alertText).toMatch(/not safe with current prescriptions/);
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.busy).toBe(false);
  });

  it("clears the previous turn's trace and card when a new turn starts", () => {
    const dirty = { ...sent, card: { key: "k", cardType: "PANTRY_REMEDY" as const, payload: {} }, steps: [{ id: "a", name: "n", input: {}, state: "ok" as const }] };
    const next = conversationReducer(dirty, { type: "user_sent", id: "u2", text: "again" });
    expect(next.card).toBeUndefined();
    expect(next.steps).toEqual([]);
  });

  it("marks an errored tool", () => {
    const s = run([
      { seq: 1, type: "tool_call", data: { id: "a", name: "t", input: {} } },
      { seq: 2, type: "tool_result", data: { id: "a", name: "t", is_error: true } },
    ]);
    expect(s.steps[0]?.state).toBe("error");
  });

  it("does not show guardrail notes as caregiver alerts", () => {
    expect(run([{ seq: 1, type: "alert", data: { kind: "GUARDRAIL_REPLACED" } }]).alertText).toBeUndefined();
  });
});

describe("parseShiftSwitch", () => {
  const cg = [{ name: "Sarah" }, { name: "Grandma" }];
  it("finds the named caregiver", () => expect(parseShiftSwitch("Switch caregiver shift to Grandma", cg)).toBe("Grandma"));
  it("ignores unrelated text", () => expect(parseShiftSwitch("Switch to Grandma", cg)).toBeUndefined());
  it("ignores unknown names", () => expect(parseShiftSwitch("switch shift to Bob", cg)).toBeUndefined());
});

describe("buildHandoff", () => {
  const snap: PatientSnapshot = {
    profile: { id: "leo", name: "Leo", kind: "infant", dobMs: 0, activeRx: [], conditions: [], allergies: [], age_days: 200, weight_kg: 10 },
    medication_history: [
      { eventId: "1", patientId: "leo", medication: "Motrin", ingredient: "ibuprofen", caregiver: "Sarah", at: Date.UTC(2026, 0, 1, 12), volumeMl: 2 },
      { eventId: "2", patientId: "leo", medication: "Tylenol", ingredient: "acetaminophen", caregiver: "Mike", at: Date.UTC(2026, 0, 1, 9), volumeMl: 3 },
    ],
    active_locks: [{ ingredient: "ibuprofen", status: "DOUBLE_DOSE_LOCKED", next_eligible_time: new Date(Date.UTC(2026, 0, 1, 18)).toISOString() }],
  };

  it("reports the most recent dose, locks and low stock", () => {
    const h = buildHandoff(snap, [{ id: "i", name: "Motrin bottle", unit: "mL", remaining: 5, lowThreshold: 10 }], "Sarah");
    expect(h.headline).toBe("Handoff for Leo from Sarah");
    expect(h.lines[0]).toMatch(/Motrin 2 mL by Sarah/);
    expect(h.lines.some((l) => /ibuprofen: dose lock active/.test(l))).toBe(true);
    expect(h.lines.some((l) => /Low stock: Motrin bottle \(5 mL left\)/.test(l))).toBe(true);
    expect(h.attention).toBe(true);
  });

  it("is calm when nothing needs attention", () => {
    const h = buildHandoff({ ...snap, active_locks: [] }, [{ id: "i", name: "Motrin bottle", unit: "mL", remaining: 50, lowThreshold: 10 }], "Sarah");
    expect(h.attention).toBe(false);
  });
});

describe("formatRemaining", () => {
  it("formats", () => {
    expect(formatRemaining(0)).toBe("now");
    expect(formatRemaining(725_000)).toBe("12m 05s");
    expect(formatRemaining(5_100_000)).toBe("1h 25m");
  });
});
