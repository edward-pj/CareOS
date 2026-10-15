import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { calculateDose, checkInterval, findRemedy, verifyDrugSafety } from "../src/engines/index.js";

const H = 3_600_000;
const NINE_MONTHS = 275;

describe("calculateDose", () => {
  it("golden: 19 lb infant ibuprofen drops -> 2.00 mL / 80 mg", () => {
    const r = calculateDose({ weightValue: 19, weightUnit: "lbs", ageDays: NINE_MONTHS, formulationKey: "ibuprofen.infant_drops" });
    expect(r.status).toBe("APPROVED");
    if (r.status !== "APPROVED") return;
    expect(r.weightKg).toBe(8.62);
    expect(r.targetDoseMg).toBe(86.18);
    expect(r.dispenseVolumeMl).toBe(2);
    expect(r.deliveredDoseMg).toBe(80);
  });

  it("blocks ibuprofen under 6 months", () => {
    const r = calculateDose({ weightValue: 12, weightUnit: "lbs", ageDays: 120, formulationKey: "ibuprofen.infant_drops" });
    expect(r.status).toBe("BLOCKED");
  });

  it("fever under 12 weeks -> SEEK_CARE", () => {
    const r = calculateDose({ weightValue: 10, weightUnit: "lbs", ageDays: 60, formulationKey: "acetaminophen.infant_susp", hasFever: true });
    expect(r.status).toBe("SEEK_CARE");
  });

  it("rejects implausible weights", () => {
    expect(calculateDose({ weightValue: 190, weightUnit: "lbs", ageDays: NINE_MONTHS, formulationKey: "ibuprofen.infant_drops" }).status).toBe("BLOCKED");
    expect(calculateDose({ weightValue: -3, weightUnit: "lbs", ageDays: NINE_MONTHS, formulationKey: "ibuprofen.infant_drops" }).status).toBe("BLOCKED");
  });

  it("property: lands on a 0.25 mark, never exceeds the target dose, monotonic in weight", () => {
    fc.assert(
      fc.property(fc.double({ min: 5, max: 60, noNaN: true }), fc.double({ min: 5, max: 60, noNaN: true }), (a, b) => {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const run = (w: number) => calculateDose({ weightValue: w, weightUnit: "lbs", ageDays: 400, formulationKey: "ibuprofen.infant_drops" });
        const x = run(lo);
        const y = run(hi);
        if (x.status !== "APPROVED" || y.status !== "APPROVED") return true;
        expect((x.dispenseVolumeMl * 4) % 1).toBe(0);
        expect(x.deliveredDoseMg).toBeLessThanOrEqual(x.targetDoseMg + 1e-9);
        return y.dispenseVolumeMl >= x.dispenseVolumeMl;
      }),
    );
  });
});

describe("checkInterval", () => {
  const rule = { minIntervalHours: 6, maxDosesPer24h: 4 };
  const now = 100 * H;

  it("locks 32 minutes after Mom's dose", () => {
    const r = checkInterval([{ ingredient: "ibuprofen", caregiver: "Sarah", at: now - 32 * 60_000 }], "ibuprofen", rule, now);
    expect(r.status).toBe("DOUBLE_DOSE_LOCKED");
    if (r.status === "DOUBLE_DOSE_LOCKED") {
      expect(r.minutesAgo).toBe(32);
      expect(r.last.caregiver).toBe("Sarah");
      expect(Math.floor(r.remainingMs / 60_000)).toBe(6 * 60 - 32);
    }
  });

  it("clears exactly at the interval boundary", () => {
    expect(checkInterval([{ ingredient: "ibuprofen", caregiver: "Sarah", at: now - 6 * H }], "ibuprofen", rule, now).status).toBe("CLEAR");
  });

  it("is keyed by ingredient, ignoring other drugs", () => {
    expect(checkInterval([{ ingredient: "acetaminophen", caregiver: "Sarah", at: now - 60_000 }], "ibuprofen", rule, now).status).toBe("CLEAR");
  });

  it("enforces the 24h cap", () => {
    const ledger = [20, 14, 8, 2].map((h) => ({ ingredient: "ibuprofen", caregiver: "Dad", at: now - h * H }));
    expect(checkInterval(ledger, "ibuprofen", { minIntervalHours: 1, maxDosesPer24h: 4 }, now).status).toBe("DAILY_MAX_REACHED");
  });
});

describe("verifyDrugSafety", () => {
  const frank = { activeRx: ["eliquis", "metformin", "lisinopril", "atorvastatin"], conditions: ["hypertension", "type2_diabetes"], allergies: [] };

  it("blocks Advil for a patient on Eliquis and offers Tylenol", () => {
    const r = verifyDrugSafety("advil", frank);
    expect(r.status).toBe("BLOCKED");
    if (r.status === "BLOCKED") {
      expect(r.severity).toBe("CRITICAL");
      expect(r.conflictingRx).toBe("eliquis");
      expect(r.approvedAlternative).toBe("acetaminophen");
    }
  });

  it("brand names normalize to the same result", () => {
    for (const brand of ["Motrin", "Ibuprofen", "ADVIL"]) expect(verifyDrugSafety(brand, frank).status).toBe("BLOCKED");
  });

  it("clears Tylenol", () => {
    expect(verifyDrugSafety("tylenol", frank).status).toBe("CLEAR");
  });

  it("drops an alternative that is itself unsafe", () => {
    const r = verifyDrugSafety("advil", { ...frank, allergies: ["tylenol"] });
    if (r.status === "BLOCKED") expect(r.approvedAlternative).toBeUndefined();
  });

  it("fails closed on unknown drugs", () => {
    expect(verifyDrugSafety("zzzmystery", frank).status).toBe("BLOCKED");
  });
});

describe("findRemedy", () => {
  const pantry = ["ginger", "lemon", "honey", "chamomile_tea"];

  it("caps honey for a Type-2 diabetic", () => {
    const r = findRemedy("sore_throat", pantry, { ageMonths: 800, activeRx: ["metformin"], conditions: ["type2_diabetes"] });
    expect(r.status).toBe("MATCH_FOUND");
    if (r.status === "MATCH_FOUND") expect(r.steps.join(" ")).toContain("1/2 tsp honey");
  });

  it("never suggests honey for an infant", () => {
    const r = findRemedy("sore_throat", pantry, { ageMonths: 9, activeRx: [], conditions: [] });
    if (r.status === "MATCH_FOUND") expect(r.availableIngredients).not.toContain("honey");
    expect(r.excluded.some((e) => e.item === "honey")).toBe(true);
  });
});
