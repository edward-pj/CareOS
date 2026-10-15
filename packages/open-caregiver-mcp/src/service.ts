import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { findCatalogEntry } from "./data/catalog.js";
import { lookupDrug } from "./data/drugClasses.js";
import { FORMULATIONS, LBS_TO_KG, type Formulation } from "./data/formulations.js";
import { calculateDose, lbsToKg } from "./engines/pediatricEngine.js";
import { checkInterval, type IntervalResult } from "./engines/intervalLock.js";
import { findRemedy, type Symptom } from "./engines/pantryEngine.js";
import { verifyDrugSafety } from "./engines/safetyMatrix.js";
import type { Cart, DoseEvent, Notifier, Patient, StorageAdapter } from "./storage/types.js";

const DAY = 86_400_000;
const H = 3_600_000;
const OVERRIDE_WINDOW_MS = 5 * 60_000;
const MAX_PIN_FAILURES = 3;

export type CardType =
  | "SYRINGE_CALIBRATOR"
  | "DOUBLE_DOSE_INTERCEPT"
  | "CONTRAINDICATION_SHIELD"
  | "PANTRY_REMEDY"
  | "AMAZON_RESTOCK_CAROUSEL"
  | null;

export type Payload = Record<string, unknown> & { status: string; card_type: CardType };

export interface ServiceOptions {
  clock?: () => number;
  notifier?: Notifier;
  overridePin?: string;
}

const sha = (s: string) => createHash("sha256").update(s).digest();
const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

export function normalizePatientId(id: string): string {
  return id.trim().toLowerCase().replace(/^(infant|elder)_/, "");
}

export function intervalRuleFor(ingredient: string) {
  const f = Object.values(FORMULATIONS).find((x) => x.ingredient === ingredient);
  return f ? { minIntervalHours: f.minIntervalHours, maxDosesPer24h: f.maxDosesPer24h } : { minIntervalHours: 6, maxDosesPer24h: 4 };
}

/** Pick the formulation a free-text medication name refers to. */
function inferFormulation(medication: string, ingredient: string): Formulation | undefined {
  const m = medication.toLowerCase();
  const all = Object.values(FORMULATIONS).filter((f) => f.ingredient === ingredient);
  if (m.includes("drop")) return all.find((f) => f.key.endsWith("infant_drops")) ?? all[0];
  if (m.includes("children") || m.includes("susp")) return all.find((f) => f.key.endsWith("children_susp")) ?? all[0];
  return all[0];
}

export class CareService {
  private clock: () => number;
  private notifier?: Notifier;
  private pinHash: Buffer;
  private pinFailures = new Map<string, { count: number; until: number }>();

  constructor(readonly storage: StorageAdapter, opts: ServiceOptions = {}) {
    this.clock = opts.clock ?? Date.now;
    this.notifier = opts.notifier;
    this.pinHash = sha(opts.overridePin ?? process.env.CAREOS_OVERRIDE_PIN ?? "4242");
  }

  now() { return this.clock(); }

  async patient(id: string): Promise<Patient> {
    const p = await this.storage.getPatient(normalizePatientId(id));
    if (!p) throw new Error(`Unknown patient "${id}".`);
    return p;
  }

  // ---------------------------------------------------------------- dosing
  async calculatePediatricDose(a: { patient_id: string; weight_value: number; weight_unit: "lbs" | "kg"; medication: string; formulation: string; has_fever?: boolean }): Promise<Payload> {
    const p = await this.patient(a.patient_id);
    const now = this.now();
    const ing = lookupDrug(a.medication)?.ingredient ?? a.medication.toLowerCase();
    const key = `${ing}.${a.formulation}`;
    const ageDays = Math.floor((now - p.dobMs) / DAY);

    const dose = calculateDose({ weightValue: a.weight_value, weightUnit: a.weight_unit, ageDays, formulationKey: key, hasFever: a.has_fever });
    if (dose.status !== "APPROVED") {
      return { status: dose.status, patient_name: p.name, reason: dose.reason, weight_kg: dose.weightKg ?? null, card_type: null };
    }

    // A calculated dose is only useful if it can be given now.
    const verdict = await this.verifyMedicationSafety({ patient_id: p.id, proposed_medication: a.medication, administration_intent: false });
    if (verdict.status === "BLOCKED") return { ...verdict, patient_name: p.name, weight_kg: dose.weightKg };

    const f = dose.formulation;
    return {
      status: "APPROVED",
      patient_name: p.name,
      weight_kg: dose.weightKg,
      target_dose_mg: dose.targetDoseMg,
      delivered_dose_mg: dose.deliveredDoseMg,
      dispense_volume_ml: dose.dispenseVolumeMl,
      formulation_label: f.label,
      warning: f.warning,
      lockout_hours: f.minIntervalHours,
      next_eligible_time: new Date(now + f.minIntervalHours * H).toISOString(),
      card_type: "SYRINGE_CALIBRATOR",
    };
  }

  // ---------------------------------------------------------------- safety
  async verifyMedicationSafety(a: { patient_id: string; proposed_medication: string; administration_intent: boolean }): Promise<Payload> {
    const p = await this.patient(a.patient_id);
    const now = this.now();
    const drug = lookupDrug(a.proposed_medication);

    const safety = verifyDrugSafety(a.proposed_medication, p);
    if (safety.status === "BLOCKED") {
      if (a.administration_intent && safety.severity === "CRITICAL") {
        await this.notifier?.send("CRITICAL_BLOCK", `CareOS: blocked ${a.proposed_medication} for ${p.name} (${safety.rationale})`);
      }
      return {
        status: "BLOCKED",
        violation_type: safety.violationType,
        severity: safety.severity,
        conflicting_rx: safety.conflictingRx,
        clinical_rationale: safety.rationale,
        approved_alternative: safety.approvedAlternative ?? null,
        requested: a.proposed_medication,
        card_type: safety.violationType === "UNKNOWN_DRUG" ? null : "CONTRAINDICATION_SHIELD",
      };
    }

    const ingredient = drug!.ingredient;
    const ageDays = Math.floor((now - p.dobMs) / DAY);
    const minAge = Math.min(...Object.values(FORMULATIONS).filter((f) => f.ingredient === ingredient).map((f) => f.minAgeDays));
    if (p.kind === "infant" && Number.isFinite(minAge) && ageDays < minAge) {
      return {
        status: "BLOCKED",
        violation_type: "AGE_GATE",
        severity: "CRITICAL",
        clinical_rationale: `${ingredient} is not approved at ${Math.floor(ageDays / 30.4)} months of age.`,
        approved_alternative: null,
        card_type: "CONTRAINDICATION_SHIELD",
      };
    }

    const ledger = await this.storage.getLedger(p.id);
    const override = await this.storage.getOverride(p.id, ingredient);
    const overrideActive = override !== undefined && override > now;
    const interval = checkInterval(ledger, ingredient, intervalRuleFor(ingredient), now);
    if (interval.status !== "CLEAR" && !(interval.status === "DOUBLE_DOSE_LOCKED" && overrideActive)) {
      if (a.administration_intent) await this.notifyLockAttempt(p, ingredient, interval);
      return this.lockPayload(p, ingredient, interval);
    }
    return { status: "CLEAR", ingredient, override_active: overrideActive, next_eligible_time: new Date(interval.nextEligibleAt).toISOString(), card_type: null };
  }

  private lockPayload(p: Patient, ingredient: string, interval: Exclude<IntervalResult, { status: "CLEAR" }>): Payload {
    const base = { patient_name: p.name, ingredient, card_type: "DOUBLE_DOSE_INTERCEPT" as const };
    const remaining = Math.max(0, Math.ceil(interval.remainingMs / 60_000));
    if (interval.status === "DAILY_MAX_REACHED") {
      return { ...base, status: "BLOCKED", violation_type: "DAILY_MAX", severity: "CRITICAL", doses_last_24h: interval.dosesLast24h, remaining_minutes: remaining, next_eligible_time: new Date(interval.nextEligibleAt).toISOString() };
    }
    const last = interval.last as DoseEvent;
    return {
      ...base,
      status: "BLOCKED",
      violation_type: "DOUBLE_DOSE_LOCKED",
      severity: "CRITICAL",
      last_dose: { medication: last.medication, volume_ml: last.volumeMl ?? null, caregiver: last.caregiver, minutes_ago: interval.minutesAgo, at: new Date(last.at).toISOString(), time_label: fmtTime(last.at) },
      remaining_minutes: remaining,
      next_eligible_time: new Date(interval.nextEligibleAt).toISOString(),
    };
  }

  private async notifyLockAttempt(p: Patient, ingredient: string, i: IntervalResult) {
    if (i.status !== "DOUBLE_DOSE_LOCKED") return;
    const last = i.last as DoseEvent;
    await this.notifier?.send("LOCKOUT_ATTEMPT", `CareOS: blocked a repeat ${ingredient} dose for ${p.name}. ${last.caregiver} gave ${last.volumeMl ?? "?"} mL ${i.minutesAgo} min ago.`);
  }

  // --------------------------------------------------------------- logging
  async logAdministrationEvent(a: { patient_id: string; caregiver_name: string; medication: string; volume_ml: number; temperature_f?: number; idempotency_key?: string }): Promise<Payload> {
    const p = await this.patient(a.patient_id);
    const now = this.now();
    const drug = lookupDrug(a.medication);

    // A retry of an already-recorded dose must return the original outcome, not trip the lock it created.
    if (a.idempotency_key) {
      const prior = await this.storage.getEventByKey(a.idempotency_key);
      if (prior && prior.patientId === p.id) {
        const rule = intervalRuleFor(prior.ingredient);
        const inv = (await this.storage.getInventory()).find((i) => i.ingredient === prior.ingredient && i.unit === "mL");
        return {
          status: "LOGGED",
          replay: true,
          event_id: prior.eventId,
          next_eligible_time: new Date(prior.at + rule.minIntervalHours * H).toISOString(),
          bottle_remaining_ml: inv?.remaining ?? null,
          low_stock: inv ? inv.remaining < inv.lowThreshold : false,
          suggested_restock_items: inv && inv.remaining < inv.lowThreshold ? [inv.name] : [],
          sns_message_id: null,
          card_type: null,
        };
      }
    }

    // Re-verify server-side so a model that skips verify_medication_safety cannot bypass it.
    const verdict = await this.verifyMedicationSafety({ patient_id: p.id, proposed_medication: a.medication, administration_intent: true });
    if (verdict.status === "BLOCKED") {
      return { ...verdict, status: verdict.violation_type === "DOUBLE_DOSE_LOCKED" || verdict.violation_type === "DAILY_MAX" ? "REJECTED_LOCKED" : "REJECTED_UNSAFE" };
    }
    const ingredient = drug!.ingredient;

    // An infant dose may never exceed the weight-based target.
    if (p.kind === "infant" && p.weightLbs) {
      const f = inferFormulation(a.medication, ingredient);
      if (f) {
        const maxMg = Math.min(p.weightLbs * LBS_TO_KG * f.mgPerKg, f.maxSingleMg);
        if (a.volume_ml * f.mgPerMl > maxMg + 0.01) {
          return { status: "REJECTED_OVERDOSE", reason: `${a.volume_ml} mL of ${f.label} exceeds the weight-based maximum for ${p.name}.`, max_volume_ml: Math.floor(maxMg / f.mgPerMl / 0.25) * 0.25, card_type: null };
        }
      }
    }

    const rule = intervalRuleFor(ingredient);
    const inv = (await this.storage.getInventory()).find((i) => i.ingredient === ingredient && i.unit === "mL");
    const override = await this.storage.getOverride(p.id, ingredient);
    const event: DoseEvent = {
      eventId: randomUUID(),
      patientId: p.id,
      ingredient,
      medication: a.medication,
      caregiver: a.caregiver_name,
      at: now,
      volumeMl: a.volume_ml,
      temperatureF: a.temperature_f,
      idempotencyKey: a.idempotency_key ?? randomUUID(),
    };
    const res = await this.storage.commitDose({ event, rule, inventoryItemId: inv?.id, now, bypassLock: override !== undefined && override > now });

    if (!res.ok) {
      if (res.reason === "INSUFFICIENT_STOCK") return { status: "REJECTED_STOCK", reason: "Not enough medication left in the bottle.", card_type: null };
      // Lost a race with another caregiver: same intercept card as a pre-check hit.
      if (res.interval && res.interval.status !== "CLEAR") {
        await this.notifyLockAttempt(p, ingredient, res.interval);
        return { ...this.lockPayload(p, ingredient, res.interval), status: "REJECTED_LOCKED" };
      }
      return { status: "REJECTED_LOCKED", card_type: "DOUBLE_DOSE_INTERCEPT" };
    }

    let messageId: string | undefined;
    if (!res.replay) {
      const vol = a.volume_ml ? `${a.volume_ml.toFixed(1)} mL ` : "";
      messageId = await this.notifier?.send("DOSE_LOGGED", `CareOS: ${vol}${a.medication} administered to ${p.name} by ${a.caregiver_name} at ${fmtTime(res.event.at)}.`);
    }
    return {
      status: "LOGGED",
      replay: res.replay,
      event_id: res.event.eventId,
      next_eligible_time: new Date(res.event.at + rule.minIntervalHours * H).toISOString(),
      bottle_remaining_ml: res.inventoryRemaining ?? null,
      low_stock: res.lowStock,
      suggested_restock_items: res.lowStock && inv ? [inv.name] : [],
      sns_message_id: messageId ?? null,
      card_type: null,
    };
  }

  // ---------------------------------------------------------------- pantry
  async queryPantryRemedies(a: { patient_id: string; symptom: Symptom }): Promise<Payload> {
    const p = await this.patient(a.patient_id);
    const inv = await this.storage.getInventory();
    const pantry = inv.filter((i) => i.unit === "pantry" && i.remaining > 0).map((i) => i.id);
    const ageMonths = Math.floor((this.now() - p.dobMs) / (30.4 * DAY));
    const r = findRemedy(a.symptom, pantry, { ageMonths, activeRx: p.activeRx, conditions: p.conditions });
    if (r.status === "NO_SAFE_MATCH") return { status: "NO_SAFE_MATCH", excluded_items: r.excluded, card_type: null };
    return {
      status: "MATCH_FOUND",
      remedy_title: r.title,
      available_ingredients: r.availableIngredients,
      preparation_steps: r.steps,
      safety_badges: r.safetyBadges.map((b) => `${b} for ${p.name}'s profile`),
      excluded_items: r.excluded,
      card_type: "PANTRY_REMEDY",
    };
  }

  // ------------------------------------------------------------------ cart
  async stageAmazonCart(a: { requested_items: { item_name: string; channel: "prime" | "pharmacy" | "fresh" }[] }): Promise<Payload> {
    const lines: Cart["lines"] = [];
    const unavailable: string[] = [];
    for (const it of a.requested_items) {
      const c = findCatalogEntry(it.item_name);
      if (!c) { unavailable.push(it.item_name); continue; }
      if (!lines.some((l) => l.itemName === c.name)) lines.push({ itemName: c.name, channel: c.channel, priceUsd: c.priceUsd, merchantLabel: c.merchantLabel });
    }
    if (lines.length === 0) return { status: "NOTHING_STAGED", unavailable_items: unavailable, card_type: null };
    const totalUsd = Math.round(lines.reduce((s, l) => s + l.priceUsd, 0) * 100) / 100;
    const cart: Cart = { cartId: `cart_${randomUUID().slice(0, 8)}`, lines, totalUsd, eta: "Tomorrow by 8:00 AM", status: "STAGED" };
    await this.storage.saveCart(cart);
    return {
      status: "STAGED",
      cart_id: cart.cartId,
      items: lines.map((l) => ({ name: l.itemName, channel: l.channel, merchant: l.merchantLabel, price_usd: l.priceUsd })),
      total_usd: totalUsd,
      eta: cart.eta,
      confirm_phrase: "Alexa, confirm restock order",
      unavailable_items: unavailable,
      card_type: "AMAZON_RESTOCK_CAROUSEL",
    };
  }

  async confirmAmazonOrder(a: { cart_id: string }): Promise<Payload> {
    const cart = await this.storage.getCart(a.cart_id);
    if (!cart) return { status: "NOT_FOUND", card_type: null };
    if (cart.status === "ORDERED") return { status: "ORDER_PLACED", order_id: cart.orderId, already_ordered: true, total_usd: cart.totalUsd, eta: cart.eta, card_type: null };
    cart.status = "ORDERED";
    cart.orderId = `ord_${randomUUID().slice(0, 8)}`;
    await this.storage.saveCart(cart);
    return { status: "ORDER_PLACED", simulated: true, order_id: cart.orderId, total_usd: cart.totalUsd, eta: cart.eta, card_type: null };
  }

  // -------------------------------------------------------------- override
  async overrideLockout(a: { patient_id: string; ingredient: string; caregiver: string; pin: string }): Promise<Payload> {
    const p = await this.patient(a.patient_id);
    const now = this.now();
    const ingredient = lookupDrug(a.ingredient)?.ingredient ?? a.ingredient.toLowerCase();
    const fail = this.pinFailures.get(a.caregiver) ?? { count: 0, until: 0 };
    if (fail.until > now) return { status: "OVERRIDE_DENIED", reason: "Too many wrong PINs. Try again in a few minutes.", card_type: null };

    const given = sha(a.pin);
    if (!timingSafeEqual(given, this.pinHash)) {
      fail.count += 1;
      if (fail.count >= MAX_PIN_FAILURES) { fail.until = now + OVERRIDE_WINDOW_MS; fail.count = 0; }
      this.pinFailures.set(a.caregiver, fail);
      return { status: "OVERRIDE_DENIED", reason: "Incorrect PIN.", card_type: null };
    }
    this.pinFailures.delete(a.caregiver);
    await this.storage.setOverride(p.id, ingredient, now + OVERRIDE_WINDOW_MS);
    await this.notifier?.send("OVERRIDE_USED", `CareOS: ${a.caregiver} overrode the ${ingredient} lock for ${p.name}.`);
    return { status: "OVERRIDE_GRANTED", expires_at: new Date(now + OVERRIDE_WINDOW_MS).toISOString(), card_type: null };
  }

  // ------------------------------------------------------------- resources
  async patientSnapshot(id: string) {
    const p = await this.patient(id);
    const now = this.now();
    const ledger = await this.storage.getLedger(p.id);
    const ingredients = [...new Set(ledger.map((e) => e.ingredient))];
    const locks = ingredients.map((ing) => {
      const r = checkInterval(ledger, ing, intervalRuleFor(ing), now);
      return { ingredient: ing, status: r.status, next_eligible_time: new Date(r.nextEligibleAt).toISOString() };
    });
    return { profile: { ...p, age_days: Math.floor((now - p.dobMs) / DAY), weight_kg: p.weightLbs ? Math.round(lbsToKg(p.weightLbs) * 100) / 100 : null }, medication_history: ledger, active_locks: locks.filter((l) => l.status !== "CLEAR") };
  }
}
