// Reading photos of prescriptions and medicine bottles. The interface is what CareOS depends on; Gemini implements it today
// and Bedrock can later. A provider returns whatever it read as UNTRUSTED data: everything is validated against a strict
// schema and sanitised here before it can reach a chart, a tool result or a model. Text inside an image is never an instruction
// (PRD H6), and nothing read from a photo is trusted until a person confirms it (S6).

import { z } from "zod";

export interface ImageInput {
  mime: string;
  bytes: Uint8Array;
}

/** Short-lived holder of uploaded images, scoped to one household. `take` returns the image once and forgets it. */
export interface ImageStore {
  take(uploadId: string): Promise<ImageInput | undefined>;
}

export interface VisionProvider {
  readonly name: string;
  /** Return the raw structured read. It is validated by `parsePrescriptionRead`; do not trust it. */
  readPrescription(image: ImageInput): Promise<unknown>;
  readBottleLabel(image: ImageInput): Promise<unknown>;
}

// ------------------------------------------------------------------ sanitising

/** Words that have no place in a drug name, dose or prescriber, but do appear in text trying to steer an assistant. */
const STEERING = /\b(ignore|disregard|override|bypass|skip|forget|pretend|system|instruction|instructions|prompt|assistant|alexa|safety|rule|rules|check|checks|approve|approved|admin|doctor says)\b/i;
const NAME = /^[\p{L}\p{N} .'’()%+\-/]{1,60}$/u;
const STRENGTH = /^[\d.,]{1,9}\s?(mg|mcg|µg|g|ml|iu|units?|%)(\s?(\/|per)\s?[\d.,]{0,9}\s?(ml|tab|tablet|capsule|cap|dose))?$/i;
const FREQUENCY = /^[\p{L}\p{N} ,.\-/]{1,40}$/u;
const PERSON = /^[\p{L} .'’-]{1,40}$/u;

export interface Cleaned<T> { value: T | undefined; flag?: string }

function clean(raw: unknown, rx: RegExp, field: string, maxWords = 6): Cleaned<string> {
  if (raw === undefined || raw === null || raw === "") return { value: undefined };
  if (typeof raw !== "string") return { value: undefined, flag: `UNREADABLE_FIELD:${field}` };
  const t = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return { value: undefined };
  if (STEERING.test(t)) return { value: undefined, flag: `SUSPICIOUS_TEXT:${field}` };
  if (t.split(" ").length > maxWords || !rx.test(t)) return { value: undefined, flag: `UNREADABLE_FIELD:${field}` };
  return { value: t };
}
export const cleanDrug = (v: unknown) => clean(v, NAME, "drug", 5);
export const cleanStrength = (v: unknown) => clean(v, STRENGTH, "strength", 6);
export const cleanFrequency = (v: unknown) => clean(v, FREQUENCY, "frequency", 7);
export const cleanPerson = (v: unknown) => clean(v, PERSON, "prescriber", 5);

const conf = z.number().min(0).max(1).optional();
const rxItem = z.object({
  drug: z.unknown().optional(),
  strength: z.unknown().optional(),
  frequency: z.unknown().optional(),
  prescriber: z.unknown().optional(),
  confidence: z.object({ drug: conf, strength: conf, frequency: conf, prescriber: conf }).partial().optional(),
});
const rxRead = z.object({
  legible: z.boolean().optional(),
  patient_name: z.unknown().optional(),
  medications: z.array(rxItem).max(10),
});

export interface ReadMedication {
  drug?: string;
  strength?: string;
  frequency?: string;
  prescriber?: string;
  confidence: Partial<Record<"drug" | "strength" | "frequency" | "prescriber", number>>;
  flags: string[];
}
export interface PrescriptionRead { legible: boolean; patientName?: string; medications: ReadMedication[]; flags: string[] }

/** Validates and sanitises a provider's raw prescription read. Unknown keys are dropped; anything that fails a check is removed and flagged. */
export function parsePrescriptionRead(raw: unknown): PrescriptionRead | { error: string } {
  const parsed = rxRead.safeParse(raw);
  if (!parsed.success) return { error: "UNREADABLE_PRESCRIPTION" };
  const flags: string[] = [];
  const medications = parsed.data.medications.map((m): ReadMedication => {
    const f: string[] = [];
    const take = <T,>(c: Cleaned<T>) => { if (c.flag) f.push(c.flag); return c.value; };
    return {
      drug: take(cleanDrug(m.drug)),
      strength: take(cleanStrength(m.strength)),
      frequency: take(cleanFrequency(m.frequency)),
      prescriber: take(cleanPerson(m.prescriber)),
      confidence: m.confidence ?? {},
      flags: f,
    };
  });
  const name = clean(parsed.data.patient_name, PERSON, "patient_name", 5);
  if (name.flag) flags.push(name.flag);
  return { legible: parsed.data.legible !== false, patientName: name.value, medications, flags };
}

// ------------------------------------------------------------------ bottle labels

const labelRead = z.object({
  legible: z.boolean().optional(),
  product_name: z.unknown().optional(),
  active_ingredient: z.unknown().optional(),
  strength: z.unknown().optional(),
  expiry: z.unknown().optional(),
  confidence: z.object({ product_name: conf, active_ingredient: conf, strength: conf, expiry: conf }).partial().optional(),
});

export interface LabelRead {
  legible: boolean;
  productName?: string;
  activeIngredient?: string;
  /** As printed, e.g. "100 mg / 5 mL". */
  strength?: string;
  /** Normalised to "YYYY-MM" or "YYYY-MM-DD". */
  expiry?: string;
  confidence: Partial<Record<"product_name" | "active_ingredient" | "strength" | "expiry", number>>;
  flags: string[];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "06/2027", "2027-06", "Jun 2027", "EXP 06/27", "2027-06-30" -> "2027-06" or "2027-06-30". Anything else -> undefined. */
export function normaliseExpiry(text: string): string | undefined {
  const t = text.trim().toLowerCase().replace(/^(exp(iry|\.)?|use by|best by)[:.\s]*/, "");
  let m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(t);
  if (m) return m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`;
  m = /^(\d{1,2})[/.-](\d{4}|\d{2})$/.exec(t);
  if (m) return `${m[2]!.length === 2 ? `20${m[2]}` : m[2]}-${m[1]!.padStart(2, "0")}`;
  m = /^([a-z]{3})[a-z]*\.?\s+(\d{4}|\d{2})$/.exec(t);
  if (m && MONTHS.includes(m[1]!)) return `${m[2]!.length === 2 ? `20${m[2]}` : m[2]}-${String(MONTHS.indexOf(m[1]!) + 1).padStart(2, "0")}`;
  return undefined;
}

export function parseLabelRead(raw: unknown): LabelRead | { error: string } {
  const p = labelRead.safeParse(raw);
  if (!p.success) return { error: "UNREADABLE_LABEL" };
  const flags: string[] = [];
  const take = <T,>(c: Cleaned<T>) => { if (c.flag) flags.push(c.flag); return c.value; };
  const expiryRaw = take(clean(p.data.expiry, /^[\p{L}\p{N} ./:-]{1,20}$/u, "expiry", 3));
  const expiry = expiryRaw ? normaliseExpiry(expiryRaw) : undefined;
  if (expiryRaw && !expiry) flags.push("UNREADABLE_FIELD:expiry");
  return {
    legible: p.data.legible !== false,
    productName: take(cleanDrug(p.data.product_name)),
    activeIngredient: take(cleanDrug(p.data.active_ingredient)),
    strength: take(clean(p.data.strength, /^[\d.,]{1,9}\s?(mg|mcg|g|ml|%)(\s?(\/|per)\s?[\d.,]{0,9}\s?(ml|tab|tablet|capsule|dose))?$/i, "strength", 6)),
    expiry,
    confidence: p.data.confidence ?? {},
    flags,
  };
}
