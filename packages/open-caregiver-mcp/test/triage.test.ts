import { beforeEach, describe, expect, it } from "vitest";
import { CareService, MemoryAdapter, MemoryNotifier, RED_FLAG_RULES, SIGNS, buildPdf, createSeed, triage, type Sign } from "../src/server.js";
import { DAY, H, NOW } from "./helpers.js";

let now: number;
let storage: MemoryAdapter;
let svc: CareService;
let notifier: MemoryNotifier;
const sarah = { caregiverId: "sarah" };

beforeEach(() => {
  now = NOW;
  notifier = new MemoryNotifier();
  storage = new MemoryAdapter(createSeed(now));
  svc = new CareService(storage, { clock: () => now, notifier, signingSecret: "t" });
});
const tri = (a: Record<string, unknown>) => svc.escalation.triageSymptoms({ patient_id: "leo", ...a } as any, sarah);

describe("the rules are data with sources", () => {
  it("every rule has an id, a trigger, an urgency, and a source that was actually read (name, https url, date)", () => {
    const ids = new Set<string>();
    for (const r of RED_FLAG_RULES) {
      expect(ids.has(r.id), r.id).toBe(false);
      ids.add(r.id);
      expect(r.trigger.length).toBeGreaterThan(5);
      expect(r.source.url).toMatch(/^https:\/\//);
      expect(r.source.retrieved).toBe("2026-10-19");
      expect(r.anySigns?.length || r.tempFAtLeast || r.feverDaysOver, r.id).toBeTruthy();
    }
  });
  it("every sign a caregiver can report is covered by at least one rule", () => {
    const covered = new Set(RED_FLAG_RULES.flatMap((r) => r.anySigns ?? []));
    for (const s of SIGNS) expect(covered.has(s), s).toBe(true);
  });
  it("the one threshold the cited page does not state carries a note saying so", () => {
    const r = RED_FLAG_RULES.find((x) => x.id === "RF-CHILD-DEHYDRATION")!;
    expect(r.note).toMatch(/does NOT state an 8-hour threshold/);
  });
});

describe("triage engine: signs and age, not temperature alone", () => {
  const base = { onAnticoagulant: false, signs: [] as Sign[] };
  it("C9: an infant under 3 months with 100.4°F is escalated and home dosing is withheld", () => {
    const r = triage({ ...base, ageDays: 40, tempF: 100.4 });
    expect(r).toMatchObject({ urgency: "GO_TO_ER_NOW", noHomeDosing: true });
    expect(r.matched[0]!.id).toBe("RF-INFANT-FEVER-U3M");
  });
  it("boundaries: 99.9°F is not the rule, and a 4-month-old with 101°F and no signs is not an emergency", () => {
    expect(triage({ ...base, ageDays: 40, tempF: 99.9 }).urgency).toBe("HOME_CARE_OK_WITH_WATCH");
    expect(triage({ ...base, ageDays: 120, tempF: 101 }).urgency).toBe("HOME_CARE_OK_WITH_WATCH");
    expect(triage({ ...base, ageDays: 83, tempF: 100.4 }).urgency).toBe("GO_TO_ER_NOW");
    expect(triage({ ...base, ageDays: 84, tempF: 100.4 }).urgency).toBe("HOME_CARE_OK_WITH_WATCH");
  });
  it("a 104°F toddler who is playful is a call-the-doctor, not an emergency; the same child hard to wake is an emergency", () => {
    expect(triage({ ...base, ageDays: 500, tempF: 104.2 }).urgency).toBe("CALL_DOCTOR_TODAY");
    expect(triage({ ...base, ageDays: 500, tempF: 104.2, signs: ["unresponsive_or_hard_to_wake"] }).urgency).toBe("CALL_EMERGENCY");
  });
  it("the strongest rule wins and every matching rule is reported", () => {
    const r = triage({ ...base, ageDays: 40, tempF: 101, signs: ["stiff_neck", "repeated_vomiting"] });
    expect(r.urgency).toBe("CALL_EMERGENCY");
    expect(r.matched.map((m) => m.id)).toEqual(expect.arrayContaining(["RF-ANY-STIFF-NECK", "RF-ANY-VOMITING", "RF-INFANT-FEVER-U3M"]));
  });
  it("C15: fever duration uses the AAP age split (over 1 day under 2y, over 3 days from 2y)", () => {
    expect(triage({ ...base, ageDays: 400, feverDays: 1 }).urgency).toBe("HOME_CARE_OK_WITH_WATCH");
    expect(triage({ ...base, ageDays: 400, feverDays: 1.5 }).urgency).toBe("CALL_DOCTOR_TODAY");
    expect(triage({ ...base, ageDays: 1000, feverDays: 3 }).urgency).toBe("HOME_CARE_OK_WITH_WATCH");
    expect(triage({ ...base, ageDays: 1000, feverDays: 4 }).urgency).toBe("CALL_DOCTOR_TODAY");
  });
  it("C10: a vomited dose forbids re-dosing and refers to a clinician", () => {
    const r = triage({ ...base, ageDays: 270, signs: ["vomited_after_dose"] });
    expect(r).toMatchObject({ urgency: "CALL_DOCTOR_TODAY", noHomeDosing: true });
  });
  it("C13: dehydration signs apply to babies and young children only", () => {
    expect(triage({ ...base, ageDays: 270, signs: ["no_wet_diaper_8h"] }).urgency).toBe("CALL_DOCTOR_TODAY");
    expect(triage({ ...base, ageDays: 30 * 365, signs: ["no_wet_diaper_8h"] }).urgency).toBe("HOME_CARE_OK_WITH_WATCH");
  });
  it("E3: a head strike is urgent ONLY for an adult on a blood thinner", () => {
    const adult = 78 * 365;
    expect(triage({ ageDays: adult, signs: ["head_strike"], onAnticoagulant: true }).urgency).toBe("GO_TO_ER_NOW");
    expect(triage({ ageDays: adult, signs: ["head_strike"], onAnticoagulant: false }).urgency).toBe("HOME_CARE_OK_WITH_WATCH");
  });
  it("E4 / E10 / anaphylaxis are emergencies at any age", () => {
    for (const s of ["face_drooping", "arm_weakness", "speech_difficulty", "chest_pain", "severe_shortness_of_breath", "lip_or_throat_swelling"] as Sign[]) {
      expect(triage({ ...base, ageDays: 78 * 365, signs: [s] }).urgency, s).toBe("CALL_EMERGENCY");
    }
  });
  it("the checklist only asks what is relevant for this person and has not been reported", () => {
    const baby = triage({ ...base, ageDays: 270 }).checklist;
    expect(baby).toContain("sunken_soft_spot");
    expect(baby).not.toContain("head_strike");
    const elder = triage({ ageDays: 78 * 365, signs: ["chest_pain"], onAnticoagulant: true }).checklist;
    expect(elder).toContain("head_strike");
    expect(elder).not.toContain("chest_pain");
    expect(elder).not.toContain("sunken_soft_spot");
  });
  it("is deterministic and never returns 'all clear' wording as an urgency", () => {
    const a = triage({ ...base, ageDays: 500, tempF: 102 });
    expect(a).toEqual(triage({ ...base, ageDays: 500, tempF: 102 }));
    expect(a.urgency).toBe("HOME_CARE_OK_WITH_WATCH");
  });
});

describe("triage_symptoms", () => {
  it("with nothing reported it asks, with a checklist for this person", async () => {
    const r = await tri({});
    expect(r).toMatchObject({ status: "NEEDS_INFO", card_type: "RED_FLAG_CHECKLIST", missing: "signs" });
    expect((r.checklist as any[]).every((c) => c.question.includes("Leo") || /soft spot|rash|glass/.test(c.question))).toBe(true);
    expect(await storage.getEpisodes("leo")).toEqual([]);
  });

  it("unknown or ambiguous patients are asked about, never defaulted", async () => {
    expect(await svc.escalation.triageSymptoms({ patient_id: "the baby", signs: ["seizure"] }, sarah)).toMatchObject({ status: "NEEDS_INFO", missing: "patient" });
  });

  it("an emergency sign returns the emergency card with the number, hospitals, a summary, and alerts the other caregivers", async () => {
    const r: any = await tri({ signs: ["difficulty_breathing"] });
    expect(r).toMatchObject({ status: "CALL_EMERGENCY", card_type: "EMERGENCY_LOCATOR", read_verbatim: true });
    expect(r.speech).toBe("This could be an emergency. Call 9 1 1 now.");
    expect(r.emergency).toMatchObject({ number: "911", tel: "tel:911", caregivers_notified: true });
    expect(r.emergency.hospitals).toHaveLength(3);
    expect(r.emergency.hospitals.every((h: any) => h.sample === true)).toBe(true);
    expect(r.emergency.hospitals_source).toMatchObject({ live: false });
    expect(r.emergency.disclosure).toMatch(/never calls anyone/);
    expect(r.emergency.sbar.script).toContain("Leo");
    expect(notifier.sent.some((n) => n.kind === "EMERGENCY")).toBe(true);
    expect(r.rules[0].source.url).toMatch(/^https:/);
  });

  it("India locale says 112 and does not invent a poison line", async () => {
    svc = new CareService(storage, { clock: () => now, notifier, locale: "IN", signingSecret: "t" });
    const r: any = await tri({ signs: ["seizure"] });
    expect(r.emergency).toMatchObject({ number: "112", ambulance_number: "108", locale: "IN" });
    expect(r.emergency.poison.number).toBeNull();
    expect(r.emergency.hospitals[0].distanceUnit).toBe("km");
  });

  it("E3: Frank falls and hits his head: his Eliquis makes it urgent; Leo's head strike is not in the rules", async () => {
    const r: any = await svc.escalation.triageSymptoms({ patient_id: "frank", signs: ["head_strike"] }, sarah);
    expect(r).toMatchObject({ status: "GO_TO_ER_NOW", card_type: "EMERGENCY_LOCATOR" });
    expect(r.reason_codes).toEqual(["RF-HEAD-ANTICOAGULANT"]);
    expect(r.speech).toContain("blood thinner");
  });

  it("a mild report is not called 'fine': it says what it cannot do and keeps the checklist", async () => {
    const r: any = await tri({ temperature_value: 101.4, temperature_unit: "F" });
    expect(r.status).toBe("HOME_CARE_OK_WITH_WATCH");
    expect(r.speech).toMatch(/can't diagnose/);
    expect(r.speech).not.toMatch(/\bfine\b|\bsafe\b/);
    expect(r.checklist.length).toBeGreaterThan(0);
  });

  it("asks for the unit rather than guessing, and rejects an implausible reading", async () => {
    expect(await tri({ temperature_value: 45 })).toMatchObject({ status: "NEEDS_INFO", missing: "unit" });
    expect(await tri({ temperature_value: 200, temperature_unit: "F" })).toMatchObject({ status: "NEEDS_INFO", missing: "value" });
    expect(await tri({ fever_days: 400 })).toMatchObject({ status: "NEEDS_INFO", missing: "fever_days" });
  });

  it("uses a temperature logged in the last few hours, but not an old one", async () => {
    await svc.logObservation({ patient_id: "leo", type: "temperature", value: 104.5, unit: "F" }, sarah);
    expect((await tri({ signs: ["repeated_vomiting"] })).reason_codes).toEqual(expect.arrayContaining(["RF-CHILD-TEMP-104", "RF-ANY-VOMITING"]));
    now += 7 * H;
    expect((await tri({ signs: ["repeated_vomiting"] })).reason_codes).toEqual(["RF-ANY-VOMITING"]);
  });

  it("keeps one episode open with a timeline, the strongest urgency, and every rule that fired", async () => {
    await tri({ signs: ["repeated_vomiting"] });
    now += 10 * 60_000;
    await tri({ signs: ["stiff_neck"] });
    const eps = await storage.getEpisodes("leo");
    expect(eps).toHaveLength(1);
    expect(eps[0]).toMatchObject({ status: "OPEN", urgency: "CALL_EMERGENCY" });
    expect(eps[0]!.redFlags).toEqual(expect.arrayContaining(["RF-ANY-VOMITING", "RF-ANY-STIFF-NECK"]));
    expect(eps[0]!.timeline.map((t) => t.type)).toEqual(["OPENED", "TRIAGE", "TRIAGE"]);
  });

  it("audits every call", async () => {
    await tri({ signs: ["seizure"] });
    expect((await storage.getAudit()).find((a) => a.tool === "triage_symptoms")).toMatchObject({ verdict: "CALL_EMERGENCY", reasonCodes: ["RF-ANY-SEIZURE"] });
  });
});

describe("C10: a vomited dose holds home dosing", () => {
  it("plan_medication refuses with the reason, then releases after the hold", async () => {
    await tri({ signs: ["vomited_after_dose"] });
    const held = await svc.planMedication({ patient_id: "leo", product: "Motrin", last_dose_elsewhere: "none_today" }, sarah);
    expect(held).toMatchObject({ status: "NEEDS_CLINICIAN", violation_type: "EPISODE_NO_HOME_DOSING" });
    expect(held.speech).toMatch(/nurse line or pediatrician/);
    expect(held.speech).not.toMatch(/\d/);
    now += 13 * H;
    const later = await svc.planMedication({ patient_id: "leo", product: "Motrin", last_dose_elsewhere: "none_today" }, sarah);
    expect(later.status).not.toBe("NEEDS_CLINICIAN");
  });
  it("a hold on Leo does not touch Frank", async () => {
    await tri({ signs: ["vomited_after_dose"] });
    const frank = await svc.planMedication({ patient_id: "frank", product: "Tylenol Extra Strength", last_dose_elsewhere: "none_today" }, sarah);
    expect((frank as any).violation_type).not.toBe("EPISODE_NO_HOME_DOSING");
  });
});

describe("episodes in the household context", () => {
  it("shows an active episode and a due check-in, and logs doses on its timeline", async () => {
    await tri({ signs: ["repeated_vomiting"] });
    const ctx: any = await svc.getHouseholdContext({}, sarah);
    expect(ctx.active_episodes[0]).toMatchObject({ patient_id: "leo", urgency: "CALL_DOCTOR_TODAY" });
    expect(ctx.active_episodes[0].checkin_due).toMatch(/temperature been checked/);
    await svc.logObservation({ patient_id: "leo", type: "temperature", value: 101, unit: "F" }, sarah);
    expect(((await svc.getHouseholdContext({}, sarah)) as any).active_episodes[0].checkin_due).toBeNull();
    now += 25 * H;
    expect(((await svc.getHouseholdContext({}, sarah)) as any).active_episodes).toEqual([]);
  });
});

describe("emergency_assist", () => {
  it("shows the card without asking who first, then asks afterwards", async () => {
    const r: any = await svc.escalation.emergencyAssist({ reason: "Dad collapsed" }, sarah);
    expect(r).toMatchObject({ status: "CALL_EMERGENCY", card_type: "EMERGENCY_LOCATOR" });
    expect(r.emergency.sbar).toBeNull();
    const withPatient: any = await svc.escalation.emergencyAssist({ patient_id: "frank", reason: "chest pain" }, sarah);
    expect(withPatient.emergency.sbar.script).toContain("Frank");
    const unknown: any = await svc.escalation.emergencyAssist({ patient_id: "the baby" }, sarah);
    expect(unknown.card_type).toBe("EMERGENCY_LOCATOR");
    expect(unknown.followup).toMatch(/tell me who/);
  });
  it("bounds free text, uses a location you give, and never claims live data", async () => {
    const r: any = await svc.escalation.emergencyAssist({ reason: "x".repeat(500), latitude: 28.61, longitude: 77.2 }, sarah);
    expect(r.emergency.origin.label).toBe("Location you gave");
    expect(r.emergency.hospitals_source.live).toBe(false);
    expect(notifier.sent.at(-1)!.text.length).toBeLessThan(200);
  });
});

describe("export_care_summary", () => {
  beforeEach(async () => {
    await svc.logObservation({ patient_id: "leo", type: "temperature", value: 103.1, unit: "F" }, sarah);
    const r = await svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: "Sarah (Mom)" }, sarah);
    await svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: "Sarah (Mom)", confirmation_token: r.confirmation_token as string }, sarah);
  });
  it("builds an SBAR script from the chart with its numbers and times, and says what is missing", async () => {
    const r: any = await svc.escalation.exportCareSummary({ patient_id: "leo", kind: "sbar" }, sarah);
    expect(r).toMatchObject({ status: "SBAR_READY", card_type: "NURSE_LINE_BRIEF" });
    expect(r.sbar.situation).toContain("Leo, 9 months old, 19 lb, weighed 2 days ago");
    expect(r.sbar.assessment).toContain("103.1°F");
    expect(r.sbar.assessment).toContain("75 mg, 1.875 mL");
    expect(r.sbar.background).toContain("Allergies: none reported");
    expect(r.sbar.recommendation).toMatch(/not asking for a diagnosis/);
    expect(r.speech.split(" ").length).toBeLessThan(80);
  });
  it("does not list an unconfirmed photo medicine as 'taking'", async () => {
    await storage.savePrescription({ id: "rx", patientId: "frank", drug: "Tamsulosin", status: "PENDING", source: "photo", flags: [], createdAt: now });
    const r: any = await svc.escalation.exportCareSummary({ patient_id: "frank", kind: "sbar" }, sarah);
    expect(r.sbar.background).toContain("Regular medicines: eliquis; metformin");
    expect(r.sbar.background).toContain("Not yet confirmed from a photo: Tamsulosin");
    expect(r.sbar.background).not.toMatch(/Regular medicines:[^.]*Tamsulosin/);
  });
  it("the dossier returns a PDF link, counts, and valid PDF bytes with the chart's facts", async () => {
    const r: any = await svc.escalation.exportCareSummary({ patient_id: "leo", kind: "dossier" }, sarah);
    expect(r).toMatchObject({ status: "SUMMARY_READY", hours: 48, counts: { temperatures: 1, doses: 1 } });
    expect(r.pdf.download_path).toBe("/api/patients/leo/dossier.pdf?hours=48");
    const { bytes } = await svc.escalation.dossierPdf("leo", 48);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("Care summary: Leo");
    expect(text).toContain("103.1\xB0F");
    expect(text).toContain("ibuprofen");
    expect(text).toContain("not medical advice");
  });
  it("windows are bounded", async () => {
    expect(((await svc.escalation.exportCareSummary({ patient_id: "leo", kind: "dossier", hours: 99999 }, sarah)) as any).hours).toBe(168);
    expect(((await svc.escalation.exportCareSummary({ patient_id: "leo", kind: "dossier", hours: -5 }, sarah)) as any).hours).toBe(1);
  });
});

describe("pdf writer", () => {
  it("writes a structurally valid file: xref offsets point at their objects, and long text wraps onto more pages", () => {
    const blocks = [{ type: "title" as const, text: "T (with) \\ parens" }, ...Array.from({ length: 120 }, (_, i) => ({ type: "mono" as const, text: `row ${i} ${"x".repeat(100)}` }))];
    const buf = Buffer.from(buildPdf(blocks));
    const s = buf.toString("latin1");
    const start = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(start, start + 4)).toBe("xref");
    const entries = [...s.slice(start).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    entries.forEach((off, i) => expect(s.slice(off, off + `${i + 1} 0 obj`.length), `object ${i + 1}`).toBe(`${i + 1} 0 obj`));
    expect(Number(/\/Count (\d+)/.exec(s)![1])).toBeGreaterThan(1);
  });
});

describe("'none of these' and the nurse-line wording", () => {
  it("no_warning_signs answers the checklist without inventing data, and the summary quotes only what was reported", async () => {
    const r: any = await tri({ no_warning_signs: true });
    expect(r).toMatchObject({ status: "HOME_CARE_OK_WITH_WATCH" });
    const eps = await storage.getEpisodes("leo");
    expect(eps[0]!.concern).toBe("no warning signs");
    const s: any = await svc.escalation.exportCareSummary({ patient_id: "leo", kind: "sbar" }, sarah);
    expect(s.sbar.situation).toContain("Concern: no warning signs.");
    expect(s.sbar.situation).not.toMatch(/Advice|RF-|HOME_CARE/);
  });
  it("after a real report, the concern is the plain list of signs", async () => {
    await tri({ signs: ["stiff_neck"], temperature_value: 101.4, temperature_unit: "F" });
    const s: any = await svc.escalation.exportCareSummary({ patient_id: "leo", kind: "sbar" }, sarah);
    expect(s.sbar.situation).toContain("Concern: stiff neck, temperature 101.4°F.");
  });
});
