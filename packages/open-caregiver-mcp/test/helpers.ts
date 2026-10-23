import type { DoseEvent, Patient } from "../src/storage/types.js";

export const DAY = 86_400_000;
export const H = 3_600_000;
export const MIN = 60_000;
export const NOW = Date.UTC(2026, 9, 15, 23, 10);

export const monthsAgo = (months: number, now = NOW) => now - Math.round(months * 30.4375 * DAY);

/** A child with a fresh weight on file. Defaults to Leo: 9 months, 19 lb. */
export function child(over: Partial<Patient> & { ageMonths?: number } = {}, now = NOW): Patient {
  const { ageMonths = 9, ...rest } = over;
  return { id: "leo", name: "Leo", kind: "infant", dobMs: monthsAgo(ageMonths + 0.1, now), weightLbs: 19, weightAt: now - 2 * DAY, activeRx: [], conditions: [], allergies: [], ...rest };
}

/** An adult. Defaults to Frank: Eliquis, metformin, lisinopril, atorvastatin; hypertension and type 2 diabetes. */
export function adult(over: Partial<Patient> = {}, now = NOW): Patient {
  return { id: "frank", name: "Frank", kind: "elder", dobMs: now - 78 * 365 * DAY, activeRx: ["eliquis", "metformin", "lisinopril", "atorvastatin"], conditions: ["type2_diabetes", "hypertension"], allergies: [], ...over };
}

let n = 0;
export function dose(over: Partial<DoseEvent> & { minutesAgo?: number }, now = NOW): DoseEvent {
  const { minutesAgo = 0, ...rest } = over;
  n += 1;
  return { eventId: `e${n}`, patientId: "leo", ingredient: "ibuprofen", medication: "Infants' Motrin", caregiver: "Sarah (Mom)", at: now - minutesAgo * MIN, idempotencyKey: `k${n}`, ...rest };
}
