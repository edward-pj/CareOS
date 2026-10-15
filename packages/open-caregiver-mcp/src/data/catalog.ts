// Mock Amazon catalog (Prime / Pharmacy / Fresh). Prices are demo values.
export interface CatalogEntry {
  keywords: string[];
  name: string;
  channel: "prime" | "pharmacy" | "fresh";
  priceUsd: number;
  merchantLabel: string;
}

export const CATALOG: CatalogEntry[] = [
  { keywords: ["motrin", "ibuprofen"], name: "Infant's Motrin Concentrated Drops (Berry Flavor, 0.5 fl oz)", channel: "prime", priceUsd: 11.48, merchantLabel: "Amazon Prime" },
  { keywords: ["tylenol", "acetaminophen"], name: "Infant Tylenol Suspension (Cherry, 2 fl oz)", channel: "prime", priceUsd: 9.97, merchantLabel: "Amazon Prime" },
  { keywords: ["test strip", "glucose", "onetouch"], name: "OneTouch Verio Diabetic Test Strips (50 ct)", channel: "pharmacy", priceUsd: 24.99, merchantLabel: "Amazon Pharmacy" },
  { keywords: ["ginger", "lemon"], name: "Organic Fresh Ginger & Lemons", channel: "fresh", priceUsd: 4.82, merchantLabel: "Amazon Fresh" },
];

export function findCatalogEntry(itemName: string): CatalogEntry | undefined {
  const q = itemName.toLowerCase();
  return CATALOG.find((c) => c.keywords.some((k) => q.includes(k)));
}
