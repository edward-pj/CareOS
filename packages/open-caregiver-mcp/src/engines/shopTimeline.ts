// Simulated fulfilment. The stage is a pure function of when the order was placed, so every storage backend and every
// server replica agrees without timers or extra writes. The real promise ("Tomorrow by 8:00 AM") is shown as the ETA;
// this clock is compressed so a demo can watch an order arrive.

export const ORDER_STAGES = ["PLACED", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"] as const;
export type OrderStage = (typeof ORDER_STAGES)[number];

/** Milliseconds after the order is placed at which each later stage begins. */
export interface ShopTimeline {
  packedMs: number;
  shippedMs: number;
  outForDeliveryMs: number;
  deliveredMs: number;
}

export const DEMO_TIMELINE: ShopTimeline = { packedMs: 8_000, shippedMs: 20_000, outForDeliveryMs: 38_000, deliveredMs: 60_000 };

export const STAGE_LABEL: Record<OrderStage, string> = {
  PLACED: "Order placed",
  PACKED: "Packed",
  SHIPPED: "Shipped",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
};

export function stageSchedule(orderedAt: number, t: ShopTimeline): { stage: OrderStage; at: number }[] {
  return [
    { stage: "PLACED", at: orderedAt },
    { stage: "PACKED", at: orderedAt + t.packedMs },
    { stage: "SHIPPED", at: orderedAt + t.shippedMs },
    { stage: "OUT_FOR_DELIVERY", at: orderedAt + t.outForDeliveryMs },
    { stage: "DELIVERED", at: orderedAt + t.deliveredMs },
  ];
}

export function stageAt(orderedAt: number, now: number, t: ShopTimeline): OrderStage {
  let current: OrderStage = "PLACED";
  for (const s of stageSchedule(orderedAt, t)) if (now >= s.at) current = s.stage;
  return current;
}

/** An order can be cancelled until it ships. */
export function canCancel(stage: OrderStage): boolean {
  return stage === "PLACED" || stage === "PACKED";
}
