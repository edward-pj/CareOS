import type { ContentBlock, LlmClient, LlmMessage, LlmRequest, LlmResponse, ToolResultBlock, ToolUseBlock } from "./llm.js";

// Offline stand-in for the model (LLM_MODE=mock): a regex intent parser for demos and CI. It accepts typed or
// dictated text (keyboard-mic output is plain and unpunctuated) and speaks tool numbers verbatim, like the real prompt demands.

const MEDS = /\b(motrin|advil|ibuprofen|tylenol|acetaminophen|nyquil|aspirin|tums|benadryl)\b/i;
const WEIGHT = /(\d+(?:\.\d+)?)\s*(lbs?|pounds?|kg|kilos?|kilograms?)\b/i;
const VOLUME = /(\d+(?:\.\d+)?)\s*ml\b/i;
const SYMPTOM: Array<[RegExp, string]> = [
  [/sore throat/i, "sore_throat"],
  [/cough/i, "cough"],
  [/nausea|nauseous|queasy/i, "nausea"],
  [/\bcold\b|stuffy/i, "cold"],
];
const PEOPLE: Record<string, string> = { leo: "leo", frank: "frank" };

let seq = 0;
const use = (name: string, input: Record<string, unknown>): ToolUseBlock => ({ type: "tool_use", id: `mock_${++seq}`, name, input });
const say = (text: string): LlmResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn" });
const call = (...blocks: ToolUseBlock[]): LlmResponse => ({ content: blocks, stopReason: "tool_use" });

const clock = (iso: unknown) =>
  typeof iso === "string" ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "later";

function lastUserText(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

function resultsOf(m: LlmMessage | undefined): Array<{ block: ToolResultBlock; p: Record<string, any> }> {
  if (!m || typeof m.content === "string") return [];
  return (m.content as ContentBlock[])
    .filter((b): b is ToolResultBlock => b.type === "tool_result")
    .map((block) => ({ block, p: safeJson(block.content) }));
}

const safeJson = (s: string): Record<string, any> => { try { return JSON.parse(s); } catch { return { status: "ERROR", message: s }; } };

function findCartId(messages: LlmMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const { p } of resultsOf(messages[i])) if (typeof p.cart_id === "string" && p.status === "STAGED") return p.cart_id;
  }
  return undefined;
}

export class MockLlm implements LlmClient {
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const last = req.messages[req.messages.length - 1];
    if (last && last.role === "user" && typeof last.content === "string") return this.parse(last.content, req);
    return this.respond(req);
  }

  // ---------------------------------------------------------------- intent -> tool call
  private parse(raw: string, req: LlmRequest): LlmResponse {
    const text = raw.toLowerCase().trim();
    const { activeProfile, caregiver } = req.context;
    const named = Object.keys(PEOPLE).find((n) => text.includes(n));
    const patient = named ? PEOPLE[named]! : activeProfile;
    const med = MEDS.exec(text)?.[1];

    if (/\b(confirm|place|go ahead)\b/.test(text) && /\b(order|restock)\b/.test(text)) {
      const cartId = findCartId(req.messages);
      return cartId ? call(use("confirm_amazon_order", { cart_id: cartId })) : say("There is no restock waiting for confirmation.");
    }

    if (/\b(restock|reorder|running low|order)\b/.test(text)) {
      const items: Array<{ item_name: string; channel: "prime" | "pharmacy" | "fresh" }> = [];
      if (/motrin|ibuprofen|advil/.test(text) || !/tylenol|strip|ginger|lemon/.test(text)) items.push({ item_name: "Infant's Motrin Concentrated Drops", channel: "prime" });
      if (/tylenol|acetaminophen/.test(text)) items.push({ item_name: "Infant Tylenol Suspension", channel: "prime" });
      if (/strip|glucose/.test(text)) items.push({ item_name: "OneTouch test strips", channel: "pharmacy" });
      if (/ginger|lemon/.test(text)) items.push({ item_name: "Fresh ginger and lemons", channel: "fresh" });
      return call(use("stage_amazon_cart", { requested_items: items }));
    }

    if (/\b(gave|given|dosed|log(ged)?)\b/.test(text) && med && VOLUME.test(text)) {
      return call(use("verify_medication_safety", { patient_id: patient, proposed_medication: med, administration_intent: true }));
    }

    const canTake = /\bcan\s+(\w+)\s+(?:take|have|use|get)\s+(?:some\s+)?([\w' -]+?)\s*\??$/.exec(text);
    if (canTake) {
      const who = PEOPLE[canTake[1]!] ?? patient;
      return call(use("verify_medication_safety", { patient_id: who, proposed_medication: canTake[2]!.trim(), administration_intent: false }));
    }

    const symptom = SYMPTOM.find(([re]) => re.test(text))?.[1];
    if (symptom && !WEIGHT.test(text)) return call(use("query_pantry_remedies", { patient_id: patient, symptom }));

    const w = WEIGHT.exec(text);
    if (w && (/\b(dose|fever|how much|give|temperature)\b/.test(text) || med)) {
      const unit = /^k/i.test(w[2]!) ? "kg" : "lbs";
      const acet = /tylenol|acetaminophen/.test(text);
      return call(
        use("calculate_pediatric_dose", {
          patient_id: patient,
          weight_value: Number(w[1]),
          weight_unit: unit,
          medication: med ?? (acet ? "acetaminophen" : "ibuprofen"),
          formulation: acet ? "infant_susp" : "infant_drops",
          has_fever: /fever|temperature/.test(text),
        }),
      );
    }
    if (/\b(dose|fever|how much)\b/.test(text)) return say(`What does ${patient === "leo" ? "Leo" : patient} weigh?`);

    return say(`Hi ${caregiver}. I can work out an infant dose, check if a medicine is safe, find a pantry remedy, or restock supplies.`);
  }

  // ---------------------------------------------------------------- tool results -> reply (or next call)
  private respond(req: LlmRequest): LlmResponse {
    const last = req.messages[req.messages.length - 1];
    const results = resultsOf(last);
    const p = results[results.length - 1]?.p ?? {};
    const original = lastUserText(req.messages);

    // verify (intent=true) came back CLEAR for a "gave X mL" message: record the dose.
    const gave = /\b(gave|given|dosed|log(ged)?)\b/i.test(original) && VOLUME.test(original);
    if (gave && p.status === "CLEAR") {
      const med = MEDS.exec(original)?.[1] ?? "ibuprofen";
      const person = Object.keys(PEOPLE).find((n) => original.toLowerCase().includes(n));
      return call(
        use("log_administration_event", {
          patient_id: person ? PEOPLE[person] : req.context.activeProfile,
          caregiver_name: req.context.caregiver,
          medication: med,
          volume_ml: Number(VOLUME.exec(original)![1]),
          idempotency_key: `${req.context.turnId}-dose`,
        }),
      );
    }
    return say(this.describe(p));
  }

  private describe(p: Record<string, any>): string {
    switch (p.status) {
      case "APPROVED":
        return `Give ${p.dispense_volume_ml} mL (${p.delivered_dose_mg} mg) of ${p.formulation_label}. Next dose after ${clock(p.next_eligible_time)}.`;
      case "SEEK_CARE":
        return `${p.reason ?? "Please contact a clinician."} Do not give medication.`;
      case "CLEAR":
        return "That is clear to give.";
      case "LOGGED": {
        const low = p.low_stock ? ` The bottle is running low with ${p.bottle_remaining_ml} mL left. Say restock to reorder.` : "";
        return `Logged. Next dose after ${clock(p.next_eligible_time)}.${low}`;
      }
      case "BLOCKED":
      case "REJECTED_LOCKED":
      case "REJECTED_UNSAFE": {
        if (p.violation_type === "DOUBLE_DOSE_LOCKED" && p.last_dose) {
          return `Stop. ${p.last_dose.caregiver} gave ${p.last_dose.medication} ${p.last_dose.minutes_ago} minutes ago. Wait ${p.remaining_minutes} more minutes.`;
        }
        if (p.violation_type === "DAILY_MAX") return `Daily maximum reached. Next dose after ${clock(p.next_eligible_time)}.`;
        const alt = p.approved_alternative ? ` A safer option: ${p.approved_alternative}.` : "";
        return `Blocked. ${p.clinical_rationale ?? p.reason ?? "This is not safe."}${alt}`;
      }
      case "MATCH_FOUND":
        return `Try ${p.remedy_title}. ${(p.preparation_steps ?? []).join(" ")}`;
      case "NO_SAFE_MATCH":
        return "I could not find a safe remedy with what you have at home.";
      case "STAGED":
        return `Staged ${p.items?.length ?? 0} item(s), total $${p.total_usd}, arriving ${p.eta}. Say confirm order to place it.`;
      case "NOTHING_STAGED":
        return "I could not find those items in the catalog.";
      case "ORDER_PLACED":
        return `Order placed (simulated). Arriving ${p.eta}.`;
      case "REJECTED_OVERDOSE":
        return `${p.reason} The most I can log is ${p.max_volume_ml} mL.`;
      default:
        return p.message ?? p.reason ?? "Something went wrong. Please try again.";
    }
  }
}
