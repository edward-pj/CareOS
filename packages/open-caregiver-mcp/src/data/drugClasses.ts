// Brand -> ingredient -> pharmacologic classes. Keys are lowercase.

export interface DrugInfo {
  ingredient: string;
  classes: string[];
}

const D = (ingredient: string, ...classes: string[]): DrugInfo => ({ ingredient, classes });

export const DRUGS: Record<string, DrugInfo> = {
  // NSAIDs
  ibuprofen: D("ibuprofen", "nsaid"),
  advil: D("ibuprofen", "nsaid"),
  motrin: D("ibuprofen", "nsaid"),
  "infant motrin": D("ibuprofen", "nsaid"),
  "infant motrin drops": D("ibuprofen", "nsaid"),
  "infant's motrin": D("ibuprofen", "nsaid"),
  naproxen: D("naproxen", "nsaid"),
  aleve: D("naproxen", "nsaid"),
  aspirin: D("aspirin", "nsaid", "antiplatelet"),
  // Acetaminophen
  acetaminophen: D("acetaminophen", "analgesic"),
  tylenol: D("acetaminophen", "analgesic"),
  "infant tylenol": D("acetaminophen", "analgesic"),
  nyquil: D("acetaminophen", "analgesic", "decongestant"),
  // Prescriptions
  eliquis: D("apixaban", "anticoagulant"),
  apixaban: D("apixaban", "anticoagulant"),
  warfarin: D("warfarin", "anticoagulant"),
  coumadin: D("warfarin", "anticoagulant"),
  lisinopril: D("lisinopril", "ace_inhibitor"),
  metformin: D("metformin", "biguanide"),
  atorvastatin: D("atorvastatin", "statin"),
  lipitor: D("atorvastatin", "statin"),
  // OTC decongestants
  pseudoephedrine: D("pseudoephedrine", "decongestant"),
  sudafed: D("pseudoephedrine", "decongestant"),
};

export function lookupDrug(name: string): DrugInfo | undefined {
  const key = name.trim().toLowerCase();
  if (DRUGS[key]) return DRUGS[key];
  // Longest-key substring match so "Infant Motrin Drops 50mg" still resolves.
  const hit = Object.keys(DRUGS)
    .filter((k) => key.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? DRUGS[hit] : undefined;
}
