// Mock Amazon catalog (Prime / Pharmacy / Fresh). Prices are demo values.
export interface CatalogEntry {
  keywords: string[];
  name: string;
  channel: "prime" | "pharmacy" | "fresh";
  priceUsd: number;
  merchantLabel: string;
  /** What arrives in the house: the inventory item it refills and how much. Demo values. */
  restocks?: { inventoryId: string; amount: number };
}

export const CATALOG: CatalogEntry[] = [
  { keywords: ["motrin", "ibuprofen"], name: "Infant's Motrin Concentrated Drops (Berry Flavor, 0.5 fl oz)", channel: "prime", priceUsd: 11.48, merchantLabel: "Amazon Prime", restocks: { inventoryId: "infant_motrin_drops", amount: 15 } },
  { keywords: ["tylenol", "acetaminophen"], name: "Infant Tylenol Suspension (Cherry, 2 fl oz)", channel: "prime", priceUsd: 9.97, merchantLabel: "Amazon Prime", restocks: { inventoryId: "infant_tylenol", amount: 60 } },
  { keywords: ["test strip", "glucose", "onetouch"], name: "OneTouch Verio Diabetic Test Strips (50 ct)", channel: "pharmacy", priceUsd: 24.99, merchantLabel: "Amazon Pharmacy", restocks: { inventoryId: "test_strips", amount: 50 } },
  { keywords: ["ginger", "lemon"], name: "Organic Fresh Ginger & Lemons", channel: "fresh", priceUsd: 4.82, merchantLabel: "Amazon Fresh", restocks: { inventoryId: "ginger", amount: 1 } },
  { keywords: ["chamomile"], name: "Chamomile Tea (20 ct)", channel: "fresh", priceUsd: 3.99, merchantLabel: "Amazon Fresh", restocks: { inventoryId: "chamomile_tea", amount: 20 } },
];

export function findCatalogEntry(itemName: string): CatalogEntry | undefined {
  const q = itemName.toLowerCase();
  return CATALOG.find((c) => c.keywords.some((k) => q.includes(k)));
}
