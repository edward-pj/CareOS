export interface FoodRule {
  food: string;
  /** Drug class, "condition:<x>", or "age_under_months:<n>". */
  against: string;
  action: "exclude" | "cap";
  reason: string;
  capGrams?: number;
}

export const FOOD_RULES: FoodRule[] = [
  { food: "grapefruit", against: "statin", action: "exclude", reason: "Grapefruit raises statin blood levels and toxicity risk." },
  { food: "banana", against: "ace_inhibitor", action: "exclude", reason: "High potassium combined with ACE inhibitors can cause hyperkalemia." },
  { food: "orange_juice", against: "ace_inhibitor", action: "exclude", reason: "High potassium combined with ACE inhibitors can cause hyperkalemia." },
  { food: "honey", against: "condition:type2_diabetes", action: "cap", capGrams: 3.5, reason: "Sugar is capped under 5 g for Type-2 Diabetes." },
  { food: "honey", against: "age_under_months:12", action: "exclude", reason: "Honey is unsafe under 12 months (infant botulism)." },
];
