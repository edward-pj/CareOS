import type { AdviceMemory, Caregiver, DoseEvent, InventoryItem, Observation, Patient } from "./types.js";

const DAY = 86_400_000;

export interface SeedData {
  patients: Patient[];
  caregivers: Caregiver[];
  inventory: InventoryItem[];
  ledger: DoseEvent[];
  observations: Observation[];
  advice: AdviceMemory[];
}

export function createSeed(now: number, opts: { sarahDosedMinutesAgo?: number; motrinMl?: number } = {}): SeedData {
  const patients: Patient[] = [
    {
      id: "leo",
      name: "Leo",
      kind: "infant",
      dobMs: now - 275 * DAY, // ~9 months
      weightLbs: 19,
      weightAt: now - 2 * DAY, // weighed two days ago: fresh enough to dose from (stale after 14 days)
      activeRx: [],
      conditions: [],
      allergies: [],
    },
    {
      id: "frank",
      name: "Frank",
      kind: "elder",
      dobMs: now - 78 * 365 * DAY,
      activeRx: ["eliquis", "metformin", "lisinopril", "atorvastatin"],
      conditions: ["type2_diabetes", "hypertension"],
      allergies: [],
    },
  ];
  const caregivers: Caregiver[] = [
    { id: "sarah", name: "Sarah (Mom)", phone: "+15550000001" },
    { id: "dad", name: "Dad", phone: "+15550000002" },
  ];
  const inventory: InventoryItem[] = [
    { id: "infant_motrin_drops", name: "Infant's Motrin Concentrated Drops", ingredient: "ibuprofen", sku: "infants_motrin_drops", unit: "mL", remaining: opts.motrinMl ?? 3.5, lowThreshold: 4 },
    { id: "infant_tylenol", name: "Infant Tylenol Suspension", ingredient: "acetaminophen", sku: "infants_tylenol_suspension", unit: "mL", remaining: 60, lowThreshold: 10 },
    { id: "test_strips", name: "OneTouch Verio Test Strips", unit: "count", remaining: 6, lowThreshold: 10 },
    { id: "ginger", name: "Fresh Ginger Root", unit: "pantry", remaining: 1, lowThreshold: 0 },
    { id: "lemon", name: "Lemons", unit: "pantry", remaining: 3, lowThreshold: 0 },
    { id: "honey", name: "Raw Honey", unit: "pantry", remaining: 1, lowThreshold: 0 },
    { id: "chamomile_tea", name: "Chamomile Tea", unit: "pantry", remaining: 10, lowThreshold: 0 },
  ];
  const ledger: DoseEvent[] = [];
  if (opts.sarahDosedMinutesAgo !== undefined) {
    const at = now - opts.sarahDosedMinutesAgo * 60_000;
    ledger.push({ eventId: "seed-1", patientId: "leo", ingredient: "ibuprofen", medication: "Infants' Motrin", sku: "infants_motrin_drops", caregiver: "Sarah (Mom)", at, volumeMl: 1.875, amountMg: 75, idempotencyKey: "seed-1" });
  }
  const observations: Observation[] = [
    { id: "seed-weight-leo", patientId: "leo", type: "weight", value: 19, unit: "lb", at: now - 2 * DAY, source: "Sarah (Mom)" },
  ];
  // Frank's remembered gout plan pre-dates his Eliquis prescription. It is replayed through today's safety rules on every recall.
  const advice: AdviceMemory[] = [
    { id: "advice-frank-gout", patientId: "frank", topic: "gout flare", advice: "Take naproxen with food for the flare.", drug: "naproxen", givenBy: "Dr. Rao", at: now - 67 * DAY },
  ];
  return { patients, caregivers, inventory, ledger, observations, advice };
}
