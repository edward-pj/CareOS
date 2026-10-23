import { clock, fmtNumber } from "./speech.js";
import type { DoseEvent, Episode, Observation, Patient } from "../storage/types.js";

// Facts about one person, assembled from what is stored, and the two documents built from them: the 20-second nurse-line
// script (SBAR) and the doctor's dossier. Nothing here is invented or computed medically: it restates the chart, with its
// times and units, and says plainly when something is missing.

const DAY = 86_400_000;
const H = 3_600_000;

export interface CareFacts {
  now: number;
  patient: Patient;
  ageText: string;
  weight?: { lb: number; daysAgo: number };
  temperatures: { at: number; text: string }[];
  doses: { at: number; medication: string; ingredient: string; amount: string; caregiver: string }[];
  episode?: Episode;
  /** Confirmed medicines only. Pending photo reads never appear as "taking". */
  activeMedicines: string[];
  pendingMedicines: string[];
}

export function ageText(ageDays: number): string {
  if (ageDays < 14) return `${ageDays} days old`;
  if (ageDays < 84) return `${Math.floor(ageDays / 7)} weeks old`;
  const months = Math.floor(ageDays / 30.4375);
  if (months < 24) return `${months} months old`;
  return `${Math.floor(ageDays / 365.25)} years old`;
}

export function gatherFacts(a: {
  now: number;
  patient: Patient;
  ledger: DoseEvent[];
  observations: Observation[];
  episodes: Episode[];
  pendingMedicines?: string[];
  windowHours: number;
}): CareFacts {
  const { now, patient, windowHours } = a;
  const since = now - windowHours * H;
  const ageDays = Math.max(0, Math.floor((now - patient.dobMs) / DAY));
  return {
    now,
    patient,
    ageText: ageText(ageDays),
    weight: patient.weightLbs !== undefined && patient.weightAt !== undefined ? { lb: patient.weightLbs, daysAgo: Math.max(0, Math.floor((now - patient.weightAt) / DAY)) } : undefined,
    temperatures: a.observations.filter((o) => o.type === "temperature" && o.at >= since).sort((x, y) => x.at - y.at).map((o) => ({ at: o.at, text: `${fmtNumber(o.value)}°${o.unit}` })),
    doses: a.ledger
      .filter((e) => e.at >= since)
      .sort((x, y) => x.at - y.at)
      .map((e) => ({
        at: e.at,
        medication: e.medication,
        ingredient: e.ingredient,
        amount: [e.amountMg !== undefined ? `${fmtNumber(e.amountMg)} mg` : undefined, e.volumeMl !== undefined ? `${fmtNumber(e.volumeMl)} mL` : undefined].filter(Boolean).join(", ") || "amount not recorded",
        caregiver: e.caregiver,
      })),
    episode: a.episodes.find((e) => e.status === "OPEN"),
    activeMedicines: patient.activeRx,
    pendingMedicines: a.pendingMedicines ?? [],
  };
}

export interface Sbar {
  situation: string;
  background: string;
  assessment: string;
  recommendation: string;
  /** All four parts, for the on-screen large-type card. */
  script: string;
  /** The ~20 second version, read aloud. */
  speech: string;
}

const list = (xs: string[], none: string) => (xs.length ? xs.join("; ") : none);

/** Situation, Background, Assessment, Recommendation: the order nurse lines and triage staff expect. */
export function buildSbar(f: CareFacts, opts: { caller?: string; concern?: string } = {}): Sbar {
  const p = f.patient;
  const weight = f.weight ? `${fmtNumber(f.weight.lb)} lb, weighed ${f.weight.daysAgo === 0 ? "today" : `${f.weight.daysAgo} ${f.weight.daysAgo === 1 ? "day" : "days"} ago`}` : "weight not on file";
  const concern = opts.concern ?? f.episode?.concern ?? "a health concern";
  const lastTemp = f.temperatures.at(-1);
  const meds = f.doses.map((d) => `${d.medication} ${d.amount} at ${clock(d.at)} by ${d.caregiver}`);

  const situation = `${opts.caller ? `${opts.caller} is calling about ` : "Calling about "}${p.name}, ${f.ageText}, ${weight}. Concern: ${concern}.`;
  const background = [
    `Allergies: ${list(p.allergies, "none reported")}.`,
    `Conditions: ${list(p.conditions, "none reported")}.`,
    `Regular medicines: ${list(f.activeMedicines, "none confirmed")}.`,
    f.pendingMedicines.length ? `Not yet confirmed from a photo: ${f.pendingMedicines.join(", ")}.` : undefined,
  ].filter(Boolean).join(" ");
  const assessment = [
    f.temperatures.length ? `Temperatures: ${f.temperatures.map((t) => `${t.text} at ${clock(t.at)}`).join(", ")}.` : "No temperature logged in this period.",
    meds.length ? `Medicine given: ${meds.join("; ")}.` : "No medicine logged in this period.",
    f.episode?.redFlags.length ? `Warning signs reported: ${f.episode.redFlags.join(", ")}.` : undefined,
  ].filter(Boolean).join(" ");
  const recommendation = "I'd like advice on what to do next and whether to be seen. I am not asking for a diagnosis.";

  const script = [`SITUATION\n${situation}`, `BACKGROUND\n${background}`, `ASSESSMENT\n${assessment}`, `REQUEST\n${recommendation}`].join("\n\n");
  const speech = [
    `This is about ${p.name}, ${f.ageText}, ${f.weight ? `${fmtNumber(f.weight.lb)} pounds` : "weight unknown"}.`,
    `Concern: ${concern}.`,
    lastTemp ? `Last temperature ${lastTemp.text} at ${clock(lastTemp.at)}.` : undefined,
    meds.length ? `Last medicine: ${meds.at(-1)}.` : undefined,
    `Allergies: ${list(p.allergies, "none reported")}.`,
  ].filter(Boolean).join(" ");
  return { situation, background, assessment, recommendation, script, speech };
}

// ------------------------------------------------------------------ the doctor's dossier

export type PdfBlock = { type: "title" | "heading" | "text" | "mono" | "gap"; text: string };

/** Chronological, plain, and honest about its source: caregiver-reported data, not a medical record. */
export function dossierBlocks(f: CareFacts, opts: { windowHours: number; preparedFor?: string; generatedBy?: string }): PdfBlock[] {
  const p = f.patient;
  const when = (ms: number) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const blocks: PdfBlock[] = [
    { type: "title", text: `Care summary: ${p.name}` },
    { type: "text", text: `${f.ageText}${f.weight ? `, ${fmtNumber(f.weight.lb)} lb (weighed ${f.weight.daysAgo} days ago)` : ""}. Last ${opts.windowHours} hours, prepared ${when(f.now)}${opts.preparedFor ? ` for ${opts.preparedFor}` : ""}.` },
    { type: "gap", text: "" },
    { type: "heading", text: "Profile" },
    { type: "mono", text: `Allergies:         ${list(p.allergies, "none reported")}` },
    { type: "mono", text: `Conditions:        ${list(p.conditions, "none reported")}` },
    { type: "mono", text: `Regular medicines: ${list(f.activeMedicines, "none confirmed")}` },
  ];
  if (f.pendingMedicines.length) blocks.push({ type: "mono", text: `Not yet confirmed (from a photo): ${f.pendingMedicines.join(", ")}` });
  blocks.push({ type: "gap", text: "" }, { type: "heading", text: "Temperatures" });
  blocks.push(...(f.temperatures.length ? f.temperatures.map((t) => ({ type: "mono" as const, text: `${when(t.at).padEnd(18)} ${t.text}` })) : [{ type: "mono" as const, text: "None logged in this period." }]));
  blocks.push({ type: "gap", text: "" }, { type: "heading", text: "Medicine given (ingredient, amount, time, who)" });
  blocks.push(...(f.doses.length ? f.doses.map((d) => ({ type: "mono" as const, text: `${when(d.at).padEnd(18)} ${d.ingredient.padEnd(14)} ${d.amount.padEnd(22)} ${d.caregiver}` })) : [{ type: "mono" as const, text: "None logged in this period." }]));
  if (f.episode) {
    blocks.push({ type: "gap", text: "" }, { type: "heading", text: "Episode timeline" });
    blocks.push(...f.episode.timeline.map((t) => ({ type: "mono" as const, text: `${when(t.at).padEnd(18)} ${t.text}` })));
  }
  blocks.push(
    { type: "gap", text: "" },
    { type: "text", text: "Prepared by CareOS from what caregivers reported and what the safety engine recorded. It is not a medical record and not medical advice. Please verify with the caregiver." },
  );
  return blocks;
}
