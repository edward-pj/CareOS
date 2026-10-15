import { lookupDrug } from "../data/drugClasses.js";
import { FOOD_RULES } from "../data/foodInteractions.js";

export type Symptom = "sore_throat" | "cough" | "nausea" | "cold";

export interface PantryPatient {
  ageMonths: number;
  activeRx: string[];
  conditions: string[];
}

interface Remedy {
  title: string;
  symptom: Symptom;
  ingredients: string[];
  steps: string[];
}

const REMEDIES: Remedy[] = [
  {
    title: "Warm Ginger-Lemon Throat Infusion",
    symptom: "sore_throat",
    ingredients: ["ginger", "lemon", "honey"],
    steps: [
      "Slice 1 inch of fresh ginger thinly.",
      "Steep in 8 oz boiling water for 5 minutes.",
      "Add 1 tbsp lemon juice and {honey}.",
    ],
  },
  {
    title: "Chamomile Calming Tea",
    symptom: "sore_throat",
    ingredients: ["chamomile_tea", "lemon"],
    steps: ["Steep one chamomile tea bag in 8 oz hot water for 4 minutes.", "Add a squeeze of lemon."],
  },
  {
    title: "Ginger Tea",
    symptom: "nausea",
    ingredients: ["ginger"],
    steps: ["Slice 1 inch of fresh ginger.", "Steep in 8 oz boiling water for 5 minutes."],
  },
];

export type PantryResult =
  | {
      status: "MATCH_FOUND";
      title: string;
      availableIngredients: string[];
      steps: string[];
      safetyBadges: string[];
      excluded: { item: string; reason: string }[];
    }
  | { status: "NO_SAFE_MATCH"; excluded: { item: string; reason: string }[] };

export function findRemedy(symptom: Symptom, pantry: string[], p: PantryPatient): PantryResult {
  const classes = p.activeRx.flatMap((rx) => lookupDrug(rx)?.classes ?? []);
  const excluded: { item: string; reason: string }[] = [];
  const badges: string[] = [];

  const applies = (against: string) =>
    classes.includes(against) ||
    (against.startsWith("condition:") && p.conditions.includes(against.slice(10))) ||
    (against.startsWith("age_under_months:") && p.ageMonths < Number(against.split(":")[1]));

  const banned = new Set<string>();
  const caps = new Map<string, number>();
  for (const r of FOOD_RULES) {
    if (!applies(r.against)) continue;
    if (r.action === "exclude") {
      banned.add(r.food);
      excluded.push({ item: r.food, reason: r.reason });
    } else if (r.capGrams !== undefined) {
      caps.set(r.food, Math.min(caps.get(r.food) ?? Infinity, r.capGrams));
    }
  }

  for (const remedy of REMEDIES.filter((r) => r.symptom === symptom)) {
    // A remedy is rejected whole if it needs a banned ingredient; ingredients we lack are skipped.
    if (remedy.ingredients.some((i) => banned.has(i))) continue;
    const have = remedy.ingredients.filter((i) => pantry.includes(i));
    if (have.length !== remedy.ingredients.length) continue;
    if (caps.has("honey") && have.includes("honey")) badges.push("Glycemic-Safe: honey capped at 1/2 tsp");
    const steps = remedy.steps.map((s) => s.replace("{honey}", caps.has("honey") ? "strictly 1/2 tsp honey (glycemic-capped)" : "1 tsp honey"));
    return { status: "MATCH_FOUND", title: remedy.title, availableIngredients: have, steps, safetyBadges: badges, excluded };
  }
  return { status: "NO_SAFE_MATCH", excluded };
}
