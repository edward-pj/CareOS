import type { ContentBlock, LlmClient, LlmMessage, LlmRequest, LlmResponse, ToolResultBlock, ToolUseBlock } from "./llm.js";

// Offline stand-in for the model (LLM_MODE=mock): a regex intent parser for demos and CI. Like a real model it is
// stateless between calls and recovers context from the conversation history (earlier tool calls and their results),
// so the multi-turn flows (ask, answer, read-back, "yes") work without an API key. It never computes a number: safety
// tools answer in `speech`, which the loop speaks verbatim; it only words replies for the non-safety tools.

const MEDS = /\b(motrin|advil|ibuprofen|tylenol|acetaminophen|nyquil|aspirin|aleve|naproxen|tums|benadryl)\b/i;
const WEIGHT = /(\d+(?:\.\d+)?)\s*(lbs?|pounds?|kg|kilos?|kilograms?)\b/i;
const BARE_WEIGHT = /\bweigh(?:s|ing)?\s+(?:about\s+)?(\d+(?:\.\d+)?)\b/i;
const MINUTES_AGO = /(\d+)\s*(?:min(?:ute)?s?)\b/i;
const HOURS_AGO = /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/i;
const SYMPTOM: Array<[RegExp, string]> = [
  [/sore throat/i, "sore_throat"],
  [/cough/i, "cough"],
  [/nausea|nauseous|queasy/i, "nausea"],
  [/\bcold\b|stuffy/i, "cold"],
];
const PEOPLE: Record<string, string> = { leo: "leo", frank: "frank" };
const CONDITION = /\b(diab\w*|hypertension|high blood pressure|asthma)\b/;

// Warning signs a caregiver might say, mapped to the tool's sign vocabulary. The tool, not this list, decides the urgency.
const SIGN_PATTERNS: Array<[RegExp, string]> = [
  [/(trouble|difficulty|hard to|can'?t|cannot|struggling to) breath|not breathing|gasping/, "difficulty_breathing"],
  [/\bblue\b|\bgr[ae]y (lips|skin|color)/, "blue_or_gray_color"],
  [/hard to wake|won'?t wake|unresponsive|\blimp\b|floppy|not responding/, "unresponsive_or_hard_to_wake"],
  [/very (ill|sick)|unusually (sleepy|drowsy)|so sleepy|lethargic/, "very_ill_or_unusually_drowsy"],
  [/seizure|convuls/, "seizure"],
  [/rash.*(doesn'?t|does not|won'?t) fade|non.?fading|glass test/, "non_fading_rash"],
  [/stiff neck/, "stiff_neck"],
  [/keeps? (vomiting|throwing up)|(vomit\w*|throwing up).*(again and again|repeatedly|over and over)/, "repeated_vomiting"],
  [/no wet diaper|haven'?t had a wet diaper|dry diaper/, "no_wet_diaper_8h"],
  [/no tears|without tears/, "no_tears"],
  [/sunken (soft spot|fontanel)/, "sunken_soft_spot"],
  [/(spit up|threw up|throw up|vomit\w*).*(dose|medicine|motrin|tylenol)|(dose|medicine|motrin|tylenol).*(spit up|threw up|vomit\w*)/, "vomited_after_dose"],
  [/face.*(droop|sagging)|droop/, "face_drooping"],
  [/arm.*(weak|numb)|can'?t (lift|raise) (his|her) arm/, "arm_weakness"],
  [/slurr|can'?t speak|speech/, "speech_difficulty"],
  [/chest pain|chest (is )?(tight|hurts)/, "chest_pain"],
  [/short(ness)? of breath|can'?t catch (his|her) breath/, "severe_shortness_of_breath"],
  [/\b(fell|fall|hit|bumped|banged|knocked)\b.*\bhead\b|head injury/, "head_strike"],
  [/lips?.*(swell|swollen)|throat.*(swell|closing|tight)|tongue.*swell/, "lip_or_throat_swelling"],
  [/wheez/, "wheezing"],
];
const ELDER = /\b(dad|grandpa|grandfather|frank)\b/;
const UPLOAD = /\bup_[a-f0-9]{8,32}\b/;

let seq = 0;
const use = (name: string, input: Record<string, unknown>): ToolUseBlock => ({ type: "tool_use", id: `mock_${++seq}`, name, input });
const say = (text: string): LlmResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn" });
const call = (...blocks: ToolUseBlock[]): LlmResponse => ({ content: blocks, stopReason: "tool_use" });

const safeJson = (s: string): Record<string, any> => { try { return JSON.parse(s); } catch { return { status: "ERROR", message: s }; } };

interface Past { name: string; input: Record<string, any>; result?: Record<string, any> }

/** Tool calls so far this conversation, oldest first, each paired with its result. */
function history(messages: LlmMessage[]): Past[] {
  const out: Past[] = [];
  const byId = new Map<string, Past>();
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content as ContentBlock[]) {
      if (b.type === "tool_use") {
        const p: Past = { name: b.name, input: b.input as Record<string, any> };
        byId.set(b.id, p);
        out.push(p);
      } else if (b.type === "tool_result") {
        const p = byId.get(b.tool_use_id);
        if (p) p.result = safeJson((b as ToolResultBlock).content);
      }
    }
  }
  return out;
}

function resultsOf(m: LlmMessage | undefined): Array<{ block: ToolResultBlock; p: Record<string, any> }> {
  if (!m || typeof m.content === "string") return [];
  return (m.content as ContentBlock[])
    .filter((b): b is ToolResultBlock => b.type === "tool_result")
    .map((block) => ({ block, p: safeJson(block.content) }));
}

function findCartId(messages: LlmMessage[]): string | undefined {
  for (const h of history(messages).reverse()) if ((h.name === "stage_amazon_cart" || h.name === "confirm_amazon_order") && typeof h.result?.cart_id === "string" && (h.result.status === "STAGED" || h.result.status === "ORDER_PLACED")) return h.result.cart_id;
  return undefined;
}

/** Turn a caregiver's answer to a NEEDS_INFO question into the extra arguments it supplies. */
function answerTo(missing: string, text: string, prior: Record<string, any>): Record<string, unknown> | undefined {
  const t = text.toLowerCase();
  switch (missing) {
    case "elsewhere":
    case "elsewhere_time": {
      const mins = MINUTES_AGO.exec(t)?.[1];
      const hrs = HOURS_AGO.exec(t)?.[1];
      if (mins || hrs) return { last_dose_elsewhere: "gave_earlier", elsewhere_minutes_ago: mins ? Number(mins) : Math.round(Number(hrs) * 60) };
      if (missing === "elsewhere" && /\b(no|nope|none|nothing|not|never|haven'?t|hasn'?t|didn'?t)\b/.test(t)) return { last_dose_elsewhere: "none_today" };
      if (missing === "elsewhere" && /\b(yes|yeah|yep|had|gave|given)\b/.test(t)) return { last_dose_elsewhere: "gave_earlier" };
      return undefined;
    }
    case "weight":
    case "weight_unit":
    case "weight_confirm": {
      const w = WEIGHT.exec(t);
      if (w) return { weight_value: Number(w[1]), weight_unit: /^k/i.test(w[2]!) ? "kg" : "lb" };
      const unit = /\b(pounds?|lbs?)\b/.test(t) ? "lb" : /\b(kilos?|kilograms?|kg)\b/.test(t) ? "kg" : undefined;
      if (unit && prior.weight_value !== undefined) return { weight_unit: unit };
      const bare = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(t);
      return bare ? { weight_value: Number(bare[1]) } : undefined;
    }
    case "product": {
      if (/infant|drops|50\b|1\.25/.test(t)) return { product: "Infants' Motrin" };
      if (/child|100\b|liquid|suspension|5 ?ml/.test(t)) return { product: "Children's Motrin" };
      const med = MEDS.exec(t)?.[1];
      return med ? { product: med } : undefined;
    }
    case "patient": {
      const named = Object.keys(PEOPLE).find((n) => t.includes(n));
      return named ? { patient_id: PEOPLE[named] } : undefined;
    }
    default:
      return undefined;
  }
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
    const past = history(req.messages);
    const lastCall = past[past.length - 1];

    // ---- orders
    if (/\b(where|track|status|arrived|arrive|when)\b.*\b(order|restock|delivery|package)\b|\bhas (my|the) (order|restock) arrived\b/.test(text)) {
      return call(use("track_amazon_order", {}));
    }
    if (/\b(cancel|clear|discard)\b.*\b(order|cart|restock)\b/.test(text)) {
      const cartId = findCartId(req.messages);
      return cartId ? call(use("cancel_amazon_order", { cart_id: cartId, caregiver_id: caregiver })) : say("There is nothing in the cart to cancel.");
    }
    if (/\b(confirm|place|go ahead)\b/.test(text) && /\b(order|restock)\b/.test(text)) {
      const cartId = findCartId(req.messages);
      return cartId ? call(use("confirm_amazon_order", { cart_id: cartId, caregiver_id: caregiver })) : say("There is no restock waiting for confirmation.");
    }
    if (/\b(restock|reorder|running low|order)\b/.test(text)) {
      const items: Array<{ item_name: string; channel: "prime" | "pharmacy" | "fresh" }> = [];
      if (/motrin|ibuprofen|advil/.test(text) || !/tylenol|strip|ginger|lemon/.test(text)) items.push({ item_name: "Infant's Motrin Concentrated Drops", channel: "prime" });
      if (/tylenol|acetaminophen/.test(text)) items.push({ item_name: "Infant Tylenol Suspension", channel: "prime" });
      if (/strip|glucose/.test(text)) items.push({ item_name: "OneTouch test strips", channel: "pharmacy" });
      if (/ginger|lemon/.test(text)) items.push({ item_name: "Fresh ginger and lemons", channel: "fresh" });
      return call(use("stage_amazon_cart", { requested_items: items, caregiver_id: caregiver }));
    }

    // ---- "yes" to a delete-confirmation, a medicine read from a photo, or a bottle label: only now act, with the id/token as returned
    if (lastCall?.name === "forget_patient" && lastCall.result?.status === "NEEDS_CONFIRMATION" && /^(yes|yeah|yep|confirm|do it|delete)\b/.test(text)) {
      return call(use("forget_patient", { patient_id: lastCall.input.patient_id, confirmation_token: lastCall.result.confirmation_token }));
    }
    if (lastCall?.name === "manage_prescriptions" && lastCall.result?.status === "NEEDS_CONFIRMATION" && /^(yes|yeah|yep|correct|confirm|looks right|that'?s right)\b/.test(text)) {
      return call(...(lastCall.result.prescriptions as Array<{ id: string }>).map((r) => use("manage_prescriptions", { action: "confirm", rx_id: r.id })));
    }
    if (lastCall?.name === "read_bottle_label" && lastCall.result?.status === "NEEDS_CONFIRMATION" && /^(yes|yeah|yep|correct|confirm|that'?s right)\b/.test(text)) {
      const c = lastCall.result.claims as Record<string, string | null>;
      return call(use("plan_medication", { patient_id: patient, product: c.product ?? c.ingredient ?? "ibuprofen", symptom: "fever", ...(c.strength ? { bottle_concentration: c.strength } : {}), ...(c.expiry ? { bottle_expires: c.expiry } : {}) }));
    }

    // ---- photos the screen has uploaded: the id travels in the message
    const upload = UPLOAD.exec(text)?.[0];
    if (upload && /prescription|discharge|paper/.test(text)) return call(use("manage_prescriptions", { action: "ingest", patient_id: ELDER.test(text) ? "frank" : patient, upload_id: upload }));
    if (upload && /bottle|label|box/.test(text)) return call(use("read_bottle_label", { upload_id: upload }));

    // ---- privacy
    if (/\b(delete|forget|erase|remove)\b.*\b(data|records?|profile)\b/.test(text)) return call(use("forget_patient", { patient_id: named ? patient : "" }));

    // ---- emergencies, warning signs, the nurse line, and the doctor's summary
    const signs = SIGN_PATTERNS.filter(([re]) => re.test(text)).map(([, id]) => id);
    const feverDays = /fever (?:for|lasting|of)?\s*(\d+(?:\.\d+)?)\s*days?|(\d+(?:\.\d+)?)\s*days? of fever|(\d+)\s*days? (?:now )?with (?:a )?fever/.exec(text);
    if (signs.length > 0 || feverDays) {
      const who = named ? patient : ELDER.test(text) && !/\b(leo|baby)\b/.test(text) ? "frank" : patient;
      const fd = feverDays ? Number(feverDays[1] ?? feverDays[2] ?? feverDays[3]) : undefined;
      return call(use("triage_symptoms", { patient_id: who, ...(signs.length ? { signs } : {}), ...(fd !== undefined ? { fever_days: fd } : {}) }));
    }
    if (/\b(warning signs?|red flags?|should i worry|is it serious|should i be worried)\b/.test(text)) return call(use("triage_symptoms", { patient_id: named ? patient : ELDER.test(text) ? "frank" : patient }));
    if (lastCall?.name === "triage_symptoms" && lastCall.result?.status === "NEEDS_INFO" && lastCall.result?.missing === "signs") {
      if (/^(none|no|nothing|neither|nope)\b/.test(text)) return call(use("triage_symptoms", { ...lastCall.input, no_warning_signs: true }));
    }
    if (/\b(emergency|911|ambulance|nearest hospital|nearby hospital|need (a )?hospital)\b/.test(text)) {
      return call(use("emergency_assist", { ...(named ? { patient_id: patient } : {}), reason: raw.slice(0, 100) }));
    }
    if (/\bnurse\s*line|call the nurse|nurse hotline/.test(text)) return call(use("export_care_summary", { patient_id: named ? patient : activeProfile, kind: "sbar" }));
    if (/\b(pdf|dossier|fever log|care summary|export)\b/.test(text)) {
      const hours = /(\d+)[- ]?(?:hour|hr)/.exec(text)?.[1];
      return call(use("export_care_summary", { patient_id: named ? patient : activeProfile, kind: "dossier", ...(hours ? { hours: Number(hours) } : {}) }));
    }

    // ---- "yes" to a read-back: now (and only now) log it, with the token exactly as returned
    if (lastCall?.name === "confirm_dose_given" && lastCall.result?.status === "NEEDS_CONFIRMATION") {
      if (/^(yes|yeah|yep|yup|correct|that'?s (right|correct)|right|confirm|do it|log it)\b/.test(text)) {
        return call(use("confirm_dose_given", { ...lastCall.input, confirmation_token: lastCall.result.confirmation_token }));
      }
      if (/^(no|nope|wrong|cancel|stop)\b/.test(text)) return say("Okay, I won't log it. Tell me what to change.");
    }

    // ---- an answer to a question the safety tool just asked
    if (lastCall?.name === "plan_medication" && lastCall.result?.status === "NEEDS_INFO") {
      const extra = answerTo(String(lastCall.result.missing), text, lastCall.input);
      if (extra) return call(use("plan_medication", { ...lastCall.input, ...extra }));
    }
    if ((lastCall?.name === "log_observation" || lastCall?.name === "confirm_dose_given") && lastCall.result?.status === "NEEDS_INFO") {
      const extra = answerTo(String(lastCall.result.missing), text, lastCall.input) ?? (lastCall.result.missing === "caregiver" ? { caregiver_id: caregiverFrom(text) } : undefined);
      if (extra) return call(use(lastCall.name, { ...lastCall.input, ...extra }));
    }

    // ---- a dose that was given: read it back before logging
    if (/\b(gave|given|dosed)\b/.test(text) && med) {
      const mins = MINUTES_AGO.exec(text)?.[1];
      return call(use("confirm_dose_given", { patient_id: patient, product: med, caregiver_id: caregiverFrom(text) ?? caregiver, ...(mins ? { given_minutes_ago: Number(mins) } : {}) }));
    }

    // ---- measurements
    const temp = /(?:temp(?:erature)?|fever of|fever is|running)\D{0,12}(\d{2,3}(?:\.\d)?)/.exec(text);
    if (temp && !/how much|give|dose/.test(text)) {
      return call(use("log_observation", { patient_id: patient, type: "temperature", value: Number(temp[1]), ...(/\bc\b|celsius/.test(text) ? { unit: "C" } : /°?\s?f\b|fahrenheit/.test(text) ? { unit: "F" } : {}) }));
    }
    if (/\bweigh/.test(text) && !/how much|give|dose|fever/.test(text)) {
      const w = WEIGHT.exec(text);
      const bare = BARE_WEIGHT.exec(text);
      if (w) return call(use("log_observation", { patient_id: patient, type: "weight", value: Number(w[1]), unit: /^k/i.test(w[2]!) ? "kg" : "lb" }));
      if (bare) return call(use("log_observation", { patient_id: patient, type: "weight", value: Number(bare[1]) }));
    }

    // ---- "does Frank have diabetes?": the recorded conditions, never a guess
    const condition = CONDITION.exec(text)?.[1];
    if (condition && /\b(has|have|does|do|diagnos\w*|suffer)\b/.test(text)) {
      return call(use("get_household_context", { condition, ...(named ? { patient_id: patient } : {}) }));
    }

    // ---- remembered advice / household overview
    if (/\b(last time|doctor said|dr\.? \w+ said|advice|advised|remember|flare)\b/.test(text)) {
      const topic = /gout/.test(text) ? "gout" : /fever/.test(text) ? "fever" : (/(?:about|for|with)\s+([a-z]+)/.exec(text)?.[1] ?? "advice");
      return call(use("get_household_context", { topic, ...(named ? { patient_id: patient } : {}) }));
    }
    if (/\b(who'?s|who is) (in|here)\b|what('s| has| have) (been|we) given|\boverview\b|\bstatus\b/.test(text)) return call(use("get_household_context", {}));

    // ---- "can Frank take Advil?"
    const canTake = /\bcan\s+(\w+)\s+(?:take|have|use|get)\s+(?:some\s+)?([\w' -]+?)\s*\??$/.exec(text);
    if (canTake) return call(use("plan_medication", { patient_id: PEOPLE[canTake[1]!] ?? canTake[1]!, product: canTake[2]!.trim() }));

    // ---- pantry remedies
    const symptom = SYMPTOM.find(([re]) => re.test(text))?.[1];
    if (symptom && !WEIGHT.test(text) && !med) return call(use("query_pantry_remedies", { patient_id: patient, symptom }));

    // ---- a dose question
    if (med || /\b(dose|how much|give (him|her|them))\b/.test(text)) {
      if (!med) return say("Which medicine would you like to give?");
      const input: Record<string, unknown> = { patient_id: patient, product: med };
      if (/fever|temperature/.test(text)) input.symptom = "fever";
      const w = WEIGHT.exec(text);
      const bare = BARE_WEIGHT.exec(text);
      if (w) { input.weight_value = Number(w[1]); input.weight_unit = /^k/i.test(w[2]!) ? "kg" : "lb"; }
      else if (bare) input.weight_value = Number(bare[1]);
      if (/\b(no other|nothing else|hasn'?t had|haven'?t given|none today|not had)\b/.test(text)) input.last_dose_elsewhere = "none_today";
      // A strength and expiry the caregiver just confirmed from the bottle (Label Lens).
      const strength = /bottle says ([\d.,]+\s?mg\s?\/\s?[\d.,]+\s?ml)/i.exec(raw)?.[1];
      const expires = /expires (\d{4}-\d{2}(?:-\d{2})?)/.exec(text)?.[1];
      if (strength) input.bottle_concentration = strength;
      if (expires) input.bottle_expires = expires;
      return call(use("plan_medication", input));
    }

    return say(`Hi ${caregiver}. I can check a dose, tell you if a medicine is safe, log a temperature or weight, find a pantry remedy, or restock supplies.`);
  }

  // ---------------------------------------------------------------- tool results -> reply (non-safety tools only)
  private respond(req: LlmRequest): LlmResponse {
    const last = req.messages[req.messages.length - 1];
    const p = resultsOf(last).at(-1)?.p ?? {};
    return say(this.describe(p));
  }

  private describe(p: Record<string, any>): string {
    switch (p.status) {
      case "OK": {
        const people = (p.patients ?? []).map((x: any) => x.name).join(" and ");
        return people ? `${people} ${(p.patients ?? []).length === 1 ? "is" : "are"} in this household.` : "Nobody is set up in this household yet.";
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
      default:
        return p.speech ?? p.message ?? "Something went wrong. Please try again.";
    }
  }
}

/** "Dad gave it" -> "Dad"; used when a caregiver other than the speaker gave the dose. */
function caregiverFrom(text: string): string | undefined {
  const m = /\b(sarah|dad|mom|grandma)\b/i.exec(text);
  return m ? (m[1]!.toLowerCase() === "mom" ? "Sarah" : m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase()) : undefined;
}
