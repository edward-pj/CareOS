import { describe, expect, it } from "vitest";
import { conversationReducer, initialConversation, alertFor } from "./conversation";
import { SIGN_PHRASE, signsMessage } from "./signs";

describe("show_payload: a result the screen fetched itself", () => {
  const act = (payload: Record<string, unknown>) => conversationReducer(initialConversation, { type: "show_payload", userId: "u", userText: "Photo of Frank's prescription", replyId: "a", payload });
  it("shows the card, adds both sides of the exchange, and names the tool that produced it", () => {
    const s = act({ status: "NEEDS_CONFIRMATION", card_type: "RX_CONFIRMATION", speech: "I read 2 medicines.", followup: "Check each one." });
    expect(s.card).toMatchObject({ cardType: "RX_CONFIRMATION", key: "a" });
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.messages[1]).toMatchObject({ text: "I read 2 medicines.", followup: "Check each one." });
    expect(s.steps[0]).toMatchObject({ name: "manage_prescriptions", state: "ok" });
    expect(s.busy).toBe(false);
    expect(s.alertText).toBeUndefined();
  });
  it("raises the red alert for a blocking result such as an expired bottle", () => {
    const s = act({ status: "BLOCKED", card_type: "LABEL_LENS", violation_type: "BOTTLE_EXPIRED", speech: "That bottle expired." });
    expect(s.alertText).toMatch(/Blocked/);
    expect(s.steps[0]).toMatchObject({ name: "read_bottle_label", state: "blocked" });
  });
  it("an error with no card still tells the person what happened", () => {
    const s = act({ status: "UNAVAILABLE", card_type: null, speech: "I can't read photos right now." });
    expect(s.card).toBeUndefined();
    expect(s.messages.at(-1)!.text).toBe("I can't read photos right now.");
  });
});

describe("urgency alerts", () => {
  it("every escalation level has plain alert copy, and the home-care level is not an alarm", () => {
    expect(alertFor("CALL_EMERGENCY")).toMatch(/emergency/i);
    expect(alertFor("GO_TO_ER_NOW")).toBeTruthy();
    expect(alertFor("CALL_DOCTOR_TODAY")).toBeTruthy();
    expect(alertFor("HOME_CARE_OK_WITH_WATCH")).toBeUndefined();
  });
});

describe("checklist taps become ordinary sentences", () => {
  it("names the person and joins the chosen signs", () => {
    expect(signsMessage("Leo", ["stiff_neck", "no_tears"])).toBe("Leo has a stiff neck and no tears");
    expect(signsMessage("Leo", [])).toBe("None of those for Leo");
  });
  it("has a phrase for every sign the server asks about", () => {
    for (const s of ["difficulty_breathing", "blue_or_gray_color", "unresponsive_or_hard_to_wake", "very_ill_or_unusually_drowsy", "seizure", "non_fading_rash", "stiff_neck", "repeated_vomiting", "no_wet_diaper_8h", "no_tears", "sunken_soft_spot", "vomited_after_dose", "face_drooping", "arm_weakness", "speech_difficulty", "chest_pain", "severe_shortness_of_breath", "head_strike", "lip_or_throat_swelling", "wheezing"]) {
      expect(SIGN_PHRASE[s], s).toBeTruthy();
    }
  });
});
