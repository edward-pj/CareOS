import type { Caregiver, DoseEvent, InventoryItem, Patient } from "./types.js";

const DAY = 86_400_000;

export interface SeedData {
  patients: Patient[];
  caregivers: Caregiver[];
  inventory: InventoryItem[];
  ledger: DoseEvent[];
}

export function createSeed(now: number, opts: { sarahDosedMinutesAgo?: number; motrinMl?: number } = {}): SeedData {
  const patients: Patient[] = [
    {
      id: "leo",
      name: "Leo",
      kind: "infant",
      dobMs: now - 275 * DAY, // ~9 months
      weightLbs: 19,
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
    { id: "infant_motrin_drops", name: "Infant's Motrin Concentrated Drops", ingredient: "ibuprofen", unit: "mL", remaining: opts.motrinMl ?? 3.5, lowThreshold: 4 },
    { id: "infant_tylenol", name: "Infant Tylenol Suspension", ingredient: "acetaminophen", unit: "mL", remaining: 60, lowThreshold: 10 },
    { id: "test_strips", name: "OneTouch Verio Test Strips", unit: "count", remaining: 6, lowThreshold: 10 },
    { id: "ginger", name: "Fresh Ginger Root", unit: "pantry", remaining: 1, lowThreshold: 0 },
    { id: "lemon", name: "Lemons", unit: "pantry", remaining: 3, lowThreshold: 0 },
    { id: "honey", name: "Raw Honey", unit: "pantry", remaining: 1, lowThreshold: 0 },
    { id: "chamomile_tea", name: "Chamomile Tea", unit: "pantry", remaining: 10, lowThreshold: 0 },
  ];
  const ledger: DoseEvent[] = [];
  if (opts.sarahDosedMinutesAgo !== undefined) {
    const at = now - opts.sarahDosedMinutesAgo * 60_000;
    ledger.push({ eventId: "seed-1", patientId: "leo", ingredient: "ibuprofen", medication: "Infant Motrin Drops", caregiver: "Sarah (Mom)", at, volumeMl: 2, idempotencyKey: "seed-1" });
  }
  return { patients, caregivers, inventory, ledger };
}
