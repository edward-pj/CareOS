// Brand -> active ingredients -> pharmacologic classes. Keys are lowercase.
//
// Principle S4: track ACTIVE INGREDIENTS, not brands. Motrin, Advil and "children's ibuprofen" are all ibuprofen,
// and a combination cold medicine expands to every ingredient it contains (so hidden acetaminophen is never missed).

export interface DrugInfo {
  /** Primary active ingredient (first in `ingredients`). */
  ingredient: string;
  /** Every active ingredient. */
  ingredients: string[];
  /** Union of the classes of all ingredients, plus product-level classes such as "cough_cold". */
  classes: string[];
}

/** Pharmacologic classes per active ingredient. */
export const INGREDIENT_CLASSES: Record<string, string[]> = {
  ibuprofen: ["nsaid"],
  naproxen: ["nsaid"],
  aspirin: ["nsaid", "antiplatelet"],
  acetaminophen: ["analgesic"],
  apixaban: ["anticoagulant"],
  warfarin: ["anticoagulant"],
  clopidogrel: ["antiplatelet"],
  lisinopril: ["ace_inhibitor"],
  losartan: ["arb"],
  furosemide: ["diuretic"],
  hydrochlorothiazide: ["diuretic"],
  prednisone: ["corticosteroid"],
  metformin: ["biguanide"],
  atorvastatin: ["statin"],
  pseudoephedrine: ["decongestant"],
  phenylephrine: ["decongestant"],
  dextromethorphan: ["cough_suppressant"],
  doxylamine: ["sedating_antihistamine"],
  diphenhydramine: ["sedating_antihistamine"],
  potassium_chloride: ["potassium_supplement"],
};

const D = (ingredients: string[], productClasses: string[] = []): DrugInfo => ({
  ingredient: ingredients[0]!,
  ingredients,
  classes: [...new Set([...ingredients.flatMap((i) => INGREDIENT_CLASSES[i] ?? []), ...productClasses])],
});

const COLD = ["cough_cold"];
// "NyQuil" is sold in several formulations; an unspecified NyQuil is treated as the union of the ones we know, so a
// phenylephrine decongestant is assumed present (the conservative reading).
const NYQUIL = ["acetaminophen", "dextromethorphan", "doxylamine", "phenylephrine"];

export const DRUGS: Record<string, DrugInfo> = {
  // Ibuprofen
  ibuprofen: D(["ibuprofen"]),
  advil: D(["ibuprofen"]),
  motrin: D(["ibuprofen"]),
  "infant motrin": D(["ibuprofen"]),
  "infants motrin": D(["ibuprofen"]),
  "infant motrin drops": D(["ibuprofen"]),
  "infant's motrin": D(["ibuprofen"]),
  "infants' motrin": D(["ibuprofen"]),
  "children's motrin": D(["ibuprofen"]),
  "childrens motrin": D(["ibuprofen"]),
  // Other NSAIDs / antiplatelets
  naproxen: D(["naproxen"]),
  aleve: D(["naproxen"]),
  aspirin: D(["aspirin"]),
  bayer: D(["aspirin"]),
  clopidogrel: D(["clopidogrel"]),
  plavix: D(["clopidogrel"]),
  // Acetaminophen
  acetaminophen: D(["acetaminophen"]),
  tylenol: D(["acetaminophen"]),
  "infant tylenol": D(["acetaminophen"]),
  "infants tylenol": D(["acetaminophen"]),
  "infants' tylenol": D(["acetaminophen"]),
  // Combination cold & flu products
  nyquil: D(NYQUIL, COLD),
  "vicks nyquil": D(NYQUIL, COLD),
  "nyquil severe": D(NYQUIL, COLD),
  // Prescriptions
  eliquis: D(["apixaban"]),
  apixaban: D(["apixaban"]),
  warfarin: D(["warfarin"]),
  coumadin: D(["warfarin"]),
  lisinopril: D(["lisinopril"]),
  losartan: D(["losartan"]),
  furosemide: D(["furosemide"]),
  lasix: D(["furosemide"]),
  hydrochlorothiazide: D(["hydrochlorothiazide"]),
  prednisone: D(["prednisone"]),
  metformin: D(["metformin"]),
  atorvastatin: D(["atorvastatin"]),
  lipitor: D(["atorvastatin"]),
  "potassium chloride": D(["potassium_chloride"]),
  "salt substitute": D(["potassium_chloride"]),
  // OTC decongestants
  pseudoephedrine: D(["pseudoephedrine"]),
  sudafed: D(["pseudoephedrine"]),
  phenylephrine: D(["phenylephrine"]),
};

const KEYS_LONGEST_FIRST = Object.keys(DRUGS).sort((a, b) => b.length - a.length);

export function lookupDrug(name: string): DrugInfo | undefined {
  const key = name.trim().toLowerCase().replace(/’/g, "'");
  if (DRUGS[key]) return DRUGS[key];
  // Longest-key substring match so "Infant Motrin Drops 50mg" still resolves.
  const hit = KEYS_LONGEST_FIRST.find((k) => key.includes(k));
  return hit ? DRUGS[hit] : undefined;
}

/** All active ingredients across a list of medication names (unknown names are skipped). */
export function ingredientsOf(names: string[]): string[] {
  return [...new Set(names.flatMap((n) => lookupDrug(n)?.ingredients ?? []))];
}
