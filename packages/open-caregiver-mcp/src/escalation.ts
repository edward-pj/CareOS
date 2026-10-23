import { randomUUID } from "node:crypto";
import type { Payload, PlanPayload } from "./contracts.js";
import { localeFor, type LocaleCode, type LocaleProfile } from "./data/locale.js";
import { lookupDrug } from "./data/drugClasses.js";
import { SIGN_QUESTION, URGENCY_RANK, type Sign, type Urgency } from "./data/redFlagRules.js";
import { buildSbar, dossierBlocks, gatherFacts, type CareFacts } from "./engines/careSummary.js";
import { buildPdf } from "./engines/pdf.js";
import { fmtNumber } from "./engines/speech.js";
import { triage } from "./engines/triageEngine.js";
import { DEMO_ORIGIN, FixtureHospitalProvider, type Coordinates, type HospitalProvider } from "./providers/hospitals.js";
import type { Episode, Notifier, Patient, StorageAdapter } from "./storage/types.js";

const DAY = 86_400_000;
const H = 3_600_000;
/** A flag that forbids home dosing (a vomited dose, a feverish newborn) holds for this long unless a clinician is reached. */
const NO_HOME_DOSING_HOURS = 12;
/** An episode with no activity for this long stops counting as "active" on the screen. */
const EPISODE_ACTIVE_HOURS = 24;
/** A temperature reading is "current" for triage for this long. */
const FRESH_TEMP_HOURS = 6;

export interface EscalationHost {
  storage: StorageAdapter;
  now(): number;
  notifier?: Notifier;
  resolvePatient(ref: string | undefined): Promise<{ patient: Patient } | { ask: PlanPayload }>;
  audit(tool: string, p: Patient | undefined, caregiver: string | undefined, inputs: unknown, payload: Payload): Promise<void>;
  actorName(caregiverId: string | undefined): Promise<string>;
}

export interface EscalationOptions {
  locale?: LocaleCode;
  origin?: Coordinates;
  hospitals?: HospitalProvider;
}

export interface EscalationContext { caregiverId?: string }

const FIRST_AID = [
  "Stay with the person and keep them calm.",
  "Do not give food, drink or medicine unless the call-taker tells you to.",
  "If they are not breathing, tell the call-taker; they will coach you through CPR.",
  "Unlock the door and turn on a light so help can find you.",
  "Have the medicine bottles and this summary ready.",
];

/** Triage, emergency and the nurse-line / doctor summaries. Tools own the urgency: the model never decides it. */
export class EscalationService {
  private locale: LocaleProfile;
  private origin: Coordinates;
  private hospitals: HospitalProvider;

  constructor(private host: EscalationHost, opts: EscalationOptions = {}) {
    this.locale = localeFor(opts.locale);
    this.origin = opts.origin ?? DEMO_ORIGIN;
    this.hospitals = opts.hospitals ?? new FixtureHospitalProvider();
  }

  get localeProfile() { return this.locale; }

  // ---------------------------------------------------------------- triage_symptoms

  async triageSymptoms(
    a: { patient_id: string; signs?: Sign[]; no_warning_signs?: boolean; temperature_value?: number; temperature_unit?: "F" | "C"; fever_days?: number },
    ctx: EscalationContext = {},
  ): Promise<Payload> {
    const who = await this.host.resolvePatient(a.patient_id);
    if ("ask" in who) return who.ask;
    const p = who.patient;
    const now = this.host.now();
    const ageDays = Math.max(0, Math.floor((now - p.dobMs) / DAY));
    const signs = [...new Set(a.signs ?? [])];
    const finish = async (out: Payload) => { await this.host.audit("triage_symptoms", p, ctx.caregiverId, a, out); return out; };
    const ask = (missing: string, question: string, codes: string[]): Payload => ({ patient_id: p.id, patient_name: p.name, status: "NEEDS_INFO", card_type: "NEEDS_INFO", missing, question, options: [], speech: question, reason_codes: codes, sources: [], read_verbatim: true });

    // Temperature: what was just said, else a reading from the last few hours. Never guessed, never assumed.
    let tempF: number | undefined;
    if (a.temperature_value !== undefined) {
      const v = a.temperature_value;
      const unit = a.temperature_unit ?? (v >= 90 && v <= 110 ? "F" : v >= 32 && v <= 43 ? "C" : undefined);
      if (!unit) return finish(ask("unit", `Is ${p.name}'s temperature ${fmtNumber(v)} degrees Fahrenheit or Celsius?`, ["TEMPERATURE_UNIT_MISSING"]));
      tempF = unit === "F" ? v : v * 1.8 + 32;
      if (tempF < 93 || tempF > 108) return finish(ask("value", `${fmtNumber(v)} degrees looks unusual. Please check the thermometer and tell me again.`, ["TEMPERATURE_IMPLAUSIBLE"]));
    } else {
      const recent = (await this.host.storage.getObservations(p.id, "temperature")).filter((o) => o.at >= now - FRESH_TEMP_HOURS * H).at(-1);
      if (recent) tempF = recent.unit === "C" ? recent.value * 1.8 + 32 : recent.value;
    }
    if (a.fever_days !== undefined && !(a.fever_days > 0 && a.fever_days <= 60)) return finish(ask("fever_days", "How many days has the fever lasted?", ["FEVER_DAYS_INVALID"]));

    const onAnticoagulant = p.activeRx.some((d) => lookupDrug(d)?.classes.includes("anticoagulant"));
    const base = { patient_id: p.id, patient_name: p.name };

    // Nothing reported yet: ask, with the checklist that mirrors the rules for this person.
    if (signs.length === 0 && tempF === undefined && a.fever_days === undefined && !a.no_warning_signs) {
      const r = triage({ ageDays, signs: [], onAnticoagulant });
      const question = `Is ${p.name} showing any of these warning signs? Tell me which, or say none.`;
      return finish({ ...base, status: "NEEDS_INFO", card_type: "RED_FLAG_CHECKLIST", missing: "signs", question, checklist: this.checklist(r.checklist, p), speech: question, reason_codes: ["TRIAGE_NEEDS_SIGNS"], sources: [], read_verbatim: true });
    }

    const r = triage({ ageDays, signs, tempF, feverDays: a.fever_days, onAnticoagulant });
    const top = r.matched[0];
    const reported = [...(a.no_warning_signs && signs.length === 0 ? ["no warning signs"] : []), ...signs.map((s) => s.replace(/_/g, " ")), tempF !== undefined ? `temperature ${fmtNumber(Math.round(tempF * 10) / 10)}°F` : undefined, a.fever_days !== undefined ? `fever for ${fmtNumber(a.fever_days)} days` : undefined].filter(Boolean).join(", ");
    const episode = await this.recordEpisode(p, now, reported, `Reported: ${reported}. Advice: ${r.urgency}${top ? ` (${r.matched.map((m) => m.id).join(", ")})` : ""}.`, r.urgency, r.matched.map((m) => m.id), r.noHomeDosing);

    const rules = r.matched.map((m) => ({ id: m.id, trigger: m.trigger, urgency: m.urgency, say: m.say, source: { name: m.source.name, url: m.source.url, section: m.source.section }, note: m.note ?? null }));
    const common = {
      ...base,
      urgency: r.urgency,
      rules,
      no_home_dosing: r.noHomeDosing,
      checklist: this.checklist(r.checklist, p),
      episode_id: episode.id,
      reason_codes: r.matched.length ? r.matched.map((m) => m.id) : ["TRIAGE_NO_RED_FLAGS_REPORTED"],
      sources: [...new Set(r.matched.map((m) => m.source.name))],
      read_verbatim: true as const,
    };

    if (URGENCY_RANK[r.urgency] >= URGENCY_RANK.GO_TO_ER_NOW) {
      const emergency = await this.emergencyPayload(p, reported, ctx);
      const n = this.locale.emergencyNumber;
      const speech = r.urgency === "CALL_EMERGENCY" ? `This could be an emergency. Call ${this.locale.emergencySpoken} now.` : top!.say;
      return finish({ ...common, status: r.urgency, card_type: "EMERGENCY_LOCATOR", emergency, speech, followup: r.urgency === "CALL_EMERGENCY" ? `${top!.say} CareOS can't place the call for you. Dial ${n} yourself.` : `If you can't reach a doctor right away, call ${n}.` });
    }
    if (r.urgency === "CALL_DOCTOR_TODAY") {
      const facts = await this.facts(p, 24);
      const sbar = buildSbar(facts, { concern: reported });
      return finish({ ...common, status: r.urgency, card_type: "NURSE_LINE_BRIEF", sbar, speech: top!.say, followup: "I have a short summary ready for the nurse line. Say 'help me call the nurse line' to hear it." });
    }
    return finish({ ...common, status: r.urgency, card_type: "RED_FLAG_CHECKLIST", speech: `I don't see any of the warning signs I check for in what you told me. I can't diagnose, so call your doctor if you're worried, and tell me if anything changes.`, followup: r.checklist.length ? "Keep an eye out for the signs on the screen." : undefined });
  }

  private checklist(signs: Sign[], p: Patient) {
    return signs.slice(0, 8).map((s) => ({ sign: s, question: SIGN_QUESTION[s].replace(/\{name\}/g, p.name) }));
  }

  /** Opens the patient's episode (or adds to the open one) and keeps the strongest urgency seen. */
  private async recordEpisode(p: Patient, now: number, concern: string, text: string, urgency: Urgency, ruleIds: string[], noHomeDosing: boolean): Promise<Episode> {
    const existing = (await this.host.storage.getEpisodes(p.id)).find((e) => e.status === "OPEN");
    const ep: Episode = existing
      ? { ...existing, timeline: [...existing.timeline] }
      : { id: `ep_${randomUUID().slice(0, 8)}`, patientId: p.id, status: "OPEN", openedAt: now, updatedAt: now, urgency, redFlags: [], timeline: [{ at: now, type: "OPENED", text: "Episode opened" }] };
    ep.updatedAt = now;
    ep.concern = concern;
    if (URGENCY_RANK[urgency] > URGENCY_RANK[ep.urgency]) ep.urgency = urgency;
    ep.redFlags = [...new Set([...ep.redFlags, ...ruleIds])];
    ep.timeline.push({ at: now, type: "TRIAGE", text });
    if (noHomeDosing) ep.noHomeDosingUntil = now + NO_HOME_DOSING_HOURS * H;
    await this.host.storage.saveEpisode(ep);
    return ep;
  }

  /** Adds a dose or note to the person's open episode, if there is one. Never opens one by itself. */
  async noteOnEpisode(patientId: string, type: "DOSE" | "CHECKIN" | "NOTE", text: string): Promise<void> {
    const ep = (await this.host.storage.getEpisodes(patientId)).find((e) => e.status === "OPEN");
    if (!ep) return;
    const now = this.host.now();
    await this.host.storage.saveEpisode({ ...ep, updatedAt: now, timeline: [...ep.timeline, { at: now, type, text }] });
  }

  /** Is home dosing currently ruled out for this person? Used by plan_medication. */
  async homeDosingHold(patientId: string): Promise<{ until: number; ruleIds: string[] } | undefined> {
    const now = this.host.now();
    const ep = (await this.host.storage.getEpisodes(patientId)).find((e) => e.status === "OPEN" && (e.noHomeDosingUntil ?? 0) > now);
    return ep ? { until: ep.noHomeDosingUntil!, ruleIds: ep.redFlags } : undefined;
  }

  /** Open episodes with recent activity, plus any check-in that is due. */
  async activeEpisodes(patientId?: string) {
    const now = this.host.now();
    const open = (await this.host.storage.getEpisodes(patientId)).filter((e) => e.status === "OPEN" && now - e.updatedAt < EPISODE_ACTIVE_HOURS * H);
    return Promise.all(open.map(async (e) => {
      const p = await this.host.storage.getPatient(e.patientId);
      const lastTemp = (await this.host.storage.getObservations(e.patientId, "temperature")).at(-1);
      const due = !lastTemp || now - lastTemp.at > 2 * H;
      return {
        id: e.id,
        patient_id: e.patientId,
        patient_name: p?.name ?? e.patientId,
        urgency: e.urgency,
        opened_at: new Date(e.openedAt).toISOString(),
        red_flags: e.redFlags,
        last_event: e.timeline.at(-1)?.text ?? null,
        checkin_due: due ? `Has ${p?.name ?? "the patient"}'s temperature been checked in the last 2 hours?` : null,
      };
    }));
  }

  // ---------------------------------------------------------------- emergency_assist

  /** The emergency card: the number to dial, nearby hospitals (sample data until a live provider exists), and a summary to read out. */
  async emergencyAssist(a: { patient_id?: string; reason?: string; latitude?: number; longitude?: number } = {}, ctx: EscalationContext = {}): Promise<Payload> {
    // In an emergency never make the caller answer "who?" before they see the number: show the card, and ask afterwards.
    let patient: Patient | undefined;
    let ask: PlanPayload | undefined;
    if (a.patient_id) {
      const who = await this.host.resolvePatient(a.patient_id);
      if ("patient" in who) patient = who.patient; else ask = who.ask;
    }
    const reason = (a.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "emergency requested";
    const origin = a.latitude !== undefined && a.longitude !== undefined ? { lat: a.latitude, lng: a.longitude, label: "Location you gave" } : undefined;
    const emergency = await this.emergencyPayload(patient, reason, ctx, origin);
    const out: Payload = {
      status: "CALL_EMERGENCY",
      card_type: "EMERGENCY_LOCATOR",
      ...(patient ? { patient_id: patient.id, patient_name: patient.name } : {}),
      urgency: "CALL_EMERGENCY",
      emergency,
      speech: `This could be an emergency. Call ${this.locale.emergencySpoken} now.`,
      followup: ask ? `CareOS can't place the call for you. Dial ${this.locale.emergencyNumber} yourself. Afterwards, tell me who this is for.` : `CareOS can't place the call for you. Dial ${this.locale.emergencyNumber} yourself.`,
      reason_codes: ["EMERGENCY_ASSIST"],
      sources: [],
      read_verbatim: true,
    };
    await this.host.audit("emergency_assist", patient, ctx.caregiverId, { ...a, reason: undefined }, out);
    return out;
  }

  private async emergencyPayload(p: Patient | undefined, reason: string, ctx: EscalationContext, origin?: Coordinates) {
    const loc = this.locale;
    const hospitals = await this.hospitals.findNearby({ origin: origin ?? this.origin, limit: 3, locale: loc.code }).catch((e) => { console.error("[emergency] hospital lookup failed:", e); return []; });
    const sbar = p ? buildSbar(await this.facts(p, 24), { concern: reason }) : undefined;
    // Alerts to other caregivers are NOT held back by quiet hours: an emergency is exactly what they must hear.
    const who = await this.host.actorName(ctx.caregiverId);
    const sent = await this.host.notifier?.send("EMERGENCY", `CareOS: possible emergency${p ? ` for ${p.name}` : ""}. ${who} was told to call ${loc.emergencyNumber}.`).catch(() => undefined);
    return {
      locale: loc.code,
      country: loc.country,
      number: loc.emergencyNumber,
      number_spoken: loc.emergencySpoken,
      ambulance_number: loc.ambulanceNumber ?? null,
      tel: `tel:${loc.emergencyNumber}`,
      poison: { label: loc.poison.label, number: loc.poison.number ?? null, tel: loc.poison.number ? `tel:${loc.poison.number}` : null, note: loc.poison.note ?? null },
      hospitals,
      hospitals_source: { provider: this.hospitals.name, live: this.hospitals.live, note: this.hospitals.live ? "From the configured place-search service." : "Sample data. Real hospital search is not connected yet." },
      origin: { label: (origin ?? this.origin).label ?? null },
      first_aid: FIRST_AID,
      sbar: sbar ?? null,
      caregivers_notified: sent !== undefined,
      disclosure: "CareOS prepares the call; you place it. It never calls anyone for you.",
    };
  }

  // ---------------------------------------------------------------- export_care_summary

  private async facts(p: Patient, hours: number): Promise<CareFacts> {
    const [ledger, observations, episodes, rx] = await Promise.all([this.host.storage.getLedger(p.id), this.host.storage.getObservations(p.id), this.host.storage.getEpisodes(p.id), this.host.storage.getPrescriptions(p.id)]);
    return gatherFacts({ now: this.host.now(), patient: p, ledger, observations, episodes, pendingMedicines: rx.filter((r) => r.status === "PENDING").map((r) => r.drug), windowHours: hours });
  }

  async exportCareSummary(a: { patient_id: string; kind: "sbar" | "dossier"; hours?: number; for_clinician?: string }, ctx: EscalationContext = {}): Promise<Payload> {
    const who = await this.host.resolvePatient(a.patient_id);
    if ("ask" in who) return who.ask;
    const p = who.patient;
    const hours = Math.min(168, Math.max(1, Math.round(a.hours ?? (a.kind === "dossier" ? 48 : 24))));
    const facts = await this.facts(p, hours);
    const caller = ctx.caregiverId ? await this.host.actorName(ctx.caregiverId) : undefined;
    const sbar = buildSbar(facts, { caller });
    const base = { patient_id: p.id, patient_name: p.name, hours, sbar, reason_codes: [a.kind === "sbar" ? "NURSE_LINE_BRIEF" : "CARE_SUMMARY_PDF"], sources: [] as string[], read_verbatim: true as const };
    const out: Payload =
      a.kind === "sbar"
        ? { ...base, status: "SBAR_READY", card_type: "NURSE_LINE_BRIEF", speech: sbar.speech, followup: "That is the same text shown on the screen. You place the call." }
        : {
            ...base,
            status: "SUMMARY_READY",
            card_type: "NURSE_LINE_BRIEF",
            pdf: { resource: `careos://patients/${p.id}/dossier.pdf?hours=${hours}`, download_path: `/api/patients/${p.id}/dossier.pdf?hours=${hours}`, filename: `care-summary-${p.id}-${hours}h.pdf` },
            counts: { temperatures: facts.temperatures.length, doses: facts.doses.length },
            speech: `I've prepared a ${hours} hour care summary for ${p.name}: ${facts.temperatures.length} temperature ${facts.temperatures.length === 1 ? "reading" : "readings"} and ${facts.doses.length} ${facts.doses.length === 1 ? "dose" : "doses"}. It's on the screen as a PDF.`,
          };
    await this.host.audit("export_care_summary", p, ctx.caregiverId, a, out);
    return out;
  }

  /** The doctor's dossier as a PDF. */
  async dossierPdf(patientId: string, hours = 48, preparedFor?: string): Promise<{ bytes: Uint8Array; filename: string }> {
    const who = await this.host.resolvePatient(patientId);
    if ("ask" in who) throw new Error(`Unknown patient "${patientId}".`);
    const h = Math.min(168, Math.max(1, Math.round(hours)));
    const facts = await this.facts(who.patient, h);
    return { bytes: buildPdf(dossierBlocks(facts, { windowHours: h, preparedFor })), filename: `care-summary-${who.patient.id}-${h}h.pdf` };
  }
}
