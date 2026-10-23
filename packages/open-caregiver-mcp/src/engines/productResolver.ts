import { lookupDrug } from "../data/drugClasses.js";
import { INGREDIENT_CLASSES } from "../data/drugClasses.js";
import { LABEL_REGISTRY, norm, parseConcentrationMgPerMl, type LabelSku } from "../data/labelRegistry.js";
import type { ProposedProduct } from "./safetyMatrix.js";

// Layer A: which EXACT product is this, and does the bottle in hand match it? (PRD §4.3)
// Infant drops (50 mg / 1.25 mL) and children's liquid (100 mg / 5 mL) are both "ibuprofen"; mixing them up is the
// classic 2x-4x dosing error, so we never guess between them.

export type PatientKind = "infant" | "elder";

export type Resolved =
  | { kind: "sku"; sku: LabelSku; codes: string[]; note?: string }
  /** A known drug that has no verified label for this patient: safety layers can still run, but no dose can be given. */
  | { kind: "generic"; product: ProposedProduct; ingredient: string }
  | { kind: "ask"; question: string; options: string[]; codes: string[] }
  | { kind: "wrong_population"; sku: LabelSku }
  | { kind: "unknown_concentration"; bottle: string; options: string[] }
  | { kind: "unknown_product" };

const fits = (sku: LabelSku, kind: PatientKind) => (kind === "infant" ? sku.kind === "liquid" : sku.kind === "solid");

export function productOfSku(sku: LabelSku): ProposedProduct {
  const classes = new Set<string>([...sku.ingredients.flatMap((i) => INGREDIENT_CLASSES[i] ?? []), ...(sku.productClasses ?? [])]);
  return { name: sku.spokenName, ingredients: sku.ingredients, classes: [...classes] };
}

/** Longest alias contained in the normalised text (whole-word match), or undefined. */
function aliasHit(text: string, skus: LabelSku[], pick: (s: LabelSku) => string[] | undefined): LabelSku | undefined {
  const padded = ` ${text} `;
  let best: { sku: LabelSku; len: number } | undefined;
  for (const sku of skus) {
    for (const alias of pick(sku) ?? []) {
      if (padded.includes(` ${alias} `) && (!best || alias.length > best.len)) best = { sku, len: alias.length };
    }
  }
  return best?.sku;
}

const describe = (s: LabelSku) => `${s.spokenName} (${s.concentrationLabel})`;

/**
 * @param houseSkus registry skus the household actually has a bottle of. When a name fits several products (e.g. "Motrin")
 *   and exactly one of them is in the cabinet, that bottle is used; a typed bottle strength always takes precedence.
 */
export function resolveProduct(productText: string, kind: PatientKind, bottleConcentration?: string, houseSkus: string[] = []): Resolved {
  const text = norm(productText);
  const bottle = bottleConcentration?.trim() ? parseConcentrationMgPerMl(bottleConcentration) : undefined;
  const bottleGiven = !!bottleConcentration?.trim();

  // 1. An exact product name wins, even if it is the wrong product for this person.
  const specific = aliasHit(text, LABEL_REGISTRY, (s) => [norm(s.sku), ...s.aliases.map(norm)]);
  if (specific && !fits(specific, kind)) return { kind: "wrong_population", sku: specific };

  let chosen: LabelSku | undefined = specific;
  /** How the product was selected, carried through so the caller can show it. */
  const selectedBy: string[] = [];

  // 2. A bare brand name picks its SKU only if that SKU suits this person.
  if (!chosen) {
    chosen = aliasHit(text, LABEL_REGISTRY.filter((s) => fits(s, kind)), (s) => s.looseAliases?.map(norm));
  }

  // 3. Otherwise go by active ingredient.
  if (!chosen) {
    const drug = lookupDrug(productText);
    if (!drug) return { kind: "unknown_product" };
    const candidates = LABEL_REGISTRY.filter((s) => fits(s, kind) && s.ingredients.length === drug.ingredients.length && drug.ingredients.every((i) => s.ingredients.includes(i)));
    if (candidates.length === 0) {
      return { kind: "generic", product: { name: productText.trim(), ingredients: drug.ingredients, classes: drug.classes }, ingredient: drug.ingredient };
    }
    if (candidates.length === 1) {
      chosen = candidates[0]!;
    } else if (bottle !== undefined) {
      const byBottle = candidates.filter((c) => c.kind === "liquid" && Math.abs(c.mgPerMl - bottle) < 0.01);
      if (byBottle.length === 1) return { kind: "sku", sku: byBottle[0]!, codes: ["SKU_SELECTED_BY_BOTTLE_CONCENTRATION"] };
      return { kind: "unknown_concentration", bottle: bottleConcentration!.trim(), options: candidates.map(describe) };
    } else {
      const inHouse = candidates.filter((c) => houseSkus.includes(c.sku));
      if (inHouse.length === 1) {
        // A default only: a strength typed from the bottle is still checked against it below.
        chosen = inHouse[0]!;
        selectedBy.push("SKU_FROM_HOUSEHOLD_BOTTLE");
      } else {
        const options = candidates.map(describe);
        return { kind: "ask", question: `Which bottle is it: ${options.join(" or ")}?`, options, codes: ["PRODUCT_AMBIGUOUS_CONCENTRATION"] };
      }
    }
  }

  // 4. The caller read a concentration off the bottle: it must agree with the product we think this is.
  if (bottleGiven && chosen.kind === "liquid") {
    if (bottle === undefined) {
      return { kind: "ask", question: "I couldn't read the strength on the bottle. Please say it the way it's printed, for example 100 milligrams per 5 milliliters.", options: [], codes: ["BOTTLE_CONCENTRATION_UNREADABLE"] };
    }
    if (Math.abs(chosen.mgPerMl - bottle) >= 0.01) {
      const alternatives = LABEL_REGISTRY.filter((s): s is Extract<LabelSku, { kind: "liquid" }> => s.kind === "liquid" && fits(s, kind) && s.limitIngredient === chosen!.limitIngredient && Math.abs(s.mgPerMl - bottle) < 0.01);
      if (alternatives.length === 1) {
        return { kind: "sku", sku: alternatives[0]!, codes: [...selectedBy, "SKU_SWITCHED_BY_BOTTLE_CONCENTRATION"], note: `Your bottle is ${alternatives[0]!.concentrationLabel}, so I used the ${alternatives[0]!.spokenName} chart instead of ${chosen.spokenName}.` };
      }
      return { kind: "unknown_concentration", bottle: bottleConcentration!.trim(), options: [describe(chosen)] };
    }
    return { kind: "sku", sku: chosen, codes: [...selectedBy, "BOTTLE_CONCENTRATION_MATCHES"] };
  }

  return { kind: "sku", sku: chosen, codes: selectedBy };
}
