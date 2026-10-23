import { describe, expect, it } from "vitest";
import { checkInterval, findRemedy } from "../src/engines/index.js";

const H = 3_600_000;

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
