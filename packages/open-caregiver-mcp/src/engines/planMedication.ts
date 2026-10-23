import type { PlanPayload, PlanStatus } from "../contracts.js";
import {
  ACETAMINOPHEN_ADULT_CEILING_MG_24H,
  ACETAMINOPHEN_CEILING_SOURCE,
  LABEL_REGISTRY,
  type LabelSku,
  type LiquidSku,
  type SolidSku,
} from "../data/labelRegistry.js";
import { lookupDrug } from "../data/drugClasses.js";
import type { DoseEvent, Patient } from "../storage/types.js";
import { checkInterval, type IntervalResult } from "./intervalLock.js";
import { isWeightStale, kgToLb, labelDose, lbToKg, plausibleWeightKg, solidDose, staleAfterDays, weightIsPlausible } from "./labelDoseEngine.js";
import { productOfSku, resolveProduct } from "./productResolver.js";
import { evaluateSafety, type PatientClinical, type SafetyFinding } from "./safetyMatrix.js";
import { clock, firstName, fmtNumber, numberWords, plural, spokenDuration } from "./speech.js";

// The medication safety pipeline (PRD §4.3). ONE function, one path: a dose cannot be returned without passing, in order,
//   A. product + concentration   B. active prescriptions + ingredients   C. conditions + age   D. time, count, ceiling
// Pure and deterministic: all inputs (clock, chart, ledger) are passed in; no model, no I/O. Any unexpected failure is
// the caller's to turn into a fail-closed answer (S2).

const H = 3_600_000;
const DAY = 86_400_000;
const FEVER_CLINICIAN_UNDER_DAYS = 84; // fever under 12 weeks needs a clinician (PRD §7.2, pending clinician review)

export interface PlanRequest {
  /** What the caregiver named: a brand, an ingredient or a registry sku. */
  product: string;
  symptom?: string;
  reportedWeight?: { value: number; unit?: "lb" | "kg" };
  /** S3: "Has X had any of this today, even if it wasn't logged here?" */
  lastDoseElsewhere?: "none_today" | "gave_earlier" | "unknown";
  elsewhereMinutesAgo?: number;
  /** Strength read off the bottle, e.g. "100 mg / 5 mL" (typed or from Label Lens). */
  bottleConcentration?: string;
  /** Expiry printed on the bottle: "2027-06" (valid through the end of that month) or "2027-06-30". */
  bottleExpires?: string;
}

export interface PlanInput {
  now: number;
  patient: Patient;
  /** This patient's ledger (any ingredient). */
  ledger: DoseEvent[];
  request: PlanRequest;
  /** Registry skus the household has a bottle of (from inventory): resolves a bare "Motrin" to the bottle in the cabinet. */
  houseSkus?: string[];
}

export interface PlanOutcome {
  payload: PlanPayload;
  sku?: LabelSku;
  /** A weight the caregiver just reported and the pipeline accepted: the caller should persist it. */
  weightToRecord?: { lb: number; kg: number; reportedValue: number; reportedUnit: "lb" | "kg" };
}

const ageMonthsOf = (p: Patient, now: number) => Math.max(0, Math.floor((now - p.dobMs) / (30.4375 * DAY)));
const ageDaysOf = (p: Patient, now: number) => Math.max(0, Math.floor((now - p.dobMs) / DAY));

/** Brands a caregiver will recognise, for the "did anyone already give any?" question. */
const INGREDIENT_BRANDS: Record<string, string> = {
  ibuprofen: "Motrin or Advil",
  acetaminophen: "Tylenol",
};

// ---------------------------------------------------------------------------------------------- payload builders

function payload(p: Patient, status: PlanStatus, fields: Omit<PlanPayload, "patient_id" | "patient_name" | "status" | "read_verbatim">): PlanPayload {
  return { patient_id: p.id, patient_name: p.name, status, read_verbatim: true, ...fields } as PlanPayload;
}

function needsInfo(p: Patient, missing: string, question: string, extra: { options?: string[]; codes: string[]; followup?: string }): PlanOutcome {
  return {
    payload: payload(p, "NEEDS_INFO", { card_type: "NEEDS_INFO", missing, question, options: extra.options ?? [], speech: question, followup: extra.followup, reason_codes: extra.codes, sources: [] }),
  };
}

function needsClinician(p: Patient, requested: string, speech: string, rationale: string, codes: string[], sources: string[], extra: Record<string, unknown> = {}): PlanOutcome {
  return {
    payload: payload(p, "NEEDS_CLINICIAN", {
      card_type: "CONTRAINDICATION_SHIELD",
      requested,
      violation_type: "NEEDS_CLINICIAN",
      severity: "MAJOR",
      conflicting_rx: "n/a",
      clinical_rationale: rationale,
      approved_alternative: null,
      speech,
      followup: "Please call your pediatrician, pharmacist or nurse line.",
      reason_codes: codes,
      sources,
      ...extra,
    }),
  };
}

function subjectClause(f: Omit<SafetyFinding, "action">, p: Patient, ageMonths: number): string {
  switch (f.type) {
    case "ALLERGY": return `${p.name}'s chart lists an allergy to ${f.conflictingRx}`;
    case "CONDITION": return `${p.name} has ${f.conflictingRx}`;
    case "AGE_GATE": return `${p.name} is ${ageMonths < 24 ? plural(ageMonths, "month") : plural(Math.floor(ageMonths / 12), "year")} old`;
    default: return `${p.name} takes ${f.conflictingRx}`;
  }
}

/** The alternative the safety matrix proposed, described with the label's own limits when a verified adult label exists. */
function describeAlternative(ingredient: string, p: Patient): { name: string; followup: string; detail: Record<string, unknown> } {
  const solid = LABEL_REGISTRY.find((s): s is SolidSku => s.kind === "solid" && s.ingredients.length === 1 && s.ingredients[0] === ingredient);
  if (p.kind === "elder" && solid) {
    const ceilingMg = solid.limitIngredient === "acetaminophen" ? ACETAMINOPHEN_ADULT_CEILING_MG_24H : solid.maxUnitsPer24h * solid.mgPerUnit;
    return {
      name: ingredient,
      followup: `${ingredient[0]!.toUpperCase()}${ingredient.slice(1)} is the usual alternative. The ${solid.spokenName} label allows no more than ${solid.maxUnitsPer24h} ${solid.unit.plural} in 24 hours, but check with ${p.name}'s clinician first.`,
      detail: { ingredient, product: solid.spokenName, max_units_24h: solid.maxUnitsPer24h, unit_label: solid.unit.plural, ceiling_mg_24h: ceilingMg, source: solid.source.id },
    };
  }
  return {
    name: ingredient,
    followup: `${ingredient[0]!.toUpperCase()}${ingredient.slice(1)} may be an option, but ask ${p.name}'s clinician or pharmacist for the dose.`,
    detail: { ingredient },
  };
}

function safetyOutcome(p: Patient, requested: string, f: Omit<SafetyFinding, "action">, blocked: boolean, alternative: string | undefined, allFindings: SafetyFinding[], ageMonths: number): PlanOutcome {
  const alt = alternative ? describeAlternative(alternative, p) : undefined;
  const status: PlanStatus = alt ? "ALTERNATE_SUGGESTED" : blocked ? "BLOCKED" : "NEEDS_CLINICIAN";
  const lead = blocked || alt ? `I can't clear ${requested} for ${p.name}` : `I can't clear ${requested} for ${p.name} on my own`;
  const speech = `${lead}, because ${subjectClause(f, p, ageMonths)}. ${f.rationale}`;
  return {
    payload: payload(p, status, {
      card_type: "CONTRAINDICATION_SHIELD",
      requested,
      violation_type: f.type,
      severity: f.severity,
      conflicting_rx: f.conflictingRx,
      clinical_rationale: f.rationale,
      approved_alternative: alt?.name ?? null,
      alternative_detail: alt?.detail ?? null,
      rule_id: f.ruleId,
      speech,
      followup: alt?.followup ?? "Please check with a clinician or pharmacist.",
      reason_codes: [f.ruleId, ...allFindings.filter((x) => x.ruleId !== f.ruleId).map((x) => x.ruleId)],
      sources: [...new Set(allFindings.flatMap((x) => x.sources))],
    }),
  };
}

function lockOutcome(p: Patient, sku: LabelSku, i: Exclude<IntervalResult, { status: "CLEAR" }>, now: number): PlanOutcome {
  const remaining = Math.max(0, Math.ceil(i.remainingMs / 60_000));
  const common = { card_type: "DOUBLE_DOSE_INTERCEPT" as const, ingredient: sku.limitIngredient, severity: "CRITICAL", remaining_minutes: remaining, next_eligible_time: new Date(i.nextEligibleAt).toISOString(), next_eligible_label: clock(i.nextEligibleAt), nurse_line: true, sources: [sku.source.id] };
  if (i.status === "DAILY_MAX_REACHED") {
    return {
      payload: payload(p, "BLOCKED", {
        ...common,
        violation_type: "DAILY_MAX",
        doses_last_24h: i.dosesLast24h,
        max_doses_24h: sku.maxDosesPer24h,
        speech: `${p.name} has already had the most ${sku.spokenName} the label allows in 24 hours. The next dose is allowed in ${spokenDuration(remaining)}.`,
        followup: "Please don't give another dose. If you're worried, call the nurse line or a pediatrician.",
        reason_codes: ["DAILY_MAX_REACHED"],
      }),
    };
  }
  const last = i.last as DoseEvent;
  const elsewhere = last.caregiver.toLowerCase().includes("elsewhere");
  const who = elsewhere ? `A dose of ${last.medication} was given elsewhere` : `${firstName(last.caregiver)} gave ${last.medication}`;
  return {
    payload: payload(p, "BLOCKED", {
      ...common,
      violation_type: "DOUBLE_DOSE_LOCKED",
      last_dose: { medication: last.medication, volume_ml: last.volumeMl ?? null, caregiver: last.caregiver, minutes_ago: i.minutesAgo, at: new Date(last.at).toISOString(), time_label: clock(last.at) },
      speech: `Stop. ${who} ${plural(i.minutesAgo, "minute")} ago, so the next dose is allowed in ${spokenDuration(remaining)}.`,
      followup: "Please don't give another dose. If you're worried, call the nurse line or a pediatrician.",
      reason_codes: ["DOUBLE_DOSE_LOCKED"],
    }),
  };
}

// --------------------------------------------------------------------------------------------------- the pipeline

/** End of the expiry period as epoch ms, or undefined when the text is not a recognisable date. */
export function expiryEnd(text: string | undefined): number | undefined {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(text?.trim() ?? "");
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return undefined;
  return m[3] ? Date.UTC(y, mo - 1, Number(m[3]) + 1) : Date.UTC(y, mo, 1); // exclusive end: valid through that day / month
}

const ANTIPYRETICS = ["ibuprofen", "acetaminophen"];

/**
 * Wraps the pipeline with two notes that never change a verdict: (1) C11, a second fever medicine soon after the other one
 * is asked about, not advised on; (2) medicines on the chart that CareOS cannot check, so a clear result is not mistaken
 * for a complete one.
 */
export function planMedication(input: PlanInput): PlanOutcome {
  const out = planCore(input);
  const pl = out.payload;
  const notes: string[] = [];
  const codes: string[] = [];
  const sku = out.sku;

  if (pl.status === "APPROVED" && sku && ANTIPYRETICS.includes(sku.limitIngredient)) {
    const other = ANTIPYRETICS.find((i) => i !== sku.limitIngredient)!;
    const recent = input.ledger.filter((e) => e.ingredient === other && e.at > input.now - 6 * H).sort((a, b) => b.at - a.at)[0];
    if (recent) {
      notes.push(`${recent.medication} was given ${spokenDuration(Math.round((input.now - recent.at) / 60_000))} ago, and this is a different fever medicine. I keep a separate timer for each, so this dose is checked on its own. Whether to give both is a question for your pediatrician or nurse line. What did they advise?`);
      codes.push("ALTERNATING_ANTIPYRETICS");
    }
  }
  const unchecked = input.patient.activeRx.filter((d) => !lookupDrug(d));
  if (unchecked.length > 0 && (pl.status === "APPROVED" || pl.status === "ALTERNATE_SUGGESTED")) {
    notes.push(`I can't check ${unchecked.join(" or ")} against other medicines, so please ask a pharmacist about it.`);
    codes.push("UNCHECKED_ACTIVE_MEDICATION");
  }
  if (notes.length === 0) return out;
  const followup = [typeof pl.followup === "string" ? pl.followup : undefined, ...notes].filter(Boolean).join(" ");
  return { ...out, payload: { ...pl, followup, reason_codes: [...pl.reason_codes, ...codes] } };
}

function planCore({ now, patient: p, ledger, request: req, houseSkus }: PlanInput): PlanOutcome {
  const ageMonths = ageMonthsOf(p, now);
  const ageDays = ageDaysOf(p, now);
  const requestedName = req.product.trim();

  // Fever in a very young infant is not a home-dosing question at all.
  if (req.symptom?.toLowerCase().includes("fever") && ageDays < FEVER_CLINICIAN_UNDER_DAYS) {
    return needsClinician(p, requestedName, `${p.name} is too young to treat a fever at home. Please call your pediatrician or go to urgent care now.`, "Fever in an infant under 12 weeks needs a clinician right away.", ["INFANT_FEVER_UNDER_12_WEEKS"], ["TRIAGE-RULE:INFANT-FEVER-UNDER-12-WEEKS (pending clinician review)"], { severity: "CRITICAL" });
  }

  // ---- A. product + concentration
  const resolved = resolveProduct(req.product, p.kind, req.bottleConcentration, houseSkus);
  switch (resolved.kind) {
    case "unknown_product":
      return needsClinician(p, requestedName, `I can't verify ${requestedName}, so I won't give a dose. Please read the label or ask a pharmacist.`, `"${requestedName}" is not in the verified product list.`, ["UNKNOWN_PRODUCT"], []);
    case "wrong_population":
      return needsClinician(p, requestedName, `${resolved.sku.spokenName} is not for ${p.name}. Please read the label or ask a pharmacist.`, `${resolved.sku.displayName} is not labelled for this patient.`, ["PRODUCT_NOT_FOR_PATIENT"], [resolved.sku.source.id], { violation_type: "PRODUCT_NOT_FOR_PATIENT" });
    case "unknown_concentration":
      return needsClinician(p, requestedName, `I don't have a verified dosing chart for a bottle that says ${resolved.bottle}. Please read the label or ask a pharmacist.`, `No verified label matches a ${resolved.bottle} bottle.`, ["UNKNOWN_CONCENTRATION"], []);
    case "ask":
      return needsInfo(p, "product", resolved.question, { options: resolved.options, codes: resolved.codes });
  }

  // An expired bottle is not used, whatever the chart says.
  if (req.bottleExpires !== undefined) {
    const end = expiryEnd(req.bottleExpires);
    if (end === undefined) {
      return needsInfo(p, "bottle_expiry", "I couldn't read the expiry date. What month and year is printed on the bottle?", { codes: ["BOTTLE_EXPIRY_UNREADABLE"] });
    }
    if (now >= end) {
      const label = new Date(end - 1).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
      return {
        payload: payload(p, "BLOCKED", {
          card_type: "CONTRAINDICATION_SHIELD",
          violation_type: "BOTTLE_EXPIRED",
          severity: "HIGH",
          clinical_rationale: `The bottle expired in ${label}.`,
          speech: `That bottle expired in ${label}, so please don't use it. A pharmacist can tell you what to do with it.`,
          followup: "I can plan a dose from a bottle that is in date.",
          reason_codes: ["BOTTLE_EXPIRED"],
          sources: [],
        }),
      };
    }
  }
  const sku = resolved.kind === "sku" ? resolved.sku : undefined;
  const product = resolved.kind === "sku" ? productOfSku(resolved.sku) : resolved.product;
  const spoken = sku ? sku.spokenName : requestedName;
  const codes: string[] = resolved.kind === "sku" ? [...resolved.codes] : [];
  const sources: string[] = sku ? [sku.source.id] : [];
  if (req.bottleExpires !== undefined) codes.push("BOTTLE_IN_DATE");

  // ---- B + C. active prescriptions, ingredients, conditions, age
  const clinical: PatientClinical = { activeRx: p.activeRx, conditions: p.conditions, allergies: p.allergies, ageMonths };
  const safety = evaluateSafety({ ...product, name: spoken }, clinical);
  if (safety.status !== "CLEAR") {
    return safetyOutcome(p, spoken, safety, safety.status === "BLOCKED", safety.alternative, safety.findings, ageMonths);
  }

  // A known drug with no verified label for this patient: the safety layers passed, but there is no source for a dose.
  if (!sku) {
    return needsClinician(p, spoken, `I don't have a verified dosing label for ${spoken} for ${p.name}. Please read the label or ask a pharmacist.`, `No verified label is registered for ${spoken} for this patient.`, ["NO_VERIFIED_LABEL"], []);
  }

  // ---- S3: absence of a record is not absence of a dose
  const ing = sku.limitIngredient;
  const dosesFor = (events: DoseEvent[]) => events.filter((e) => e.ingredient === ing);
  const inLast24h = dosesFor(ledger).filter((e) => e.at > now - DAY);
  if (inLast24h.length === 0) {
    if (req.lastDoseElsewhere === undefined || req.lastDoseElsewhere === "unknown") {
      return needsInfo(p, "elsewhere", `Has ${p.name} had any ${ing} today${INGREDIENT_BRANDS[ing] ? `, like ${INGREDIENT_BRANDS[ing]},` : ""} even if it wasn't logged here?`, { codes: ["NO_RECORD_IS_NOT_NO_DOSE"] });
    }
    if (req.lastDoseElsewhere === "gave_earlier" && req.elsewhereMinutesAgo === undefined) {
      return needsInfo(p, "elsewhere_time", `About how many minutes ago was the last dose of ${ing}?`, { codes: ["ELSEWHERE_TIME_MISSING"] });
    }
  }

  // ---- D. time, count and ceiling
  const rule = { minIntervalHours: sku.intervalHours, maxDosesPer24h: sku.maxDosesPer24h };
  const interval = checkInterval(dosesFor(ledger), ing, rule, now);
  if (interval.status !== "CLEAR") return lockOutcome(p, sku, interval, now);

  if (sku.kind === "solid" && sku.limitIngredient === "acetaminophen") {
    const proposedMg = sku.unitsPerDose * sku.mgPerUnit;
    const window = inLast24h.sort((a, b) => a.at - b.at);
    // Events logged without an amount are counted at this product's dose: over-counting errs on the side of safety.
    const mg = (e: DoseEvent) => e.amountMg ?? proposedMg;
    const total = window.reduce((n, e) => n + mg(e), 0);
    if (total + proposedMg > ACETAMINOPHEN_ADULT_CEILING_MG_24H) {
      let running = total;
      let freeAt = now;
      for (const e of window) {
        running -= mg(e);
        freeAt = e.at + DAY;
        if (running + proposedMg <= ACETAMINOPHEN_ADULT_CEILING_MG_24H) break;
      }
      const remaining = Math.max(0, Math.ceil((freeAt - now) / 60_000));
      return {
        payload: payload(p, "BLOCKED", {
          card_type: "DOUBLE_DOSE_INTERCEPT",
          ingredient: ing,
          violation_type: "DAILY_MAX",
          severity: "CRITICAL",
          mg_last_24h: total,
          ceiling_mg_24h: ACETAMINOPHEN_ADULT_CEILING_MG_24H,
          remaining_minutes: remaining,
          next_eligible_time: new Date(freeAt).toISOString(),
          next_eligible_label: clock(freeAt),
          nurse_line: true,
          speech: `That would take ${p.name} past the ${ACETAMINOPHEN_ADULT_CEILING_MG_24H} milligram daily limit for acetaminophen, counting every product. The next dose is allowed in ${spokenDuration(remaining)}.`,
          followup: "Acetaminophen is in many cold and pain medicines, so I count all of them together. Please don't give more.",
          reason_codes: ["ACETAMINOPHEN_DAILY_CEILING"],
          sources: [sku.source.id, ACETAMINOPHEN_CEILING_SOURCE],
        }),
      };
    }
    codes.push("ACETAMINOPHEN_CEILING_OK");
  }

  // ---- the dose
  if (sku.kind === "solid") return approvedSolid(p, sku, ageMonths, now, codes, sources);
  return liquidDose(p, sku, ageMonths, now, req, codes, sources, resolved.kind === "sku" ? resolved.note : undefined);
}

function approvedSolid(p: Patient, sku: SolidSku, ageMonths: number, now: number, codes: string[], sources: string[]): PlanOutcome {
  const d = solidDose(sku, ageMonths);
  if (d.status !== "APPROVED") {
    return needsClinician(p, sku.spokenName, `${sku.spokenName} is not labelled for ${p.name}'s age. Please read the label or ask a pharmacist.`, d.detail, d.codes, sources);
  }
  const next = now + sku.intervalHours * H;
  return {
    sku,
    payload: payload(p, "APPROVED", {
      card_type: "TABLET_DOSE",
      product: sku.displayName,
      product_spoken: sku.spokenName,
      dose_units: d.units,
      unit_label: d.unitLabel,
      dose_display: `${d.units} ${d.unitLabel}`,
      delivered_dose_mg: d.doseMg,
      limit_ingredient: sku.limitIngredient,
      ingredients: sku.ingredients,
      lockout_hours: sku.intervalHours,
      next_eligible_time: new Date(next).toISOString(),
      max_doses_per_24h: sku.maxDosesPer24h,
      max_units_24h: sku.maxUnitsPer24h,
      warning: `Label: ${sku.intervalNote}; no more than ${sku.maxUnitsPer24h} ${sku.unit.plural} in 24 hours.`,
      source_label: `${sku.source.brand} label v${sku.source.version}`,
      speech: `${p.name} can take ${d.units} ${d.unitLabel} of ${sku.spokenName}. That is ${numberWords(d.units)} ${d.unitLabel}.`,
      followup: "Tell me once it's been taken so I can start the timer.",
      reason_codes: [...d.codes, ...codes, "SAFETY_LAYERS_A_TO_D_PASSED"],
      sources,
    }),
  };
}

function liquidDose(p: Patient, sku: LiquidSku, ageMonths: number, now: number, req: PlanRequest, codes: string[], sources: string[], resolverNote?: string): PlanOutcome {
  // ---- weight: reported now, or on file and fresh
  let weightLb: number;
  let weightSource: "reported" | "on_file";
  let record: PlanOutcome["weightToRecord"];

  const rw = req.reportedWeight;
  if (rw && Number.isFinite(rw.value)) {
    if (!(rw.value > 0)) return needsInfo(p, "weight", `What does ${p.name} weigh right now? Please say the number and whether it's pounds or kilograms.`, { codes: ["WEIGHT_INVALID"] });
    if (!rw.unit) {
      return needsInfo(p, "weight_unit", `Is ${p.name}'s weight ${fmtNumber(rw.value)} pounds or ${fmtNumber(rw.value)} kilograms?`, { options: ["pounds", "kilograms"], codes: ["WEIGHT_UNIT_MISSING"] });
    }
    const kg = rw.unit === "kg" ? rw.value : lbToKg(rw.value);
    if (!weightIsPlausible(kg, ageMonths)) {
      const range = plausibleWeightKg(ageMonths);
      return needsInfo(p, "weight_confirm", `${fmtNumber(rw.value)} ${rw.unit === "kg" ? "kilograms" : "pounds"} looks unusual for ${p.name}. Please check the scale and tell me the weight and unit again.`, { codes: ["WEIGHT_IMPLAUSIBLE_FOR_AGE"], followup: `Typical range for this age is about ${range.min} to ${range.max} kilograms.` });
    }
    weightLb = rw.unit === "lb" ? rw.value : kgToLb(rw.value);
    weightSource = "reported";
    record = { lb: Math.round(weightLb * 100) / 100, kg: Math.round(kg * 100) / 100, reportedValue: rw.value, reportedUnit: rw.unit };
  } else {
    if (p.weightLbs === undefined) return needsInfo(p, "weight", `What does ${p.name} weigh? Please say the number and whether it's pounds or kilograms.`, { codes: ["WEIGHT_MISSING"] });
    if (isWeightStale(p.weightAt, now, ageMonths)) {
      return needsInfo(p, "weight", `Please weigh ${p.name} again before I give a dose. The last weight is more than ${staleAfterDays(ageMonths)} days old, or I don't know when it was taken.`, { codes: ["WEIGHT_STALE"], followup: "Tell me the new weight in pounds or kilograms." });
    }
    weightLb = p.weightLbs;
    weightSource = "on_file";
  }

  const dose = labelDose({ sku, weightLb, ageMonths });
  if (dose.status === "NEEDS_CLINICIAN") {
    return needsClinician(p, sku.spokenName, `The ${sku.spokenName} label says to ask a doctor before giving it to a child at ${p.name}'s weight or age. Please call your pediatrician or the nurse line.`, dose.detail, [...codes, ...dose.codes], sources);
  }

  const next = now + sku.intervalHours * H;
  const notes: string[] = [];
  if (resolverNote) notes.push(resolverNote);
  if (dose.ageWeightMismatch) notes.push(`${p.name}'s age is outside the ${dose.band.ageLabel} printed beside this weight. The label doses by weight, so this is the weight-based dose.`);
  if (dose.gap) notes.push("This weight falls between two rows on the label. I used the lower row. Ask your pediatrician for a precise dose.");

  return {
    sku,
    weightToRecord: weightSource === "reported" ? record : undefined,
    payload: payload(p, "APPROVED", {
      card_type: "SYRINGE_CALIBRATOR",
      product: sku.displayName,
      product_spoken: sku.spokenName,
      formulation_label: sku.displayName,
      concentration: sku.concentrationLabel,
      weight_lb: Math.round(dose.weightLb * 100) / 100,
      weight_kg: Math.round(dose.weightKg * 100) / 100,
      weight_source: weightSource,
      dispense_volume_ml: dose.doseMl,
      dose_display: `${fmtNumber(dose.doseMl)} mL`,
      delivered_dose_mg: dose.doseMg,
      target_dose_mg: dose.doseMg,
      mg_per_kg: Math.round(dose.mgPerKg * 10) / 10,
      device_name: sku.device.name,
      device_kind: sku.device.kind,
      device_scale_ml: sku.device.illustrativeScaleMl,
      lockout_hours: sku.intervalHours,
      next_eligible_time: new Date(next).toISOString(),
      next_eligible_label: clock(next),
      max_doses_per_24h: sku.maxDosesPer24h,
      interval_note: sku.intervalNote,
      warning: `Label: ${sku.intervalNote}; no more than ${sku.maxDosesPer24h} times in 24 hours.`,
      notes,
      label_gap: dose.gap,
      age_weight_mismatch: dose.ageWeightMismatch,
      source_label: `${sku.source.brand} label v${sku.source.version}`,
      speech: `${p.name} can have ${fmtNumber(dose.doseMl)} milliliters of ${sku.spokenName}. That is ${numberWords(dose.doseMl)} milliliters.`,
      followup: `${dose.gap ? "Ask your pediatrician for a precise dose. " : ""}Use ${sku.device.name}, and tell me once you've given it so I can start the timer.`,
      reason_codes: [...dose.codes, ...codes, "INTERVAL_CLEAR", "SAFETY_LAYERS_A_TO_D_PASSED"],
      sources,
    }),
  };
}
