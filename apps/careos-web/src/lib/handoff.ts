import type { InventoryItem, PatientSnapshot } from "../api/types";
import { formatClock } from "./time";

export interface Handoff {
  headline: string;
  lines: string[];
  /** True when something needs the next caregiver's attention (active lock or low stock). */
  attention: boolean;
}

/**
 * Caregiver handoff summary. Built only from the stored ledger, locks and inventory, so it can never
 * disagree with the deterministic engines; no number here is derived by a model.
 */
export function buildHandoff(snap: PatientSnapshot, inventory: InventoryItem[], outgoing: string): Handoff {
  const { profile, medication_history, active_locks } = snap;
  const lines: string[] = [];

  const last = [...medication_history].sort((a, b) => b.at - a.at)[0];
  lines.push(
    last
      ? `Last dose: ${last.medication}${last.volumeMl !== undefined ? ` ${last.volumeMl} mL` : ""} by ${last.caregiver} at ${formatClock(last.at)}.`
      : "No doses recorded yet.",
  );

  for (const lock of active_locks) {
    const what = lock.status === "DAILY_MAX_REACHED" ? "daily maximum reached" : "dose lock active";
    lines.push(`${lock.ingredient}: ${what}. Next dose not before ${formatClock(Date.parse(lock.next_eligible_time))}.`);
  }

  const low = inventory.filter((i) => i.unit !== "pantry" && i.remaining < i.lowThreshold);
  for (const item of low) lines.push(`Low stock: ${item.name} (${item.remaining} ${item.unit} left).`);

  return {
    headline: `Handoff for ${profile.name} from ${outgoing}`,
    lines,
    attention: active_locks.length > 0 || low.length > 0,
  };
}
