import { randomUUID } from "node:crypto";
import type { Payload, PlanPayload } from "./contracts.js";
import { lookupDrug } from "./data/drugClasses.js";
import { LABEL_REGISTRY, type LabelSku } from "./data/labelRegistry.js";
import { expiryEnd } from "./engines/planMedication.js";
import { parseConcentrationMgPerMl } from "./data/labelRegistry.js";
import { fmtNumber } from "./engines/speech.js";
import { cleanDrug, cleanFrequency, cleanPerson, cleanStrength, parseLabelRead, parsePrescriptionRead, type ImageStore, type VisionProvider } from "./providers/vision.js";
import type { Patient, Prescription, StorageAdapter } from "./storage/types.js";

/** Below this, a field is highlighted for the person to check. */
const LOW_CONFIDENCE = 0.8;

export interface RxHost {
  storage: StorageAdapter;
  now(): number;
  vision?: VisionProvider;
  images?: ImageStore;
  resolvePatient(ref: string | undefined): Promise<{ patient: Patient } | { ask: PlanPayload }>;
  audit(tool: string, p: Patient | undefined, caregiver: string | undefined, inputs: unknown, payload: Payload): Promise<void>;
}

interface Ctx { caregiverId?: string }

const unavailable = (what: string): Payload => ({
  status: "UNAVAILABLE",
  card_type: null,
  speech: `I can't read photos right now, so ${what} isn't saved. You can type it instead.`,
  reason_codes: ["VISION_NOT_CONFIGURED"],
  sources: [],
  read_verbatim: true,
});

const view = (r: Prescription) => ({ id: r.id, patient_id: r.patientId, drug: r.drug, strength: r.strength ?? null, frequency: r.frequency ?? null, prescriber: r.prescriber ?? null, status: r.status, source: r.source, confidence: r.confidence ?? {}, flags: r.flags, recognized: Boolean(lookupDrug(r.drug)) });

/**
 * Prescriptions read from a photo. The chain is: image -> strict, sanitised fields -> PENDING -> a person checks each field
 * on screen -> ACTIVE. Pending rows are never read by a safety check: `activeRx` on the patient only changes at `confirm`.
 */
export class PrescriptionService {
  constructor(private host: RxHost) {}

  async manage(
    a: { action: "ingest" | "list" | "confirm" | "reject"; patient_id?: string; upload_id?: string; rx_id?: string; drug?: string; strength?: string; frequency?: string; prescriber?: string },
    ctx: Ctx = {},
  ): Promise<Payload> {
    switch (a.action) {
      case "ingest": return this.ingest(a, ctx);
      case "list": return this.list(a);
      case "confirm": return this.confirm(a, ctx);
      case "reject": return this.reject(a, ctx);
    }
  }

  private async ingest(a: { patient_id?: string; upload_id?: string }, ctx: Ctx): Promise<Payload> {
    const who = await this.host.resolvePatient(a.patient_id);
    if ("ask" in who) return who.ask;
    const p = who.patient;
    const done = async (out: Payload) => { await this.host.audit("manage_prescriptions", p, ctx.caregiverId, { action: "ingest", has_upload: Boolean(a.upload_id) }, out); return out; };
    if (!this.host.vision || !this.host.images) return done(unavailable("the prescription"));
    if (!a.upload_id) return done({ status: "NEEDS_INFO", card_type: "NEEDS_INFO", patient_id: p.id, patient_name: p.name, missing: "photo", question: "Please add a photo of the prescription on the screen.", options: [], speech: "Please add a photo of the prescription on the screen.", reason_codes: ["PHOTO_MISSING"], sources: [], read_verbatim: true });
    const image = await this.host.images.take(a.upload_id);
    if (!image) return done({ status: "NEEDS_INFO", card_type: "NEEDS_INFO", patient_id: p.id, patient_name: p.name, missing: "photo", question: "I can't find that photo. Please add it again.", options: [], speech: "I can't find that photo. Please add it again.", reason_codes: ["UPLOAD_NOT_FOUND"], sources: [], read_verbatim: true });

    let raw: unknown;
    try { raw = await this.host.vision.readPrescription(image); } catch (e) {
      console.error("[prescriptions] vision failed:", e);
      return done({ status: "UNAVAILABLE", card_type: null, patient_id: p.id, patient_name: p.name, speech: "I couldn't read that photo. Please try again with better light, or type the medicine.", reason_codes: ["VISION_ERROR"], sources: [], read_verbatim: true });
    }
    const read = parsePrescriptionRead(raw);
    if ("error" in read || !read.legible || read.medications.length === 0) {
      return done({ status: "NEEDS_INFO", card_type: "NEEDS_INFO", patient_id: p.id, patient_name: p.name, missing: "photo", question: "I couldn't read any medicines in that photo. Please try again with better light.", options: [], speech: "I couldn't read any medicines in that photo. Please try again with better light.", reason_codes: ["PRESCRIPTION_UNREADABLE"], sources: [], read_verbatim: true });
    }

    const now = this.host.now();
    const onChart = new Set(p.activeRx.flatMap((d) => lookupDrug(d)?.ingredients ?? [d.toLowerCase()]));
    const created: Prescription[] = [];
    for (const m of read.medications) {
      const flags = [...m.flags];
      if (!m.drug) flags.push("DRUG_MISSING");
      else {
        const info = lookupDrug(m.drug);
        if (!info) flags.push("UNRECOGNIZED_DRUG");
        else if (info.ingredients.some((i) => onChart.has(i))) flags.push("ALREADY_ON_CHART");
      }
      for (const [field, c] of Object.entries(m.confidence)) if (c !== undefined && c < LOW_CONFIDENCE) flags.push(`LOW_CONFIDENCE:${field}`);
      const rx: Prescription = { id: `rx_${randomUUID().slice(0, 8)}`, patientId: p.id, drug: m.drug ?? "", strength: m.strength, frequency: m.frequency, prescriber: m.prescriber, status: "PENDING", source: "photo", uploadId: a.upload_id, confidence: m.confidence as Record<string, number>, flags, createdAt: now };
      await this.host.storage.savePrescription(rx);
      created.push(rx);
    }
    const nameMismatch = read.patientName && !p.name.toLowerCase().includes(read.patientName.split(" ")[0]!.toLowerCase()) && !read.patientName.toLowerCase().includes(p.name.toLowerCase());
    const n = created.length;
    return done({
      status: "NEEDS_CONFIRMATION",
      card_type: "RX_CONFIRMATION",
      patient_id: p.id,
      patient_name: p.name,
      prescriptions: created.map(view),
      name_on_label: read.patientName ?? null,
      name_mismatch: Boolean(nameMismatch),
      nothing_saved: true,
      upload_id: a.upload_id,
      speech: `I read ${n} ${n === 1 ? "medicine" : "medicines"} from the photo. Nothing is saved to ${p.name}'s chart until you check ${n === 1 ? "it" : "each one"} on the screen.${nameMismatch ? ` The name on the label doesn't look like ${p.name}.` : ""}`,
      followup: "Compare each line with the photo, fix anything that's wrong, then confirm.",
      reason_codes: ["RX_PENDING_HUMAN_CONFIRM", ...(nameMismatch ? ["NAME_MISMATCH"] : [])],
      sources: [],
      read_verbatim: true,
    });
  }

  private async list(a: { patient_id?: string }): Promise<Payload> {
    let patientId: string | undefined;
    if (a.patient_id) {
      const who = await this.host.resolvePatient(a.patient_id);
      if ("ask" in who) return who.ask;
      patientId = who.patient.id;
    }
    const all = (await this.host.storage.getPrescriptions(patientId)).map(view);
    return { status: "OK", card_type: null, prescriptions: all, pending: all.filter((r) => r.status === "PENDING").length, speech: all.length ? `There ${all.length === 1 ? "is" : "are"} ${all.length} saved ${all.length === 1 ? "prescription" : "prescriptions"}, ${all.filter((r) => r.status === "PENDING").length} waiting to be confirmed.` : "There are no saved prescriptions.", reason_codes: ["RX_LIST"], sources: [], read_verbatim: true };
  }

  /** The human confirm. Corrections replace what was read; anything that fails sanitising is refused, not stored. */
  private async confirm(a: { rx_id?: string; drug?: string; strength?: string; frequency?: string; prescriber?: string }, ctx: Ctx): Promise<Payload> {
    const rx = (await this.host.storage.getPrescriptions()).find((r) => r.id === a.rx_id);
    if (!rx) return { status: "NOT_FOUND", card_type: null, speech: "I can't find that prescription.", reason_codes: ["RX_NOT_FOUND"], sources: [], read_verbatim: true };
    const p = await this.host.storage.getPatient(rx.patientId);
    if (!p) return { status: "NOT_FOUND", card_type: null, speech: "I can't find that person.", reason_codes: ["PATIENT_NOT_FOUND"], sources: [], read_verbatim: true };
    const finish = async (out: Payload) => { await this.host.audit("manage_prescriptions", p, ctx.caregiverId, { action: "confirm", rx_id: rx.id }, out); return out; };
    if (rx.status === "ACTIVE") return finish({ status: "CONFIRMED", card_type: null, already_confirmed: true, patient_id: p.id, patient_name: p.name, prescription: view(rx), speech: "That was already confirmed.", reason_codes: ["RX_ALREADY_CONFIRMED"], sources: [], read_verbatim: true });

    const bad: string[] = [];
    const pick = <T extends string>(given: string | undefined, current: T | undefined, cleaner: (v: unknown) => { value: T | undefined; flag?: string }) => {
      if (given === undefined) return current;
      const c = cleaner(given);
      if (c.flag) bad.push(c.flag);
      return c.value;
    };
    const drug = pick(a.drug, rx.drug || undefined, cleanDrug);
    const strength = pick(a.strength, rx.strength, cleanStrength);
    const frequency = pick(a.frequency, rx.frequency, cleanFrequency);
    const prescriber = pick(a.prescriber, rx.prescriber, cleanPerson);
    if (bad.length > 0 || !drug) {
      return finish({ status: "NEEDS_INFO", card_type: "NEEDS_INFO", patient_id: p.id, patient_name: p.name, missing: "drug", question: "I need the medicine's name to save it. Please type it exactly as printed.", options: [], speech: "I need the medicine's name to save it. Please type it exactly as printed.", reason_codes: ["RX_FIELD_REJECTED", ...bad], sources: [], read_verbatim: true });
    }

    const info = lookupDrug(drug);
    const flags = rx.flags.filter((f) => !f.startsWith("LOW_CONFIDENCE") && f !== "DRUG_MISSING" && f !== "UNRECOGNIZED_DRUG");
    if (!info) flags.push("UNRECOGNIZED_DRUG");
    const confirmed: Prescription = { ...rx, drug, strength, frequency, prescriber, status: "ACTIVE", flags, confirmedAt: this.host.now() };
    await this.host.storage.savePrescription(confirmed);
    const key = drug.toLowerCase();
    if (!p.activeRx.some((d) => d.toLowerCase() === key)) await this.host.storage.setActiveRx(p.id, [...p.activeRx, key]);

    return finish({
      status: "CONFIRMED",
      card_type: null,
      patient_id: p.id,
      patient_name: p.name,
      prescription: view(confirmed),
      unchecked: !info,
      speech: info ? `Saved. ${drug} is now on ${p.name}'s chart, and I'll check it against every medicine request.` : `Saved. I don't recognize ${drug}, so I can't check it against other medicines. Please ask a pharmacist.`,
      reason_codes: ["RX_CONFIRMED", ...(info ? [] : ["UNCHECKED_ACTIVE_MEDICATION"])],
      sources: [],
      read_verbatim: true,
    });
  }

  private async reject(a: { rx_id?: string }, ctx: Ctx): Promise<Payload> {
    const rx = (await this.host.storage.getPrescriptions()).find((r) => r.id === a.rx_id);
    if (!rx) return { status: "NOT_FOUND", card_type: null, speech: "I can't find that prescription.", reason_codes: ["RX_NOT_FOUND"], sources: [], read_verbatim: true };
    if (rx.status === "ACTIVE") return { status: "BLOCKED_ACTIVE", card_type: null, speech: "That medicine is already confirmed on the chart. Ask your clinician before removing it.", reason_codes: ["RX_ACTIVE_NOT_REMOVABLE_HERE"], sources: [], read_verbatim: true };
    await this.host.storage.deletePrescription(rx.id);
    const out: Payload = { status: "REJECTED", card_type: null, rx_id: rx.id, speech: "Okay, I've discarded that one. Nothing was saved.", reason_codes: ["RX_DISCARDED"], sources: [], read_verbatim: true };
    await this.host.audit("manage_prescriptions", await this.host.storage.getPatient(rx.patientId), ctx.caregiverId, { action: "reject", rx_id: rx.id }, out);
    return out;
  }

  // ---------------------------------------------------------------- Label Lens

  /**
   * Reads a bottle's label and shows what it CLAIMS (name, strength, expiry), next to what the household has on the shelf.
   * It does not choose a dose: once the person confirms, plan_medication takes the strength and expiry as inputs.
   */
  async readBottleLabel(a: { upload_id?: string; patient_id?: string }, ctx: Ctx = {}): Promise<Payload> {
    const done = async (out: Payload) => { await this.host.audit("read_bottle_label", undefined, ctx.caregiverId, { has_upload: Boolean(a.upload_id) }, out); return out; };
    if (!this.host.vision || !this.host.images) return done(unavailable("the label"));
    if (!a.upload_id) return done({ status: "NEEDS_INFO", card_type: "NEEDS_INFO", missing: "photo", question: "Please add a photo of the bottle's label on the screen.", options: [], speech: "Please add a photo of the bottle's label on the screen.", reason_codes: ["PHOTO_MISSING"], sources: [], read_verbatim: true });
    const image = await this.host.images.take(a.upload_id);
    if (!image) return done({ status: "NEEDS_INFO", card_type: "NEEDS_INFO", missing: "photo", question: "I can't find that photo. Please add it again.", options: [], speech: "I can't find that photo. Please add it again.", reason_codes: ["UPLOAD_NOT_FOUND"], sources: [], read_verbatim: true });

    let raw: unknown;
    try { raw = await this.host.vision.readBottleLabel(image); } catch (e) {
      console.error("[label lens] vision failed:", e);
      return done({ status: "UNAVAILABLE", card_type: null, speech: "I couldn't read that label. Please try again with better light, or type the strength.", reason_codes: ["VISION_ERROR"], sources: [], read_verbatim: true });
    }
    const read = parseLabelRead(raw);
    if ("error" in read || !read.legible || (!read.strength && !read.productName)) {
      return done({ status: "NEEDS_INFO", card_type: "NEEDS_INFO", missing: "photo", question: "I couldn't read the label. Please try again with better light, or tell me the strength printed on the bottle.", options: [], speech: "I couldn't read the label. Please try again with better light, or tell me the strength printed on the bottle.", reason_codes: ["LABEL_UNREADABLE"], sources: [], read_verbatim: true });
    }

    const now = this.host.now();
    const claimedMgPerMl = read.strength ? parseConcentrationMgPerMl(read.strength) : undefined;
    const ingredient = lookupDrug(read.activeIngredient ?? read.productName ?? "")?.ingredient;
    const shelf = await this.shelfBottle(ingredient);
    const differs = claimedMgPerMl !== undefined && shelf?.mgPerMl !== undefined && Math.abs(claimedMgPerMl - shelf.mgPerMl) > 0.01;
    const end = expiryEnd(read.expiry);
    const expired = end !== undefined && now >= end;
    const expiryLabel = end !== undefined ? new Date(end - 1).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) : undefined;

    const says = [read.productName, read.strength ? read.strength.replace(/\s*\/\s*/g, " per ") : undefined].filter(Boolean).join(", ");
    const speech = expired
      ? `That bottle expired in ${expiryLabel}, so please don't use it.`
      : `The bottle says ${says || "something I couldn't fully read"}${expiryLabel ? `, expires ${expiryLabel}` : ""}. Is that right?`;
    return done({
      status: expired ? "BLOCKED" : "NEEDS_CONFIRMATION",
      card_type: "LABEL_LENS",
      violation_type: expired ? "BOTTLE_EXPIRED" : undefined,
      upload_id: a.upload_id,
      claims: { product: read.productName ?? null, ingredient: read.activeIngredient ?? null, strength: read.strength ?? null, expiry: read.expiry ?? null, expiry_label: expiryLabel ?? null },
      confidence: read.confidence,
      expired,
      shelf: shelf ? { name: shelf.name, strength: `${fmtNumber(shelf.mgPerMl)} mg per mL` } : null,
      differs_from_shelf: differs,
      followup: differs ? "This is a different strength from the bottle the chart uses, so I'll work out the dose for the bottle you're holding." : "Check that against the bottle, then confirm.",
      speech,
      reason_codes: ["LABEL_READ_NEEDS_CONFIRM", ...(expired ? ["BOTTLE_EXPIRED"] : []), ...(differs ? ["BOTTLE_DIFFERS_FROM_SHELF"] : []), ...read.flags],
      sources: [],
      read_verbatim: true,
    });
  }

  /** The registry bottle the household has for this ingredient, with its concentration. */
  private async shelfBottle(ingredient: string | undefined): Promise<{ name: string; mgPerMl: number } | undefined> {
    if (!ingredient) return undefined;
    const inv = (await this.host.storage.getInventory()).find((i) => i.unit === "mL" && i.ingredient === ingredient && i.sku);
    const sku = LABEL_REGISTRY.find((s): s is Extract<LabelSku, { kind: "liquid" }> => s.sku === inv?.sku && s.kind === "liquid");
    return inv && sku ? { name: inv.name, mgPerMl: sku.mgPerMl } : undefined;
  }
}
