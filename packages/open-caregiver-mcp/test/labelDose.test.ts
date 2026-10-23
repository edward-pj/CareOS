import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { LABEL_REGISTRY, findSku, type LiquidSku } from "../src/data/labelRegistry.js";
import { findBand, isWeightStale, kgToLb, labelDose, lbToKg, plausibleWeightKg, solidDose, weightIsPlausible } from "../src/engines/labelDoseEngine.js";
import { DAY, NOW } from "./helpers.js";

const motrin = findSku("infants_motrin_drops") as LiquidSku;
const childrens = findSku("childrens_motrin_suspension") as LiquidSku;
const infantTylenol = findSku("infants_tylenol_suspension") as LiquidSku;
const liquids = LABEL_REGISTRY.filter((s): s is LiquidSku => s.kind === "liquid");

describe("label-first dosing (PRD §4.2)", () => {
  it("GOLDEN: Leo, 19 lb, Infants' Motrin drops -> 1.875 mL = 75 mg = 8.7 mg/kg (not the old 2.0 mL)", () => {
    const r = labelDose({ sku: motrin, weightLb: 19, ageMonths: 9 });
    expect(r.status).toBe("APPROVED");
    if (r.status !== "APPROVED") return;
    expect(r.doseMl).toBe(1.875);
    expect(r.doseMg).toBe(75);
    expect(Math.round(r.weightKg * 100) / 100).toBe(8.62);
    expect(Math.round(r.mgPerKg * 10) / 10).toBe(8.7);
    expect(r.codes).toEqual(expect.arrayContaining(["LABEL_BAND_18_23LB", "MG_PER_KG_OK"]));
  });

  it("flags (but allows) the age/weight mismatch: the label says use weight", () => {
    const r = labelDose({ sku: motrin, weightLb: 19, ageMonths: 9 }); // 19 lb is the 12-23 month row; Leo is 9 months
    expect(r).toMatchObject({ status: "APPROVED", ageWeightMismatch: true });
    expect((r as { codes: string[] }).codes).toContain("AGE_WEIGHT_MISMATCH");
    expect(labelDose({ sku: motrin, weightLb: 19, ageMonths: 15 })).toMatchObject({ ageWeightMismatch: false });
  });

  it("each printed row gives its printed dose", () => {
    const expectDose = (sku: LiquidSku, lb: number, ml: number) => expect(labelDose({ sku, weightLb: lb, ageMonths: 30 })).toMatchObject({ status: "APPROVED", doseMl: ml });
    expectDose(motrin, 12, 1.25);
    expectDose(motrin, 17, 1.25);
    expectDose(motrin, 18, 1.875);
    expectDose(motrin, 23, 1.875);
    for (const [lb, ml] of [[24, 5], [35, 5], [36, 7.5], [47, 7.5], [48, 10], [59, 10], [60, 12.5], [71, 12.5], [72, 15], [95, 15]] as const) expectDose(childrens, lb, ml);
    expectDose(infantTylenol, 24, 5);
    expectDose(infantTylenol, 35, 5);
  });

  describe("edge cases", () => {
    it("a weight exactly on a band boundary uses that band, never the one above", () => {
      expect(labelDose({ sku: motrin, weightLb: 17, ageMonths: 9 })).toMatchObject({ doseMl: 1.25 });
      expect(labelDose({ sku: motrin, weightLb: 18, ageMonths: 9 })).toMatchObject({ doseMl: 1.875 });
    });

    it("floating-point noise on a boundary does not move the weight into another band", () => {
      // 8.164663 kg is 18.000000 lb to six places; 17.9999999 must not round UP into 18.
      expect(labelDose({ sku: motrin, weightLb: kgToLb(lbToKg(18)), ageMonths: 9 })).toMatchObject({ doseMl: 1.875 });
      expect(labelDose({ sku: motrin, weightLb: 17.99, ageMonths: 9 })).toMatchObject({ doseMl: 1.25, gap: true });
    });

    it("between two printed rows (17.5 lb) uses the LOWER row and says to ask the pediatrician", () => {
      const r = labelDose({ sku: motrin, weightLb: 17.5, ageMonths: 9 });
      expect(r).toMatchObject({ status: "APPROVED", doseMl: 1.25, gap: true });
      expect((r as { codes: string[] }).codes).toContain("LABEL_GAP_LOWER_BAND_USED");
      expect(labelDose({ sku: childrens, weightLb: 47.5, ageMonths: 60 })).toMatchObject({ doseMl: 7.5, gap: true });
    });

    it("below the chart routes to a clinician", () => {
      expect(labelDose({ sku: motrin, weightLb: 11.9, ageMonths: 9 })).toMatchObject({ status: "NEEDS_CLINICIAN", reason: "BELOW_LABEL_WEIGHT" });
      expect(labelDose({ sku: childrens, weightLb: 23.9, ageMonths: 30 })).toMatchObject({ status: "NEEDS_CLINICIAN", reason: "BELOW_LABEL_WEIGHT" });
      expect(labelDose({ sku: infantTylenol, weightLb: 19, ageMonths: 9 })).toMatchObject({ status: "NEEDS_CLINICIAN", reason: "BELOW_LABEL_WEIGHT" }); // the current label says ask a doctor under 24 lb
    });

    it("above the chart routes to a clinician: no extrapolation", () => {
      expect(labelDose({ sku: motrin, weightLb: 23.5, ageMonths: 20 })).toMatchObject({ status: "NEEDS_CLINICIAN", reason: "ABOVE_LABEL_TABLE" });
      expect(labelDose({ sku: childrens, weightLb: 96, ageMonths: 144 })).toMatchObject({ status: "NEEDS_CLINICIAN", reason: "ABOVE_LABEL_TABLE" });
      expect(labelDose({ sku: infantTylenol, weightLb: 36, ageMonths: 40 })).toMatchObject({ status: "NEEDS_CLINICIAN", reason: "ABOVE_LABEL_TABLE" });
    });

    it("the infant ibuprofen label's standalone age row ('under 6 mos ask a doctor') applies whatever the weight", () => {
      expect(labelDose({ sku: motrin, weightLb: 15, ageMonths: 5 })).toMatchObject({ status: "NEEDS_CLINICIAN", reason: "UNDER_LABEL_MIN_AGE" });
      expect(labelDose({ sku: motrin, weightLb: 15, ageMonths: 6 })).toMatchObject({ status: "APPROVED" });
    });
  });

  describe("S5: mg/kg is an independent cross-check, and it agrees with every printed row", () => {
    it("at the LIGHTEST weight of every row of every liquid label, the label dose is within the per-dose ceiling", () => {
      for (const sku of liquids) {
        for (const band of sku.bands) {
          const kg = lbToKg(band.minLb);
          const mgPerKg = (band.doseMl * sku.mgPerMl) / kg;
          expect(mgPerKg, `${sku.sku} ${band.minLb}-${band.maxLb} lb`).toBeLessThanOrEqual(sku.mgPerKgCeiling);
        }
      }
    });

    it("a doctored registry row that disagrees with mg/kg is refused, not given", () => {
      const bad: LiquidSku = { ...motrin, bands: [{ minLb: 12, maxLb: 17, doseMl: 3, ageLabel: "x", ageMinMonths: 6, ageMaxMonths: 11 }] };
      expect(labelDose({ sku: bad, weightLb: 15, ageMonths: 9 })).toMatchObject({ status: "NEEDS_CLINICIAN", reason: "CROSS_CHECK_FAILED" });
    });

    it("property: any weight on the chart either gives a printed dose within the ceiling or is refused, never anything else", () => {
      fc.assert(
        fc.property(fc.double({ min: 0.5, max: 130, noNaN: true }), fc.constantFrom(...liquids), fc.integer({ min: 6, max: 200 }), (lb, sku, ageMonths) => {
          const r = labelDose({ sku, weightLb: lb, ageMonths });
          if (r.status !== "APPROVED") return true;
          const printed = sku.bands.map((b) => b.doseMl);
          return printed.includes(r.doseMl) && r.mgPerKg <= sku.mgPerKgCeiling + 1e-9;
        }),
      );
    });

    it("property: a heavier child never gets a smaller dose (monotonic)", () => {
      fc.assert(
        fc.property(fc.double({ min: 12, max: 95, noNaN: true }), fc.double({ min: 12, max: 95, noNaN: true }), (a, b) => {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          const x = labelDose({ sku: childrens, weightLb: lo, ageMonths: 60 });
          const y = labelDose({ sku: childrens, weightLb: hi, ageMonths: 60 });
          return x.status !== "APPROVED" || y.status !== "APPROVED" || y.doseMl >= x.doseMl;
        }),
      );
    });
  });

  describe("device-aware rounding", () => {
    it("never rounds a dose to fit a device: if the device's marks are known and the dose is not one, it refuses", () => {
      const withMarks: LiquidSku = { ...motrin, device: { ...motrin.device, marksMl: [0.625, 1.25] } };
      expect(labelDose({ sku: withMarks, weightLb: 19, ageMonths: 9 })).toMatchObject({ status: "NEEDS_CLINICIAN", reason: "DOSE_NOT_ON_DEVICE_MARK" });
      expect(labelDose({ sku: withMarks, weightLb: 15, ageMonths: 9 })).toMatchObject({ status: "APPROVED", doseMl: 1.25 });
    });

    it("does not invent tick marks: the registry only claims what the label verifies", () => {
      for (const s of liquids) expect(s.device.marksMl, s.sku).toBeUndefined();
    });
  });
});

describe("adult solids", () => {
  it("Tylenol Extra Strength: 2 caplets (1000 mg), only for 12 and up", () => {
    const sku = findSku("tylenol_extra_strength_500")!;
    if (sku.kind !== "solid") throw new Error("expected solid");
    expect(solidDose(sku, 78 * 12)).toMatchObject({ status: "APPROVED", units: 2, unitLabel: "caplets", doseMg: 1000 });
    expect(solidDose(sku, 11 * 12 + 11)).toMatchObject({ status: "NEEDS_CLINICIAN", reason: "UNDER_LABEL_MIN_AGE_YEARS" });
  });

  it("the label's own daily limit is consistent: 6 caplets in 24 h is 3 doses of 2", () => {
    const sku = findSku("tylenol_extra_strength_500")!;
    if (sku.kind !== "solid") throw new Error("expected solid");
    expect(sku.maxUnitsPer24h / sku.unitsPerDose).toBe(sku.maxDosesPer24h);
    const nyquil = findSku("nyquil_severe_caplets")!;
    if (nyquil.kind !== "solid") throw new Error("expected solid");
    expect(nyquil.maxUnitsPer24h / nyquil.unitsPerDose).toBe(nyquil.maxDosesPer24h);
  });
});

describe("weight sanity", () => {
  it("a 9-month-old at 19 lb is plausible; 19 KILOGRAMS is not (the classic 2.2x unit mistake)", () => {
    expect(weightIsPlausible(lbToKg(19), 9)).toBe(true);
    expect(weightIsPlausible(19, 9)).toBe(false);
    expect(plausibleWeightKg(9)).toEqual({ min: 4.5, max: 14 });
  });

  it("weights go stale after 14 days for infants and 30 for older children; an undated weight is stale", () => {
    expect(isWeightStale(NOW - 13 * DAY, NOW, 9)).toBe(false);
    expect(isWeightStale(NOW - 15 * DAY, NOW, 9)).toBe(true);
    expect(isWeightStale(NOW - 29 * DAY, NOW, 24)).toBe(false);
    expect(isWeightStale(NOW - 31 * DAY, NOW, 24)).toBe(true);
    expect(isWeightStale(undefined, NOW, 9)).toBe(true);
  });

  it("findBand reports below / above rather than guessing", () => {
    expect(findBand(motrin, 5)).toMatchObject({ where: "below" });
    expect(findBand(motrin, 40)).toMatchObject({ where: "above" });
  });
});

describe("the registry itself", () => {
  it("every row cites a label set id + version and a retrieval date (S9), and no two rows share a sku", () => {
    const seen = new Set<string>();
    for (const s of LABEL_REGISTRY) {
      expect(seen.has(s.sku)).toBe(false);
      seen.add(s.sku);
      expect(s.source.setId).toMatch(/^[0-9a-f-]{36}$/);
      expect(s.source.version).toBeGreaterThan(0);
      expect(s.source.url).toContain(s.source.setId);
      expect(s.source.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(s.source.id).toBe(`FDA-LABEL:${s.source.setId}@v${s.source.version}`);
    }
  });

  it("bands are ordered and do not overlap", () => {
    for (const s of liquids) {
      for (let i = 1; i < s.bands.length; i++) expect(s.bands[i]!.minLb, s.sku).toBeGreaterThan(s.bands[i - 1]!.maxLb);
    }
  });
});
