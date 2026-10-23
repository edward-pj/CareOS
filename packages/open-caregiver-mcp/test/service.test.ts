import { beforeEach, describe, expect, it } from "vitest";
import { CareService, MemoryAdapter, MemoryNotifier, createSeed } from "../src/server.js";
import type { SeedData } from "../src/storage/seed.js";
import { DAY, MIN, NOW } from "./helpers.js";

let now: number;
let notifier: MemoryNotifier;
let storage: MemoryAdapter;
let svc: CareService;

function boot(seed: SeedData) {
  storage = new MemoryAdapter(seed);
  svc = new CareService(storage, { clock: () => now, notifier, signingSecret: "test-secret" });
}
beforeEach(() => {
  now = NOW;
  notifier = new MemoryNotifier();
  boot(createSeed(now, { motrinMl: 15 }));
});

const ctx = { caregiverId: "sarah" };
const plan = (extra = {}, patient = "leo", product = "Motrin") => svc.planMedication({ patient_id: patient, product, last_dose_elsewhere: "none_today", ...extra }, ctx);
const readBack = (caregiver = "Sarah (Mom)", extra = {}) => svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: caregiver, ...extra }, ctx);
/** The full two-step flow: read back, then confirm with the token. */
async function give(caregiver = "Sarah (Mom)", extra = {}) {
  const r = await readBack(caregiver, extra);
  if (r.status !== "NEEDS_CONFIRMATION") return r;
  return svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: caregiver, confirmation_token: r.confirmation_token as string, ...extra }, ctx);
}
const ledger = () => storage.getLedger("leo");
const bottle = async () => (await storage.getInventory()).find((i) => i.id === "infant_motrin_drops")!.remaining;

describe("S7 / C3: never default to a person", () => {
  it("'the baby', blank and unknown references are questions back, naming who the options are", async () => {
    for (const ref of ["baby", "the baby", "", "him", "grandpa"]) {
      const r = await plan({}, ref);
      expect(r, ref).toMatchObject({ status: "NEEDS_INFO", missing: "patient", options: ["Leo", "Frank"] });
      expect(r.speech).toBe("Who is this for: Leo or Frank?");
    }
  });

  it("ids, names and the old 'infant_' prefix all resolve", async () => {
    for (const ref of ["leo", "LEO", "Leo", "infant_leo"]) expect((await plan({}, ref)).patient_id, ref).toBe("leo");
    expect((await plan({}, "frank", "Advil")).patient_id).toBe("frank");
  });

  it("with exactly one person in the house, a generic reference is unambiguous", async () => {
    const seed = createSeed(now);
    seed.patients = seed.patients.filter((p) => p.id === "leo");
    seed.advice = [];
    boot(seed);
    expect((await plan({}, "the baby")).patient_id).toBe("leo");
    expect(await plan({}, "frank")).toMatchObject({ status: "NEEDS_INFO" }); // a named stranger is still a question
  });
});

describe("plan_medication at the service layer", () => {
  it("approves 1.875 mL for Leo from the seeded, fresh weight", async () => {
    expect(await plan()).toMatchObject({ status: "APPROVED", dispense_volume_ml: 1.875, patient_id: "leo" });
  });

  it("a newly reported weight is saved with its date, so the next dose uses it without being told again", async () => {
    const seed = createSeed(now);
    seed.patients[0]!.weightAt = now - 40 * DAY;
    boot(seed);
    expect(await plan()).toMatchObject({ status: "NEEDS_INFO", missing: "weight" }); // stale
    expect(await plan({ weight_value: 20, weight_unit: "lb" })).toMatchObject({ status: "APPROVED", weight_source: "reported", dispense_volume_ml: 1.875 });
    expect(await storage.getPatient("leo")).toMatchObject({ weightLbs: 20, weightAt: now });
    expect((await storage.getObservations("leo", "weight")).at(-1)).toMatchObject({ value: 20, unit: "lb" });
    expect(await plan()).toMatchObject({ status: "APPROVED", weight_source: "on_file" });
  });

  it("an implausible or unit-less weight is not saved", async () => {
    await plan({ weight_value: 19, weight_unit: "kg" });
    await plan({ weight_value: 19 });
    expect((await storage.getObservations("leo", "weight")).map((o) => o.id)).toEqual(["seed-weight-leo"]);
  });

  it("S3: a dose the caregiver says was given elsewhere is recorded and holds the lock even if nobody mentions it again", async () => {
    const first = await plan({ last_dose_elsewhere: "gave_earlier", elsewhere_minutes_ago: 25 });
    expect(first).toMatchObject({ status: "BLOCKED", violation_type: "DOUBLE_DOSE_LOCKED" });
    expect(first.speech).toContain("given elsewhere");
    const again = await svc.planMedication({ patient_id: "leo", product: "Motrin" }, ctx);
    expect(again).toMatchObject({ status: "BLOCKED", violation_type: "DOUBLE_DOSE_LOCKED" });
    expect((await ledger()).map((e) => e.caregiver)).toEqual(["Given elsewhere"]);
    expect(await bottle()).toBe(15); // not from this house's bottle
  });

  it("reporting the same elsewhere dose twice does not double-count it", async () => {
    await plan({ last_dose_elsewhere: "gave_earlier", elsewhere_minutes_ago: 25 });
    await plan({ last_dose_elsewhere: "gave_earlier", elsewhere_minutes_ago: 25 });
    expect(await ledger()).toHaveLength(1);
  });

  it("notifies other caregivers on a lock attempt and on a critical block, but not on an approval", async () => {
    await plan();
    expect(notifier.sent).toEqual([]);
    await give("Sarah (Mom)");
    notifier.sent.length = 0;
    await plan();
    expect(notifier.sent[0]).toMatchObject({ kind: "LOCKOUT_ATTEMPT" });
    notifier.sent.length = 0;
    await plan({}, "frank", "Advil");
    expect(notifier.sent[0]).toMatchObject({ kind: "CRITICAL_BLOCK" });
  });
});

describe("confirm_dose_given: read back, then log", () => {
  it("step 1 reads the entry back and writes NOTHING", async () => {
    const r = await readBack();
    expect(r).toMatchObject({ status: "NEEDS_CONFIRMATION", card_type: "CONFIRM_DOSE", dose_display: "1.875 mL", given_by: "Sarah", given_label: "just now", read_verbatim: true });
    expect(r.speech).toBe("Logging 1.875 milliliters of Infants' Motrin for Leo, given by Sarah just now. Is that correct?");
    expect(String(r.confirmation_token)).toMatch(/^\d+\.[0-9a-f]{64}$/);
    expect(await ledger()).toEqual([]);
    expect(await bottle()).toBe(15);
    expect(notifier.sent).toEqual([]);
  });

  it("step 2 logs the verified dose, starts the lock, decrements the right bottle and alerts the house", async () => {
    const r = await give();
    expect(r).toMatchObject({ status: "LOGGED", replay: false, dose_display: "1.875 mL", bottle_remaining_ml: 13.125, low_stock: false, card_type: null });
    expect(r.speech).toMatch(/^Logged\. The next Infants' Motrin for Leo is allowed after /);
    const [row] = await ledger();
    expect(row).toMatchObject({ ingredient: "ibuprofen", sku: "infants_motrin_drops", volumeMl: 1.875, amountMg: 75, caregiver: "Sarah (Mom)", medication: "Infants' Motrin" });
    expect(await bottle()).toBe(13.125);
    expect(notifier.sent[0]).toMatchObject({ kind: "DOSE_LOGGED" });
    expect(notifier.sent[0]!.text).toMatch(/^CareOS: 1\.875 mL Infants' Motrin given to Leo by Sarah at .+\. Next allowed after .+\.$/);
    expect(await plan()).toMatchObject({ status: "BLOCKED", violation_type: "DOUBLE_DOSE_LOCKED" });
  });

  it("flags a running-low bottle and offers to restock", async () => {
    boot(createSeed(now, { motrinMl: 3.5 }));
    const r = await give();
    expect(r).toMatchObject({ status: "LOGGED", bottle_remaining_ml: 1.625, low_stock: true, suggested_restock_items: ["Infant's Motrin Concentrated Drops"] });
    expect(r.followup).toContain("running low");
  });

  it("H2: a token only works for exactly what was read back", async () => {
    const r = await readBack();
    const token = r.confirmation_token as string;
    const attempt = (over = {}) => svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: "Sarah (Mom)", confirmation_token: token, ...over }, ctx);
    for (const over of [{ caregiver_id: "Dad" }, { amount: 1.25 }, { given_minutes_ago: 30 }]) {
      expect(await attempt(over), JSON.stringify(over)).toMatchObject({ reason_codes: expect.arrayContaining(["CONFIRMATION_INVALID_OR_EXPIRED"]) });
    }
    // Swapping the product is stopped even earlier: the pipeline re-runs and Leo is under the other label's chart.
    expect((await attempt({ product: "Children's Motrin" })).status).not.toBe("LOGGED");
    expect(await svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: "Sarah (Mom)", confirmation_token: "123.deadbeef" }, ctx)).toMatchObject({ status: "REJECTED_CONFIRMATION" });
    expect(await svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: "Sarah (Mom)", confirmation_token: "garbage" }, ctx)).toMatchObject({ status: "REJECTED_CONFIRMATION" });
    expect(await ledger()).toEqual([]);
    expect(await attempt()).toMatchObject({ status: "LOGGED" }); // the genuine token still works
  });

  it("a token expires after five minutes", async () => {
    const token = (await readBack()).confirmation_token as string;
    now += 5 * MIN + 1;
    expect(await svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: "Sarah (Mom)", confirmation_token: token }, ctx)).toMatchObject({ status: "REJECTED_CONFIRMATION" });
    expect(await ledger()).toEqual([]);
  });

  it("a token signed by one household's key is useless to another", async () => {
    const token = (await readBack()).confirmation_token as string;
    const other = new CareService(new MemoryAdapter(createSeed(now)), { clock: () => now, signingSecret: "other-secret" });
    expect(await other.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: "Sarah (Mom)", confirmation_token: token })).toMatchObject({ status: "REJECTED_CONFIRMATION" });
  });

  it("H3: retrying the same confirmation (a lost reply) replays it: one dose, one bottle decrement", async () => {
    const token = (await readBack()).confirmation_token as string;
    const call = () => svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: "Sarah (Mom)", confirmation_token: token }, ctx);
    const first = await call();
    now += 10 * MIN; // by now the lock the first call created would reject a "new" dose
    const retry = await call();
    expect(first).toMatchObject({ status: "LOGGED", replay: false });
    expect(retry).toMatchObject({ status: "LOGGED", replay: true, event_id: first.event_id });
    expect(await ledger()).toHaveLength(1);
    expect(await bottle()).toBe(13.125);
    expect(notifier.sent.filter((m) => m.kind === "DOSE_LOGGED")).toHaveLength(1);
  });

  describe("C2: the Double-Dose Intercept", () => {
    it("Dad is stopped with Sarah's details, nothing is written, and the rejection is a lock (not 'unsafe')", async () => {
      await give("Sarah (Mom)");
      now += 18 * MIN;
      const r = await readBack("Dad");
      expect(r).toMatchObject({ status: "REJECTED_LOCKED", card_type: "DOUBLE_DOSE_INTERCEPT", violation_type: "DOUBLE_DOSE_LOCKED", remaining_minutes: 342 });
      expect(r.last_dose).toMatchObject({ caregiver: "Sarah (Mom)", minutes_ago: 18, volume_ml: 1.875 });
      expect(await ledger()).toHaveLength(1);
      expect(await bottle()).toBe(13.125);
    });

    it("race: Sarah and Dad both read back first, then both confirm at once. Exactly one dose is logged", async () => {
      const [a, b] = await Promise.all([readBack("Sarah (Mom)"), readBack("Dad")]);
      expect([a.status, b.status]).toEqual(["NEEDS_CONFIRMATION", "NEEDS_CONFIRMATION"]);
      const confirm = (who: string, t: unknown) => svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: who, confirmation_token: t as string }, ctx);
      const results = await Promise.all([confirm("Sarah (Mom)", a.confirmation_token), confirm("Dad", b.confirmation_token)]);
      expect(results.map((r) => r.status).sort()).toEqual(["LOGGED", "REJECTED_LOCKED"]);
      const loser = results.find((r) => r.status === "REJECTED_LOCKED")!;
      expect(loser).toMatchObject({ card_type: "DOUBLE_DOSE_INTERCEPT", violation_type: "DOUBLE_DOSE_LOCKED" });
      expect(await ledger()).toHaveLength(1);
      expect(await bottle()).toBe(13.125);
    });

    it("a backdated claim cannot slip a second dose past the lock", async () => {
      await give("Sarah (Mom)");
      now += 5 * MIN;
      expect(await readBack("Dad", { given_minutes_ago: 10 })).toMatchObject({ status: "REJECTED_LOCKED" });
    });
  });

  describe("amounts and times", () => {
    it("more than the verified dose is refused; less is logged as given", async () => {
      expect(await readBack("Sarah (Mom)", { amount: 2 })).toMatchObject({ status: "REJECTED_OVERDOSE", reason_codes: ["AMOUNT_EXCEEDS_VERIFIED_DOSE"] });
      expect(await readBack("Sarah (Mom)", { amount: 0 })).toMatchObject({ status: "REJECTED_OVERDOSE" });
      const r = await give("Sarah (Mom)", { amount: 1.25 });
      expect(r).toMatchObject({ status: "LOGGED", dose_display: "1.25 mL" });
      expect((await ledger())[0]).toMatchObject({ volumeMl: 1.25, amountMg: 50 });
    });

    it("a dose given 20 minutes ago is logged at that time (and the lock runs from then)", async () => {
      const r = await give("Sarah (Mom)", { given_minutes_ago: 20 });
      expect(r.status).toBe("LOGGED");
      expect((await ledger())[0]!.at).toBe(now - 20 * MIN);
      expect(r.next_eligible_time).toBe(new Date(now - 20 * MIN + 6 * 3_600_000).toISOString());
    });

    it("cannot be backdated more than 12 hours, or into the future", async () => {
      expect(await readBack("Sarah (Mom)", { given_minutes_ago: 13 * 60 })).toMatchObject({ status: "REJECTED_TIME" });
      expect(await readBack("Sarah (Mom)", { given_minutes_ago: -5 })).toMatchObject({ status: "REJECTED_TIME" });
    });

    it("the read-back says how long ago", async () => {
      expect((await readBack("Sarah (Mom)", { given_minutes_ago: 20 })).speech).toContain("given by Sarah 20 minutes ago");
    });
  });

  describe("H4: who is giving the dose", () => {
    it("an unknown or missing caregiver is a question, not a guess", async () => {
      const r = await svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: "Mallory" });
      expect(r).toMatchObject({ status: "NEEDS_INFO", missing: "caregiver", options: ["Sarah", "Dad"] });
      expect(r.speech).toBe("Who's giving this dose?");
      expect(await svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin" })).toMatchObject({ status: "NEEDS_INFO", missing: "caregiver" });
    });

    it("falls back to the signed-in caregiver when none is named, and accepts first names and ids", async () => {
      expect((await svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin" }, { caregiverId: "dad" })).given_by).toBe("Dad");
      expect((await svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: "sarah" })).given_by).toBe("Sarah");
      expect((await svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: "Sarah" })).given_by).toBe("Sarah");
    });
  });

  describe("the same checks run again at confirm time", () => {
    it("an unsafe combination cannot be logged even with a perfectly valid-looking request", async () => {
      const r = await svc.confirmDoseGiven({ patient_id: "frank", product: "Advil", caregiver_id: "Dad" }, ctx);
      expect(r).toMatchObject({ status: "REJECTED_UNSAFE", card_type: "CONTRAINDICATION_SHIELD" });
      expect(await storage.getLedger("frank")).toEqual([]);
    });

    it("an empty bottle refuses the log", async () => {
      boot(createSeed(now, { motrinMl: 1 }));
      expect(await give()).toMatchObject({ status: "REJECTED_STOCK" });
      expect(await ledger()).toEqual([]);
    });

    it("a stale weight blocks logging until it is retaken", async () => {
      const token = (await readBack()).confirmation_token as string;
      now += 15 * DAY;
      expect(await svc.confirmDoseGiven({ patient_id: "leo", product: "Motrin", caregiver_id: "Sarah (Mom)", confirmation_token: token }, ctx)).toMatchObject({ status: "NEEDS_INFO", missing: "weight" });
    });
  });

  it("Frank's acetaminophen is logged in units with its milligrams, and counts toward the shared daily ceiling", async () => {
    const give2 = async () => {
      const r = await svc.confirmDoseGiven({ patient_id: "frank", product: "Tylenol", caregiver_id: "Dad" }, ctx);
      return svc.confirmDoseGiven({ patient_id: "frank", product: "Tylenol", caregiver_id: "Dad", confirmation_token: r.confirmation_token as string }, ctx);
    };
    const first = await give2();
    expect(first).toMatchObject({ status: "LOGGED", dose_display: "2 caplets" });
    expect((await storage.getLedger("frank"))[0]).toMatchObject({ ingredient: "acetaminophen", amountMg: 1000, sku: "tylenol_extra_strength_500" });
    now += 6 * 60 * MIN;
    expect((await give2()).status).toBe("LOGGED");
    now += 6 * 60 * MIN;
    expect((await give2()).status).toBe("LOGGED");
    now += 6 * 60 * MIN;
    expect(await plan({}, "frank", "Tylenol")).toMatchObject({ status: "BLOCKED" }); // 3 doses (6 caplets) in 24 h is the label's limit
  });
});

describe("log_observation", () => {
  const obs = (a: object) => svc.logObservation({ patient_id: "leo", type: "temperature", value: 101.2, ...a } as never, ctx);

  it("logs a temperature, inferring Fahrenheit for a Fahrenheit-looking number", async () => {
    const r = await obs({ value: 103.1 });
    expect(r).toMatchObject({ status: "LOGGED", unit: "F" });
    expect(r.speech).toBe("Logged Leo's temperature: 103.1 degrees Fahrenheit.");
    expect(await storage.getObservations("leo", "temperature")).toHaveLength(1);
  });

  it("accepts Celsius, and asks when the number could be either", async () => {
    expect(await obs({ value: 38.4 })).toMatchObject({ status: "LOGGED", unit: "C" });
    expect(await obs({ value: 20 })).toMatchObject({ status: "NEEDS_INFO", missing: "unit" });
    expect(await obs({ value: 20, unit: "C" })).toMatchObject({ status: "NEEDS_INFO", reason_codes: ["TEMPERATURE_IMPLAUSIBLE"] });
    expect(await obs({ value: 120, unit: "F" })).toMatchObject({ status: "NEEDS_INFO" });
  });

  it("a weight needs a unit, must be plausible, and then updates what dosing uses", async () => {
    expect(await obs({ type: "weight", value: 19 })).toMatchObject({ status: "NEEDS_INFO", missing: "weight_unit" });
    expect(await obs({ type: "weight", value: 19, unit: "kg" })).toMatchObject({ status: "NEEDS_INFO", missing: "weight_confirm" });
    expect(await obs({ type: "weight", value: 20.5, unit: "lb" })).toMatchObject({ status: "LOGGED" });
    expect(await storage.getPatient("leo")).toMatchObject({ weightLbs: 20.5, weightAt: now });
    expect(await plan()).toMatchObject({ status: "APPROVED", weight_lb: 20.5 });
  });

  it("glucose and wet diapers are range-checked", async () => {
    expect(await obs({ patient_id: "frank", type: "glucose", value: 65 })).toMatchObject({ status: "LOGGED", unit: "mg/dL" });
    expect(await obs({ patient_id: "frank", type: "glucose", value: 5 })).toMatchObject({ status: "NEEDS_INFO" });
    expect(await obs({ type: "wet_diapers", value: 0 })).toMatchObject({ status: "LOGGED" });
    expect(await obs({ type: "wet_diapers", value: 2.5 })).toMatchObject({ status: "NEEDS_INFO" });
  });

  it("can be backdated up to 24 hours, not further", async () => {
    await obs({ minutes_ago: 90 });
    expect((await storage.getObservations("leo", "temperature"))[0]!.at).toBe(now - 90 * MIN);
    expect(await obs({ minutes_ago: 25 * 60 })).toMatchObject({ status: "NEEDS_INFO", missing: "time" });
  });

  it("C9: a fever in a baby under 12 weeks is logged AND sent to a clinician", async () => {
    const seed = createSeed(now);
    seed.patients[0]!.dobMs = now - 40 * DAY;
    boot(seed);
    const r = await obs({ value: 100.6, unit: "F" });
    expect(r).toMatchObject({ status: "NEEDS_CLINICIAN" });
    expect(r.reason_codes).toContain("INFANT_FEVER_UNDER_12_WEEKS");
  });

  it("refers to the right person or asks", async () => {
    expect(await svc.logObservation({ patient_id: "baby", type: "temperature", value: 100 }, ctx)).toMatchObject({ status: "NEEDS_INFO", missing: "patient" });
  });
});

describe("get_household_context and the Memory Conflict Guard", () => {
  it("summarises who is in the house, current locks, recent doses and low supplies", async () => {
    boot(createSeed(now, { motrinMl: 3.5 }));
    await give("Sarah (Mom)");
    now += 30 * MIN;
    const r = await svc.getHouseholdContext({}, ctx);
    const leo = (r.patients as any[]).find((p) => p.id === "leo");
    expect(r).toMatchObject({ status: "OK", acting_caregiver: "sarah" });
    expect(leo).toMatchObject({ name: "Leo", age_months: 9, weight_lb: 19, weight_days_ago: 2 });
    expect(leo.active_locks[0]).toMatchObject({ ingredient: "ibuprofen", status: "DOUBLE_DOSE_LOCKED" });
    expect(leo.doses_last_24h[0]).toMatchObject({ medication: "Infants' Motrin", caregiver: "Sarah (Mom)", volume_ml: 1.875 });
    expect((r.low_supplies as any[]).map((s) => s.id)).toContain("infant_motrin_drops");
    expect((r.caregivers as any[]).map((c) => c.name)).toEqual(["Sarah (Mom)", "Dad"]);
  });

  it("E2: Frank's remembered gout plan (naproxen) is NOT repeated: it is re-checked against Eliquis and flagged", async () => {
    const r = await svc.getHouseholdContext({ topic: "gout" }, ctx);
    expect(r).toMatchObject({ status: "MEMORY_CONFLICT", card_type: "MEMORY_CONFLICT", patient_name: "Frank", call_target: "Dr. Rao", read_verbatim: true });
    expect(r.old_advice).toMatchObject({ drug: "naproxen", given_by: "Dr. Rao", given_on: "August" });
    expect(r.conflict).toMatchObject({ rule_id: "SR-NSAID-ANTICOAGULANT", because: "eliquis", severity: "CRITICAL" });
    expect(r.speech).toBe("Dr. Rao's August advice was naproxen, but Frank now takes eliquis, so it's no longer safe. Please call Dr. Rao before giving it.");
    expect(r.speech).not.toMatch(/take naproxen with food/i);
    expect(r.sources).toEqual(expect.arrayContaining(["ELIQUIS-PI:5.2-Bleeding"]));
    expect(r.reason_codes).toEqual(["MEMORY_CONFLICT", "SR-NSAID-ANTICOAGULANT"]);
  });

  it("the guard re-runs on every recall: the same advice is fine once the chart no longer conflicts", async () => {
    const seed = createSeed(now);
    seed.patients.find((p) => p.id === "frank")!.activeRx = [];
    seed.patients.find((p) => p.id === "frank")!.conditions = [];
    boot(seed);
    const r = await svc.getHouseholdContext({ topic: "gout" }, ctx);
    expect(r).toMatchObject({ status: "MEMORY_STILL_VALID", card_type: null });
    expect(r.speech).toContain("It still passes today's checks");
    expect(r.speech).toContain("ask me to plan the dose before giving it"); // even valid advice never skips the dose pipeline
  });

  it("without a topic the advice is listed with its conflict flag but no alarm card pops up", async () => {
    const r = await svc.getHouseholdContext({}, ctx);
    expect(r).toMatchObject({ status: "OK", card_type: null });
    expect((r.remembered_advice as any[])[0]).toMatchObject({ drug: "naproxen", still_safe: false, conflict: { rule_id: "SR-NSAID-ANTICOAGULANT" } });
  });

  it("an unmatched topic says there is nothing saved, rather than inventing advice", async () => {
    expect(await svc.getHouseholdContext({ topic: "earache" }, ctx)).toMatchObject({ status: "NO_MATCHING_ADVICE" });
  });

  it("can be limited to one person", async () => {
    const r = await svc.getHouseholdContext({ patient_id: "leo" }, ctx);
    expect((r.patients as any[]).map((p) => p.id)).toEqual(["leo"]);
    expect(r.remembered_advice).toEqual([]);
  });
});

describe("audit trail (PRD §9.1)", () => {
  it("every safety decision is recorded with its verdict and reason codes, newest first", async () => {
    await plan();
    await give("Sarah (Mom)");
    now += MIN;
    await plan({}, "frank", "Advil");
    const log = await storage.getAudit(20);
    expect(log.map((e) => e.tool)).toEqual(["plan_medication", "confirm_dose_given", "confirm_dose_given", "plan_medication"]);
    expect(log[0]).toMatchObject({ patientId: "frank", verdict: "ALTERNATE_SUGGESTED", reasonCodes: expect.arrayContaining(["SR-NSAID-ANTICOAGULANT"]) });
    expect(log[3]).toMatchObject({ patientId: "leo", verdict: "APPROVED", reasonCodes: expect.arrayContaining(["LABEL_BAND_18_23LB"]) });
    expect(log.map((e) => e.verdict)).toEqual(["ALTERNATE_SUGGESTED", "LOGGED", "NEEDS_CONFIRMATION", "APPROVED"]);
    for (const e of log) expect(e.inputHash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("stores a hash of the inputs, not the free text a caregiver spoke", async () => {
    await plan({}, "leo", "Motrin, my secret note");
    expect(JSON.stringify(await storage.getAudit())).not.toContain("secret note");
  });

  it("a failing audit store never turns a safe answer into an error", async () => {
    storage.appendAudit = async () => { throw new Error("audit db down"); };
    expect(await plan()).toMatchObject({ status: "APPROVED" });
  });
});

describe("low stock and pantry (unchanged P2 behaviour)", () => {
  it("never offers honey to the infant", async () => {
    const r = await svc.queryPantryRemedies({ patient_id: "leo", symptom: "sore_throat" });
    expect(JSON.stringify(r)).not.toContain("1 tsp honey");
    expect((r as any).excluded_items.some((e: any) => e.item === "honey")).toBe(true);
  });

  it("returns the glycemic-capped ginger-lemon remedy for Frank", async () => {
    const r = await svc.queryPantryRemedies({ patient_id: "frank", symptom: "sore_throat" });
    expect(r).toMatchObject({ status: "MATCH_FOUND", card_type: "PANTRY_REMEDY" });
    expect(JSON.stringify(r)).toContain("1/2 tsp honey");
  });

  it("stages the PRD's cart for $41.29 then confirms once", async () => {
    const staged = await svc.stageAmazonCart({ requested_items: [{ item_name: "Infant Motrin Drops", channel: "prime" }, { item_name: "Diabetic Glucose Test Strips", channel: "pharmacy" }, { item_name: "ginger and lemons", channel: "fresh" }] });
    expect(staged).toMatchObject({ status: "STAGED", total_usd: 41.29, card_type: "AMAZON_RESTOCK_CAROUSEL" });
    const id = staged.cart_id as string;
    const a = await svc.confirmAmazonOrder({ cart_id: id });
    const b = await svc.confirmAmazonOrder({ cart_id: id });
    expect(a.status).toBe("ORDER_PLACED");
    expect(b).toMatchObject({ already_ordered: true, order_id: a.order_id });
  });
});

describe("diagnosis questions answer from the recorded conditions", () => {
  it("says yes and names the recorded condition for Frank's diabetes", async () => {
    const r = await svc.getHouseholdContext({ patient_id: "frank", condition: "diabetes" }, ctx);
    expect(r.status).toBe("OK");
    expect(r.condition_check).toEqual({ condition: "diabetes", on_record: true, recorded_as: "type 2 diabetes" });
    expect(r.speech).toBe("Yes. Frank has type 2 diabetes on record.");
    expect(r.read_verbatim).toBe(true);
  });

  it("says no when the condition is not on Leo's record", async () => {
    const r = await svc.getHouseholdContext({ patient_id: "leo", condition: "diabetes" }, ctx);
    expect(r.condition_check).toMatchObject({ on_record: false, recorded_as: null });
    expect(r.speech).toBe("No. There is no diabetes on Leo's record.");
  });

  it("asks who it is for when no patient is named and there is more than one person", async () => {
    const r = await svc.getHouseholdContext({ condition: "diabetes" }, ctx);
    expect(r.status).not.toBe("OK");
    expect(r.speech ?? r.question ?? JSON.stringify(r)).toMatch(/Who is this for/);
  });
});

describe("diagnosis wording", () => {
  it("matches a misspelling and an alias, and respects an explicit type", async () => {
    expect((await svc.getHouseholdContext({ patient_id: "frank", condition: "diabates" }, ctx)).speech).toBe("Yes. Frank has type 2 diabetes on record.");
    expect((await svc.getHouseholdContext({ patient_id: "frank", condition: "high blood pressure" }, ctx)).speech).toBe("Yes. Frank has hypertension on record.");
    expect((await svc.getHouseholdContext({ patient_id: "frank", condition: "type 1 diabetes" }, ctx)).speech).toBe("No. There is no type 1 diabetes on Frank's record.");
  });
});
