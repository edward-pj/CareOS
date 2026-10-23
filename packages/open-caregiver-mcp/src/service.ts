import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { CardType, Payload, PlanPayload } from "./contracts.js";
import { LABEL_REGISTRY, type LabelSku } from "./data/labelRegistry.js";
import { checkInterval } from "./engines/intervalLock.js";
import { lbToKg, plausibleWeightKg, weightIsPlausible, kgToLb } from "./engines/labelDoseEngine.js";
import { findRemedy, type Symptom } from "./engines/pantryEngine.js";
import { planMedication, type PlanRequest } from "./engines/planMedication.js";
import { resolveProduct } from "./engines/productResolver.js";
import { verifyDrugSafety, type PatientClinical } from "./engines/safetyMatrix.js";
import { clock, firstName, fmtNumber, plural } from "./engines/speech.js";
import { EscalationService, type EscalationOptions } from "./escalation.js";
import { PrescriptionService } from "./prescriptions.js";
import type { ImageStore, VisionProvider } from "./providers/vision.js";
import { ShopService, type ShopEvent } from "./shop.js";
import type { ShopTimeline } from "./engines/shopTimeline.js";
import type { AuditEntry, Caregiver, DoseEvent, InventoryItem, Notifier, ObservationType, Patient, StorageAdapter } from "./storage/types.js";

export type { CardType, Payload, PlanPayload } from "./contracts.js";

const DAY = 86_400_000;
const H = 3_600_000;
/** A read-back confirmation is good for this long. */
const CONFIRMATION_TTL_MS = 5 * 60_000;
/** "I gave it 20 minutes ago" is honoured up to this far back. Older than this needs a clinician's judgement, not a log entry. */
const MAX_BACKDATE_MINUTES = 12 * 60;

export interface ServiceOptions {
  clock?: () => number;
  notifier?: Notifier;
  /** Scopes confirmation tokens to a household. */
  householdId?: string;
  /**
   * Key for read-back confirmation tokens. Set the same value on every instance (CAREOS_SIGNING_SECRET) when running
   * more than one replica; otherwise a random per-process key is used and a token only works on the instance that issued it.
   */
  signingSecret?: string;
  /** Simulated fulfilment schedule for the Amazon cart (defaults to a ~1 minute demo clock). */
  shopTimeline?: ShopTimeline;
  /** Receives every shopping change (cart, order, delivery, bottle level) so open screens can update live. */
  onShopEvent?: (e: ShopEvent) => void;
  /** Emergency numbers and units: "US" (default) or "IN". */
  locale?: EscalationOptions["locale"];
  /** Where the household is, for the nearby-hospitals search. Defaults to a labelled demo point. */
  origin?: EscalationOptions["origin"];
  /** Hospital search. Defaults to a labelled sample-data fixture; swap in Amazon Location when the account allows it. */
  hospitals?: EscalationOptions["hospitals"];
  /** Reads prescription and bottle-label photos (Gemini today). Without it, photo tools say they are unavailable. */
  vision?: VisionProvider;
  /** Where uploaded images wait to be read, scoped to this household. */
  images?: ImageStore;
}

const PROCESS_SECRET = randomBytes(32).toString("hex");

export function normalizePatientId(id: string): string {
  return id.trim().toLowerCase().replace(/^(infant|elder)_/, "");
}

/** Interval + daily-count rule for an ingredient, from the strictest label that governs it. */
export function intervalRuleFor(ingredient: string) {
  const skus = LABEL_REGISTRY.filter((s) => s.limitIngredient === ingredient);
  if (skus.length === 0) return { minIntervalHours: 6, maxDosesPer24h: 4 };
  return {
    minIntervalHours: Math.max(...skus.map((s) => s.intervalHours)),
    maxDosesPer24h: Math.min(...skus.map((s) => s.maxDosesPer24h)),
  };
}

export interface CallContext {
  /** The caregiver the bearer token belongs to: the default for "who is giving this dose". */
  caregiverId?: string;
}

const GENERIC_PATIENT_WORDS = new Set(["", "baby", "the baby", "child", "the child", "kid", "the kid", "him", "her", "he", "she", "patient", "them", "someone"]);
const sku_ingredient = (plan: Record<string, unknown>) => String(plan.ingredient ?? "medicine");
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);

export class CareService {
  private clock: () => number;
  private notifier?: Notifier;
  private scope: string;
  private secret: string;
  /** Orders audit rows written in the same millisecond (the id is the tie-break in every backend). */
  private auditSeq = 0;
  /** The simulated Amazon storefront: one shared cart, orders, deliveries that refill the bottles. */
  readonly shop: ShopService;
  /** Triage, the emergency card, and the nurse-line / doctor summaries. */
  readonly escalation: EscalationService;
  /** Prescription photos (pending until a person confirms) and Label Lens. */
  readonly prescriptions: PrescriptionService;

  constructor(readonly storage: StorageAdapter, opts: ServiceOptions = {}) {
    this.clock = opts.clock ?? Date.now;
    this.notifier = opts.notifier;
    this.escalation = new EscalationService(
      {
        storage,
        now: () => this.clock(),
        notifier: opts.notifier,
        resolvePatient: (ref) => this.resolvePatient(ref),
        audit: (tool, p, caregiver, inputs, payload) => this.audit(tool, p, caregiver, inputs, payload),
        actorName: async (id) => {
          if (!id) return "Someone";
          const k = id.trim().toLowerCase();
          return (await storage.getCaregivers()).find((c) => c.id === k || c.name.toLowerCase() === k || firstName(c.name).toLowerCase() === k)?.name ?? id;
        },
      },
      { locale: opts.locale, origin: opts.origin, hospitals: opts.hospitals },
    );
    this.prescriptions = new PrescriptionService({
      storage,
      now: () => this.clock(),
      vision: opts.vision,
      images: opts.images,
      resolvePatient: (ref) => this.resolvePatient(ref),
      audit: (tool, p, caregiver, inputs, payload) => this.audit(tool, p, caregiver, inputs, payload),
    });
    this.shop = new ShopService(storage, { clock: () => this.clock(), timeline: opts.shopTimeline, notifier: opts.notifier, onEvent: opts.onShopEvent });
    this.scope = opts.householdId ?? "demo";
    this.secret = opts.signingSecret ?? process.env.CAREOS_SIGNING_SECRET ?? PROCESS_SECRET;
  }

  now() { return this.clock(); }

  /** Strict lookup by id (used by REST and resources). Throws for unknown ids. */
  async patient(id: string): Promise<Patient> {
    const p = await this.storage.getPatient(normalizePatientId(id));
    if (!p) throw new Error(`Unknown patient "${id}".`);
    return p;
  }

  // ---------------------------------------------------------------- identity (S7, H4)

  /**
   * Which person is this about? Never defaults to "the baby": a missing, generic or unknown reference is a question
   * back to the caller whenever more than one person lives in the household.
   */
  async resolvePatient(ref: string | undefined): Promise<{ patient: Patient } | { ask: PlanPayload }> {
    const all = await this.storage.listPatients();
    const text = normalizePatientId(ref ?? "");
    const byId = all.find((p) => p.id === text);
    const byName = all.find((p) => p.name.toLowerCase() === text || p.name.toLowerCase().split(/\s+/)[0] === text);
    const hit = byId ?? byName;
    if (hit) return { patient: hit };
    if (all.length === 1 && GENERIC_PATIENT_WORDS.has(text)) return { patient: all[0]! };

    const names = all.map((p) => p.name);
    const question = names.length === 0 ? "I don't have anyone set up yet." : `Who is this for: ${names.join(" or ")}?`;
    return {
      ask: {
        patient_id: "",
        patient_name: "",
        status: "NEEDS_INFO",
        card_type: "NEEDS_INFO",
        missing: "patient",
        question,
        options: names,
        speech: question,
        reason_codes: [GENERIC_PATIENT_WORDS.has(text) ? "PATIENT_AMBIGUOUS" : "PATIENT_UNKNOWN"],
        sources: [],
        read_verbatim: true,
      },
    };
  }

  /** Who is giving the dose? An explicit reference wins, then the token's caregiver; otherwise ask. */
  private async resolveCaregiver(ref: string | undefined, ctx: CallContext): Promise<{ caregiver: Caregiver } | { ask: PlanPayload }> {
    const all = await this.storage.getCaregivers();
    const norm = (s: string) => s.trim().toLowerCase();
    const want = ref && ref.trim() ? norm(ref) : undefined;
    const find = (w: string) => all.find((c) => c.id === w || norm(c.name) === w || norm(firstName(c.name)) === w);
    const hit = want ? find(want) : ctx.caregiverId ? find(norm(ctx.caregiverId)) : undefined;
    if (hit) return { caregiver: hit };
    const names = all.map((c) => firstName(c.name));
    const question = "Who's giving this dose?";
    return {
      ask: { patient_id: "", patient_name: "", status: "NEEDS_INFO", card_type: "NEEDS_INFO", missing: "caregiver", question, options: names, speech: question, reason_codes: ["CAREGIVER_UNKNOWN"], sources: [], read_verbatim: true },
    };
  }

  // ---------------------------------------------------------------- audit

  private async audit(tool: string, p: Patient | undefined, caregiver: string | undefined, inputs: unknown, payload: Payload) {
    const reasonCodes = Array.isArray(payload.reason_codes) ? (payload.reason_codes as string[]) : [];
    const entry: AuditEntry = { id: `${String(++this.auditSeq).padStart(8, "0")}-${randomUUID().slice(0, 8)}`, at: this.now(), tool, patientId: p?.id, caregiver, inputHash: hash(inputs), verdict: payload.status, reasonCodes };
    // An audit failure must never turn a safe answer into an error, but it must never be silent either.
    await this.storage.appendAudit(entry).catch((e) => console.error(`[audit] failed to record ${tool}:`, e));
  }

  // ---------------------------------------------------------------- plan_medication

  async planMedication(
    a: {
      patient_id: string;
      product: string;
      symptom?: string;
      weight_value?: number;
      weight_unit?: "lb" | "kg";
      last_dose_elsewhere?: "none_today" | "gave_earlier" | "unknown";
      elsewhere_minutes_ago?: number;
      bottle_concentration?: string;
      bottle_expires?: string;
    },
    ctx: CallContext = {},
  ): Promise<PlanPayload> {
    const who = await this.resolvePatient(a.patient_id);
    if ("ask" in who) {
      await this.audit("plan_medication", undefined, ctx.caregiverId, a, who.ask);
      return who.ask;
    }
    const p = who.patient;
    const now = this.now();

    // S3: a dose the caregiver says was given elsewhere is recorded now, so the lock holds even if nobody mentions it again.
    if (a.last_dose_elsewhere === "gave_earlier" && a.elsewhere_minutes_ago !== undefined) {
      await this.recordElsewhere(p, a.product, a.elsewhere_minutes_ago, now);
    }

    // An open episode can rule out home dosing (a vomited dose, a feverish newborn): say so before any number is computed.
    const hold = await this.escalation.homeDosingHold(p.id);
    if (hold) {
      const out: PlanPayload = {
        patient_id: p.id, patient_name: p.name, status: "NEEDS_CLINICIAN", card_type: null, violation_type: "EPISODE_NO_HOME_DOSING",
        speech: `I'm not giving a dose for ${p.name} right now. Please call your nurse line or pediatrician first.`,
        followup: "This is because of the warning sign you reported earlier. A clinician needs to say what to do.",
        reason_codes: ["EPISODE_NO_HOME_DOSING", ...hold.ruleIds], sources: [], read_verbatim: true,
      };
      await this.audit("plan_medication", p, ctx.caregiverId, a, out);
      return out;
    }

    const request: PlanRequest = {
      product: a.product,
      symptom: a.symptom,
      reportedWeight: a.weight_value !== undefined ? { value: a.weight_value, unit: a.weight_unit } : undefined,
      lastDoseElsewhere: a.last_dose_elsewhere,
      elsewhereMinutesAgo: a.elsewhere_minutes_ago,
      bottleConcentration: a.bottle_concentration,
      bottleExpires: a.bottle_expires,
    };
    const outcome = planMedication({ now, patient: p, ledger: await this.storage.getLedger(p.id), request, houseSkus: await this.houseSkus() });

    if (outcome.weightToRecord) await this.persistWeight(p, outcome.weightToRecord.lb, outcome.weightToRecord.reportedValue, outcome.weightToRecord.reportedUnit, now, ctx.caregiverId ?? "caregiver");

    const out = outcome.payload;
    if (out.status === "BLOCKED" && out.violation_type === "DOUBLE_DOSE_LOCKED") {
      const last = out.last_dose as { caregiver: string; minutes_ago: number };
      await this.notifier?.send("LOCKOUT_ATTEMPT", `CareOS: blocked a repeat ${String(out.ingredient)} dose for ${p.name}. ${last.caregiver} gave it ${last.minutes_ago} min ago.`);
    } else if ((out.status === "BLOCKED" || out.status === "ALTERNATE_SUGGESTED") && out.severity === "CRITICAL") {
      await this.notifier?.send("CRITICAL_BLOCK", `CareOS: blocked ${a.product} for ${p.name} (${String(out.clinical_rationale)})`);
    }
    await this.audit("plan_medication", p, ctx.caregiverId, a, out);
    return out;
  }

  /** Registry skus the household has a (non-empty) bottle of. */
  private async houseSkus(): Promise<string[]> {
    return (await this.storage.getInventory()).filter((i) => i.sku && i.remaining > 0).map((i) => i.sku!);
  }

  /** Records "it was given elsewhere N minutes ago" as a real ledger entry. Never decrements a bottle in this house. */
  private async recordElsewhere(p: Patient, product: string, minutesAgo: number, now: number) {
    if (!(minutesAgo >= 0 && minutesAgo <= 24 * 60)) return;
    const r = resolveProduct(product, p.kind, undefined, await this.houseSkus());
    if (r.kind !== "sku") return;
    const at = now - Math.round(minutesAgo) * 60_000;
    const event: DoseEvent = {
      eventId: randomUUID(),
      patientId: p.id,
      ingredient: r.sku.limitIngredient,
      medication: `${r.sku.spokenName} (given elsewhere)`,
      sku: r.sku.sku,
      caregiver: "Given elsewhere",
      at,
      idempotencyKey: `elsewhere:${p.id}:${r.sku.limitIngredient}:${Math.floor(at / 60_000)}`,
    };
    await this.storage.commitDose({ event, rule: { minIntervalHours: r.sku.intervalHours, maxDosesPer24h: r.sku.maxDosesPer24h }, now });
  }

  private async persistWeight(p: Patient, lb: number, reportedValue: number, reportedUnit: "lb" | "kg", now: number, source: string) {
    await this.storage.addObservation({ id: randomUUID(), patientId: p.id, type: "weight", value: reportedValue, unit: reportedUnit, at: now, source });
    await this.storage.setPatientWeight(p.id, lb, now);
  }

  // ---------------------------------------------------------------- confirm_dose_given

  private sign(parts: (string | number)[]): string {
    return createHmac("sha256", this.secret).update([this.scope, ...parts].join("|")).digest("hex");
  }

  async confirmDoseGiven(
    a: {
      patient_id: string;
      product: string;
      caregiver_id?: string;
      /** Defaults to the verified dose. Anything larger is refused. */
      amount?: number;
      given_minutes_ago?: number;
      confirmation_token?: string;
      bottle_concentration?: string;
      bottle_expires?: string;
    },
    ctx: CallContext = {},
  ): Promise<Payload> {
    const who = await this.resolvePatient(a.patient_id);
    if ("ask" in who) return who.ask;
    const p = who.patient;

    const cg = await this.resolveCaregiver(a.caregiver_id, ctx);
    if ("ask" in cg) { await this.audit("confirm_dose_given", p, undefined, a, cg.ask); return { ...cg.ask, patient_id: p.id, patient_name: p.name }; }
    const caregiver = cg.caregiver;

    const minutesAgo = Math.round(a.given_minutes_ago ?? 0);
    if (!(minutesAgo >= 0 && minutesAgo <= MAX_BACKDATE_MINUTES)) {
      const out = this.reject(p, "REJECTED_TIME", `I can only log a dose given in the last ${plural(MAX_BACKDATE_MINUTES / 60, "hour")}. For anything earlier, please tell the nurse line or your pediatrician.`, ["GIVEN_AT_OUT_OF_RANGE"]);
      await this.audit("confirm_dose_given", p, caregiver.name, a, out);
      return out;
    }

    const now = this.now();

    // A retry of a confirmation that already succeeded must replay the original outcome, not trip the lock it created.
    // Checked up front AND again before any refusal is returned: a retry that races the original can re-plan after the
    // original has landed, see the original's own lock, and must still be told "already logged", not "locked".
    const retrySig = a.confirmation_token?.split(".")[1] ?? "";
    const replayIfLogged = async (): Promise<Payload | undefined> => {
      if (!retrySig) return undefined;
      const prior = await this.storage.getEventByKey(`dose-${retrySig.slice(0, 24)}`);
      const priorSku = prior?.sku ? LABEL_REGISTRY.find((x) => x.sku === prior.sku) : undefined;
      if (!prior || prior.patientId !== p.id || !priorSku) return undefined;
      const bottle = priorSku.kind === "liquid" ? await this.bottleFor(priorSku) : undefined;
      return this.loggedPayload(p, priorSku, prior, { replay: true, remaining: bottle?.remaining, lowStock: bottle ? bottle.remaining < bottle.lowThreshold : false, bottle });
    };
    const early = await replayIfLogged();
    if (early) return early;

    // Re-run the whole pipeline server-side: nothing is logged on the strength of an earlier answer alone.
    const hold = await this.escalation.homeDosingHold(p.id);
    if (hold) {
      const out = this.reject(p, "REJECTED_EPISODE_HOLD", `I can't log or plan a dose for ${p.name} right now. Please call your nurse line or pediatrician first.`, ["EPISODE_NO_HOME_DOSING", ...hold.ruleIds]);
      await this.audit("confirm_dose_given", p, caregiver.name, a, out);
      return out;
    }
    const replanned = planMedication({
      now,
      patient: p,
      ledger: await this.storage.getLedger(p.id),
      request: { product: a.product, lastDoseElsewhere: "none_today", bottleConcentration: a.bottle_concentration, bottleExpires: a.bottle_expires },
      houseSkus: await this.houseSkus(),
    });
    const plan = replanned.payload;
    if (plan.status !== "APPROVED" || !replanned.sku) {
      const raced = await replayIfLogged();
      if (raced) return raced;
      // Say WHY it was refused: a lock is not the same as an unsafe combination.
      const locked = plan.violation_type === "DOUBLE_DOSE_LOCKED" || plan.violation_type === "DAILY_MAX";
      if (plan.violation_type === "DOUBLE_DOSE_LOCKED") {
        const last = plan.last_dose as { caregiver: string; minutes_ago: number };
        await this.notifier?.send("LOCKOUT_ATTEMPT", `CareOS: ${caregiver.name} tried to log a repeat ${sku_ingredient(plan)} dose for ${p.name}. ${last.caregiver} gave it ${last.minutes_ago} min ago.`);
      }
      const out = { ...plan, status: plan.status === "NEEDS_INFO" ? "NEEDS_INFO" : locked ? "REJECTED_LOCKED" : "REJECTED_UNSAFE" } as PlanPayload;
      await this.audit("confirm_dose_given", p, caregiver.name, a, out);
      return out;
    }
    const sku = replanned.sku;
    const planned = sku.kind === "liquid" ? (plan.dispense_volume_ml as number) : (plan.dose_units as number);
    const amount = a.amount ?? planned;
    const unitWord = sku.kind === "liquid" ? "mL" : sku.unit.plural;
    if (!(amount > 0) || amount > planned + 1e-9) {
      const out = this.reject(p, "REJECTED_OVERDOSE", `I can't log more than the verified dose of ${fmtNumber(planned)} ${unitWord}. Please check what was actually given.`, ["AMOUNT_EXCEEDS_VERIFIED_DOSE"], sku.source.id);
      await this.audit("confirm_dose_given", p, caregiver.name, a, out);
      return out;
    }

    const amountKey = fmtNumber(amount);
    const givenLabel = minutesAgo === 0 ? "just now" : `${plural(minutesAgo, "minute")} ago`;
    const doseDisplay = sku.kind === "liquid" ? `${amountKey} mL` : `${amountKey} ${amount === 1 ? sku.unit.singular : sku.unit.plural}`;
    const spokenAmount = sku.kind === "liquid" ? `${amountKey} milliliters` : `${amountKey} ${amount === 1 ? sku.unit.singular : sku.unit.plural}`;

    // ---- step 1: read back and ask. Nothing is written.
    if (!a.confirmation_token) {
      const issuedAt = now;
      const sig = this.sign([p.id, sku.sku, caregiver.id, amountKey, minutesAgo, issuedAt]);
      const out: Payload = {
        status: "NEEDS_CONFIRMATION",
        card_type: "CONFIRM_DOSE",
        patient_id: p.id,
        patient_name: p.name,
        product_spoken: sku.spokenName,
        dose_display: doseDisplay,
        given_by: firstName(caregiver.name),
        given_label: givenLabel,
        confirmation_token: `${issuedAt}.${sig}`,
        expires_in_seconds: CONFIRMATION_TTL_MS / 1000,
        speech: `Logging ${spokenAmount} of ${sku.spokenName} for ${p.name}, given by ${firstName(caregiver.name)} ${givenLabel}. Is that correct?`,
        followup: "Say yes to log it, or tell me what to change.",
        reason_codes: ["READ_BACK_REQUIRED"],
        sources: [sku.source.id],
        read_verbatim: true,
      };
      await this.audit("confirm_dose_given", p, caregiver.name, a, out);
      return out;
    }

    // ---- step 2: the token must be ours, fresh, and for exactly these parameters.
    const [issuedRaw = "", sig = ""] = a.confirmation_token.split(".");
    const issuedAt = Number(issuedRaw);
    const expected = this.sign([p.id, sku.sku, caregiver.id, amountKey, minutesAgo, issuedAt]);
    const valid = Number.isFinite(issuedAt) && sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!valid || now - issuedAt > CONFIRMATION_TTL_MS || issuedAt > now + 60_000) {
      const out = this.reject(p, "REJECTED_CONFIRMATION", "That confirmation has expired or doesn't match. Let's start again: tell me what was given.", ["CONFIRMATION_INVALID_OR_EXPIRED"], sku.source.id);
      await this.audit("confirm_dose_given", p, caregiver.name, a, out);
      return out;
    }

    const givenAt = issuedAt - minutesAgo * 60_000;
    const mgPerUnit = sku.kind === "liquid" ? sku.mgPerMl : sku.mgPerUnit;
    const bottle = sku.kind === "liquid" ? await this.bottleFor(sku) : undefined;
    const event: DoseEvent = {
      eventId: randomUUID(),
      patientId: p.id,
      ingredient: sku.limitIngredient,
      medication: sku.spokenName,
      sku: sku.sku,
      caregiver: caregiver.name,
      at: givenAt,
      volumeMl: sku.kind === "liquid" ? amount : undefined,
      amountMg: Math.round(amount * mgPerUnit * 1000) / 1000,
      // Derived from the signature, so a retry of the same confirmation is the same dose.
      idempotencyKey: `dose-${sig.slice(0, 24)}`,
    };
    const res = await this.storage.commitDose({ event, rule: { minIntervalHours: sku.intervalHours, maxDosesPer24h: sku.maxDosesPer24h }, inventoryItemId: bottle?.id, now });

    if (!res.ok) {
      if (res.reason === "INSUFFICIENT_STOCK") {
        const out = this.reject(p, "REJECTED_STOCK", "There isn't enough left in the bottle for that dose. Please check the bottle.", ["INSUFFICIENT_STOCK"], sku.source.id);
        await this.audit("confirm_dose_given", p, caregiver.name, a, out);
        return out;
      }
      const raced = await replayIfLogged();
      if (raced) return raced;
      // Lost a race with another caregiver (or the lock tightened): render the same intercept the plan step would.
      const again = planMedication({ now, patient: p, ledger: await this.storage.getLedger(p.id), request: { product: a.product, lastDoseElsewhere: "none_today" }, houseSkus: await this.houseSkus() }).payload;
      const out = { ...again, status: "REJECTED_LOCKED" } as PlanPayload;
      await this.notifier?.send("LOCKOUT_ATTEMPT", `CareOS: blocked a repeat ${sku.limitIngredient} dose for ${p.name}.`);
      await this.audit("confirm_dose_given", p, caregiver.name, a, out);
      return out;
    }

    if (!res.replay) await this.escalation.noteOnEpisode(p.id, "DOSE", `${sku.spokenName} ${doseDisplay} given by ${firstName(caregiver.name)}`).catch(() => undefined);
    if (!res.replay && bottle && res.inventoryRemaining !== undefined) {
      this.shop.noteInventory({ id: bottle.id, name: bottle.name, remaining: res.inventoryRemaining, lowThreshold: bottle.lowThreshold }, caregiver.name);
    }
    let messageId: string | undefined;
    if (!res.replay) {
      const next = res.event.at + sku.intervalHours * H;
      messageId = await this.notifier?.send("DOSE_LOGGED", `CareOS: ${doseDisplay} ${sku.spokenName} given to ${p.name} by ${firstName(caregiver.name)} at ${clock(res.event.at)}. Next allowed after ${clock(next)}.`);
    }
    const out = this.loggedPayload(p, sku, res.event, { replay: res.replay, remaining: res.inventoryRemaining, lowStock: res.lowStock, bottle, messageId });
    await this.audit("confirm_dose_given", p, caregiver.name, a, out);
    return out;
  }

  private loggedPayload(p: Patient, sku: LabelSku, ev: DoseEvent, x: { replay: boolean; remaining?: number; lowStock: boolean; bottle?: InventoryItem; messageId?: string }): Payload {
    const next = ev.at + sku.intervalHours * H;
    const shown = sku.kind === "liquid" ? `${fmtNumber(ev.volumeMl ?? 0)} mL` : `${fmtNumber((ev.amountMg ?? 0) / sku.mgPerUnit)} ${sku.unit.plural}`;
    return {
      status: "LOGGED",
      card_type: null,
      patient_id: p.id,
      patient_name: p.name,
      replay: x.replay,
      event_id: ev.eventId,
      dose_display: shown,
      next_eligible_time: new Date(next).toISOString(),
      next_eligible_label: clock(next),
      bottle_remaining_ml: x.remaining ?? null,
      low_stock: x.lowStock,
      suggested_restock_items: x.lowStock && x.bottle ? [x.bottle.name] : [],
      sns_message_id: x.messageId ?? null,
      speech: x.replay ? `That dose was already logged. The next ${sku.spokenName} is allowed after ${clock(next)}.` : `Logged. The next ${sku.spokenName} for ${p.name} is allowed after ${clock(next)}.`,
      followup: x.lowStock && x.bottle ? `${x.bottle.name} is running low. Want me to add it to a restock order?` : undefined,
      reason_codes: [x.replay ? "IDEMPOTENT_REPLAY" : "DOSE_LOGGED", "LOCK_STARTED"],
      sources: [sku.source.id],
      read_verbatim: true,
    };
  }

  private reject(p: Patient, status: string, speech: string, codes: string[], source?: string): PlanPayload {
    return { status, card_type: null, patient_id: p.id, patient_name: p.name, speech, reason_codes: codes, sources: source ? [source] : [], read_verbatim: true };
  }

  /** The bottle in the house for this product: matched by sku, else by ingredient. */
  private async bottleFor(sku: LabelSku): Promise<InventoryItem | undefined> {
    const items = (await this.storage.getInventory()).filter((i) => i.unit === "mL");
    return items.find((i) => i.sku === sku.sku) ?? items.find((i) => i.sku === undefined && i.ingredient === sku.limitIngredient);
  }

  // ---------------------------------------------------------------- log_observation

  async logObservation(
    a: { patient_id: string; type: ObservationType; value: number; unit?: string; minutes_ago?: number },
    ctx: CallContext = {},
  ): Promise<PlanPayload> {
    const who = await this.resolvePatient(a.patient_id);
    if ("ask" in who) return who.ask;
    const p = who.patient;
    const now = this.now();
    const ageMonths = Math.max(0, Math.floor((now - p.dobMs) / (30.4375 * DAY)));
    const ask = (missing: string, question: string, codes: string[]): PlanPayload => ({ patient_id: p.id, patient_name: p.name, status: "NEEDS_INFO", card_type: "NEEDS_INFO", missing, question, options: [], speech: question, reason_codes: codes, sources: [], read_verbatim: true });
    const finish = async (out: PlanPayload) => { await this.audit("log_observation", p, ctx.caregiverId, a, out); return out; };

    const minutesAgo = a.minutes_ago ?? 0;
    if (!(minutesAgo >= 0 && minutesAgo <= 24 * 60)) return finish(ask("time", "How long ago was that measured? I can log up to 24 hours back.", ["OBSERVATION_TIME_INVALID"]));
    const at = now - Math.round(minutesAgo) * 60_000;
    if (!Number.isFinite(a.value)) return finish(ask("value", `What was ${p.name}'s ${a.type.replace("_", " ")}?`, ["OBSERVATION_VALUE_MISSING"]));

    let value = a.value;
    let unit = a.unit;
    let spoken = "";
    let note: string | undefined;
    let status: PlanPayload["status"] = "LOGGED";
    let followup: string | undefined;
    const codes: string[] = [];

    if (a.type === "temperature") {
      const u = (unit ?? (value >= 90 && value <= 110 ? "F" : value >= 32 && value <= 43 ? "C" : "")).toUpperCase().replace("°", "");
      if (u !== "F" && u !== "C") return finish(ask("unit", `Is ${p.name}'s temperature ${fmtNumber(value)} degrees Fahrenheit or Celsius?`, ["TEMPERATURE_UNIT_MISSING"]));
      const f = u === "F" ? value : value * 1.8 + 32;
      if (f < 93 || f > 108) return finish(ask("value", `${fmtNumber(value)} degrees ${u === "F" ? "Fahrenheit" : "Celsius"} looks unusual. Please check the thermometer and tell me the temperature again.`, ["TEMPERATURE_IMPLAUSIBLE"]));
      unit = u;
      spoken = `${fmtNumber(value)} degrees ${u === "F" ? "Fahrenheit" : "Celsius"}`;
      if (f >= 100.4 && Math.floor((now - p.dobMs) / DAY) < 84) {
        status = "NEEDS_CLINICIAN";
        followup = `${p.name} is too young to treat a fever at home. Please call your pediatrician or go to urgent care now.`;
        codes.push("INFANT_FEVER_UNDER_12_WEEKS");
      }
    } else if (a.type === "weight") {
      if (unit !== "lb" && unit !== "kg") return finish(ask("weight_unit", `Is ${p.name}'s weight ${fmtNumber(value)} pounds or ${fmtNumber(value)} kilograms?`, ["WEIGHT_UNIT_MISSING"]));
      const kg = unit === "kg" ? value : lbToKg(value);
      if (!weightIsPlausible(kg, ageMonths)) {
        const r = plausibleWeightKg(ageMonths);
        const q = ask("weight_confirm", `${fmtNumber(value)} ${unit === "kg" ? "kilograms" : "pounds"} looks unusual for ${p.name}. Please check the scale and tell me the weight and unit again.`, ["WEIGHT_IMPLAUSIBLE_FOR_AGE"]);
        return finish({ ...q, followup: `Typical range for this age is about ${r.min} to ${r.max} kilograms.` });
      }
      spoken = `${fmtNumber(value)} ${unit === "kg" ? "kilograms" : "pounds"}`;
      const lb = unit === "lb" ? value : kgToLb(value);
      await this.persistWeight(p, Math.round(lb * 100) / 100, value, unit, at, ctx.caregiverId ?? "caregiver");
      codes.push("WEIGHT_RECORDED");
    } else if (a.type === "glucose") {
      unit = unit ?? "mg/dL";
      if (unit !== "mg/dL" || value < 20 || value > 600) return finish(ask("value", `${fmtNumber(value)} doesn't look like a blood sugar in milligrams per deciliter. Please read the meter again.`, ["GLUCOSE_IMPLAUSIBLE"]));
      spoken = `${fmtNumber(value)} milligrams per deciliter`;
    } else {
      unit = "count";
      if (!Number.isInteger(value) || value < 0 || value > 20) return finish(ask("value", "How many wet diapers? Please give a whole number.", ["WET_DIAPERS_INVALID"]));
      spoken = plural(value, "wet diaper");
    }

    if (a.type !== "weight") {
      await this.storage.addObservation({ id: randomUUID(), patientId: p.id, type: a.type, value, unit: unit!, at, source: ctx.caregiverId ?? "caregiver" });
    }
    const label = a.type.replace("_", " ");
    const out: PlanPayload = {
      status,
      card_type: null,
      patient_id: p.id,
      patient_name: p.name,
      type: a.type,
      value,
      unit: unit!,
      at: new Date(at).toISOString(),
      speech: status === "NEEDS_CLINICIAN" ? `Logged ${p.name}'s ${label}: ${spoken}. That needs a clinician now.` : `Logged ${p.name}'s ${label}: ${spoken}.`,
      followup: followup ?? note,
      reason_codes: ["OBSERVATION_LOGGED", ...codes],
      sources: [],
      read_verbatim: true,
    };
    return finish(out);
  }

  // ---------------------------------------------------------------- household context + memory conflict guard

  /**
   * Who is in the house, what is locked, what is low, and what advice the house remembers.
   * Remembered advice is NEVER repeated as-is: each item is re-checked against today's chart (Memory Conflict Guard).
   */
  /** "Does Frank have diabetes?" Answers from the recorded conditions only. Not on record is reported as "no record", never as a medical claim. */
  async conditionCheck(patientRef: string | undefined, condition: string): Promise<Payload> {
    const who = await this.resolvePatient(patientRef);
    if ("ask" in who) return who.ask;
    const p = who.patient;
    const wanted = condition.trim();
    // Loose spelling is common when spoken ("diabates"): match on a short stem, and honour an explicit type ("type 1").
    const lower = wanted.toLowerCase().replace(/high blood pressure/g, "hypertension");
    const words = lower.split(/[^a-z0-9]+/).filter((w) => w.length > 2 && w !== "type").map((w) => w.slice(0, 4));
    const typed = /type\s*(\d)/.exec(lower)?.[1];
    const hit = p.conditions.find((c) => (typed ? c.startsWith(`type${typed}_`) : true) && words.some((w) => c.toLowerCase().includes(w)));
    const label = (c: string) => c.replace(/^type(\d)_/, "type $1 ").replace(/_/g, " ");
    return {
      status: "OK",
      card_type: null,
      patient_id: p.id,
      patient_name: p.name,
      condition_check: { condition: wanted, on_record: Boolean(hit), recorded_as: hit ? label(hit) : null },
      speech: hit ? `Yes. ${p.name} has ${label(hit)} on record.` : `No. There is no ${wanted} on ${p.name}'s record.`,
      reason_codes: [],
      sources: [],
      read_verbatim: true,
    };
  }

  async getHouseholdContext(a: { patient_id?: string; topic?: string; condition?: string } = {}, ctx: CallContext = {}): Promise<Payload> {
    if (a.condition) return this.conditionCheck(a.patient_id, a.condition);
    const now = this.now();
    let patients = await this.storage.listPatients();
    if (a.patient_id) {
      const who = await this.resolvePatient(a.patient_id);
      if ("ask" in who) return who.ask;
      patients = [who.patient];
    }
    const caregivers = await this.storage.getCaregivers();
    const inventory = await this.storage.getInventory();
    const advice = await this.storage.getAdvice(a.patient_id ? patients[0]!.id : undefined);

    const people = await Promise.all(patients.map(async (p) => {
      const ledger = await this.storage.getLedger(p.id);
      const ageMonths = Math.max(0, Math.floor((now - p.dobMs) / (30.4375 * DAY)));
      const ingredients = [...new Set(ledger.map((e) => e.ingredient))];
      const locks = ingredients
        .map((ing) => ({ ing, r: checkInterval(ledger, ing, intervalRuleFor(ing), now) }))
        .filter((x) => x.r.status !== "CLEAR")
        .map((x) => ({ ingredient: x.ing, status: x.r.status, next_eligible_time: new Date(x.r.nextEligibleAt).toISOString() }));
      return {
        id: p.id,
        name: p.name,
        kind: p.kind,
        age_months: ageMonths,
        weight_lb: p.weightLbs ?? null,
        weight_days_ago: p.weightAt !== undefined ? Math.floor((now - p.weightAt) / DAY) : null,
        active_medications: p.activeRx,
        allergies: p.allergies,
        active_locks: locks,
        doses_last_24h: ledger.filter((e) => e.at > now - DAY).sort((x, y) => y.at - x.at).map((e) => ({ medication: e.medication, caregiver: e.caregiver, at: new Date(e.at).toISOString(), time_label: clock(e.at), volume_ml: e.volumeMl ?? null })),
      };
    }));

    const remembered = advice.map((m) => {
      const p = patients.find((x) => x.id === m.patientId);
      return { memory: m, patient: p, check: p ? verifyDrugSafety(m.drug, this.clinical(p, now)) : undefined };
    });
    const adviceView = remembered.map(({ memory: m, patient: p, check }) => ({
      id: m.id,
      patient: p?.name ?? m.patientId,
      topic: m.topic,
      advice: m.advice,
      drug: m.drug,
      given_by: m.givenBy,
      given_on: new Date(m.at).toLocaleDateString("en-US", { month: "long", day: "numeric" }),
      still_safe: check?.status === "CLEAR",
      conflict: check && check.status !== "CLEAR" ? { rule_id: check.ruleId, because: check.conflictingRx, rationale: check.rationale } : null,
    }));

    const base: Payload = {
      status: "OK",
      card_type: null,
      caregivers: caregivers.map((c) => ({ id: c.id, name: c.name })),
      acting_caregiver: ctx.caregiverId ?? null,
      patients: people,
      low_supplies: inventory.filter((i) => i.unit !== "pantry" && i.remaining < i.lowThreshold).map((i) => ({ id: i.id, name: i.name, remaining: i.remaining, unit: i.unit })),
      remembered_advice: adviceView,
      active_episodes: await this.escalation.activeEpisodes(a.patient_id ? patients[0]!.id : undefined),
    };

    // A recall question ("what did the doctor say last time?") gets the guarded answer.
    const topic = a.topic?.trim().toLowerCase();
    if (!topic) return base;
    const words = topic.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    const hit = remembered.find(({ memory: m }) => words.some((w) => `${m.topic} ${m.advice} ${m.drug}`.toLowerCase().includes(w)));
    if (!hit || !hit.patient) {
      return { ...base, status: "NO_MATCHING_ADVICE", speech: "I don't have any saved advice about that.", reason_codes: ["NO_REMEMBERED_ADVICE"], sources: [], read_verbatim: true };
    }
    const { memory: m, patient: p, check } = hit;
    const when = new Date(m.at).toLocaleDateString("en-US", { month: "long" });
    if (check && check.status !== "CLEAR") {
      const out: Payload = {
        ...base,
        status: "MEMORY_CONFLICT",
        card_type: "MEMORY_CONFLICT",
        patient_id: p.id,
        patient_name: p.name,
        old_advice: { advice: m.advice, drug: m.drug, given_by: m.givenBy, given_on: when, topic: m.topic },
        conflict: { rule_id: check.ruleId, because: check.conflictingRx, severity: check.severity, rationale: check.rationale },
        call_target: m.givenBy,
        speech: `${m.givenBy}'s ${when} advice was ${m.drug}, but ${p.name} now takes ${check.conflictingRx}, so it's no longer safe. Please call ${m.givenBy} before giving it.`,
        followup: check.rationale,
        reason_codes: ["MEMORY_CONFLICT", check.ruleId],
        sources: check.sources,
        read_verbatim: true,
      };
      await this.audit("get_household_context", p, ctx.caregiverId, a, out);
      return out;
    }
    const out: Payload = {
      ...base,
      status: "MEMORY_STILL_VALID",
      patient_id: p.id,
      patient_name: p.name,
      old_advice: { advice: m.advice, drug: m.drug, given_by: m.givenBy, given_on: when, topic: m.topic },
      speech: `${m.givenBy} advised ${m.drug} in ${when}. It still passes today's checks for ${p.name}, but ask me to plan the dose before giving it.`,
      reason_codes: ["MEMORY_RECHECKED_OK"],
      sources: [],
      read_verbatim: true,
    };
    await this.audit("get_household_context", p, ctx.caregiverId, a, out);
    return out;
  }

  private clinical(p: Patient, now: number): PatientClinical {
    return { activeRx: p.activeRx, conditions: p.conditions, allergies: p.allergies, ageMonths: Math.max(0, Math.floor((now - p.dobMs) / (30.4375 * DAY))) };
  }

  // ---------------------------------------------------------------- pantry
  async queryPantryRemedies(a: { patient_id: string; symptom: Symptom }): Promise<Payload> {
    const p = await this.patient(a.patient_id);
    const inv = await this.storage.getInventory();
    const pantry = inv.filter((i) => i.unit === "pantry" && i.remaining > 0).map((i) => i.id);
    const ageMonths = Math.floor((this.now() - p.dobMs) / (30.4375 * DAY));
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

  // ------------------------------------------------------------------ privacy (H9)

  /**
   * "Delete Leo's data". Two steps, like logging a dose: the first call says exactly what will go and returns a signed token;
   * only a second call carrying that token deletes. Removes the profile and every record about the person. The audit trail is
   * append-only and stays: it holds tool names, verdicts and hashes, no names or measurements.
   */
  async forgetPatient(a: { patient_id: string; confirmation_token?: string }, ctx: CallContext = {}): Promise<Payload> {
    const who = await this.resolvePatient(a.patient_id);
    if ("ask" in who) return who.ask;
    const p = who.patient;
    const now = this.now();
    const finish = async (out: Payload) => { await this.audit("forget_patient", p, ctx.caregiverId, { patient: p.id, has_token: Boolean(a.confirmation_token) }, out); return out; };

    if (!a.confirmation_token) {
      const issuedAt = now;
      const sig = this.sign(["forget", p.id, issuedAt]);
      const [ledger, observations, advice, episodes, rx] = await Promise.all([this.storage.getLedger(p.id), this.storage.getObservations(p.id), this.storage.getAdvice(p.id), this.storage.getEpisodes(p.id), this.storage.getPrescriptions(p.id)]);
      return finish({
        status: "NEEDS_CONFIRMATION",
        card_type: "CONFIRM_DOSE",
        patient_id: p.id,
        patient_name: p.name,
        will_delete: { doses: ledger.length, measurements: observations.length, remembered_advice: advice.length, episodes: episodes.length, prescriptions: rx.length },
        confirmation_token: `${issuedAt}.${sig}`,
        expires_in_seconds: CONFIRMATION_TTL_MS / 1000,
        speech: `This will delete ${p.name}'s profile and everything recorded about them: ${plural(ledger.length, "dose")}, ${plural(observations.length, "measurement")}, notes and prescriptions. It can't be undone. Do you want me to delete it?`,
        followup: `Say yes, delete ${p.name} to confirm.`,
        reason_codes: ["FORGET_NEEDS_CONFIRMATION"],
        sources: [],
        read_verbatim: true,
      });
    }

    const [issued, sig = ""] = a.confirmation_token.split(".");
    const issuedAt = Number(issued);
    const expected = this.sign(["forget", p.id, issuedAt]);
    const valid = Number.isFinite(issuedAt) && sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) && now - issuedAt <= CONFIRMATION_TTL_MS && issuedAt <= now + 60_000;
    if (!valid) {
      return finish({ status: "REJECTED_CONFIRMATION", card_type: null, patient_id: p.id, patient_name: p.name, speech: "That confirmation has expired or doesn't match, so nothing was deleted. Ask me again if you still want it deleted.", reason_codes: ["CONFIRMATION_INVALID_OR_EXPIRED"], sources: [], read_verbatim: true });
    }
    await this.storage.deletePatient(p.id);
    return finish({ status: "DELETED", card_type: null, patient_id: p.id, patient_name: p.name, speech: `Done. ${p.name}'s profile and records are deleted.`, reason_codes: ["PATIENT_DELETED"], sources: [], read_verbatim: true });
  }

  // ------------------------------------------------------------------ cart (simulated Amazon storefront)
  /** An explicit `caregiver_id` (who is speaking) wins over the signed-in caregiver, like confirm_dose_given. */
  private shopCtx(a: { caregiver_id?: string }, ctx: CallContext) { return { caregiverId: a.caregiver_id?.trim() || ctx.caregiverId }; }
  stageAmazonCart(a: { requested_items: { item_name: string; channel?: "prime" | "pharmacy" | "fresh" }[]; caregiver_id?: string }, ctx: CallContext = {}): Promise<Payload> {
    return this.shop.stage(a.requested_items, this.shopCtx(a, ctx));
  }
  confirmAmazonOrder(a: { cart_id: string; caregiver_id?: string }, ctx: CallContext = {}): Promise<Payload> { return this.shop.order(a.cart_id, this.shopCtx(a, ctx)); }
  cancelAmazonOrder(a: { cart_id: string; caregiver_id?: string }, ctx: CallContext = {}): Promise<Payload> { return this.shop.cancel(a.cart_id, this.shopCtx(a, ctx)); }
  trackAmazonOrder(a: { order_id?: string } = {}): Promise<Payload> { return this.shop.track(a); }

  // ------------------------------------------------------------- resources
  async patientSnapshot(id: string) {
    const p = await this.patient(id);
    const now = this.now();
    const ledger = await this.storage.getLedger(p.id);
    const observations = (await this.storage.getObservations(p.id)).slice(-30);
    const ingredients = [...new Set(ledger.map((e) => e.ingredient))];
    const locks = ingredients.map((ing) => {
      const r = checkInterval(ledger, ing, intervalRuleFor(ing), now);
      return { ingredient: ing, status: r.status, next_eligible_time: new Date(r.nextEligibleAt).toISOString() };
    });
    return { profile: { ...p, age_days: Math.floor((now - p.dobMs) / DAY), weight_kg: p.weightLbs ? Math.round(lbToKg(p.weightLbs) * 100) / 100 : null }, medication_history: ledger, observations, active_locks: locks.filter((l) => l.status !== "CLEAR"), weight_days_ago: p.weightAt !== undefined ? Math.floor((now - p.weightAt) / DAY) : null };
  }
}

