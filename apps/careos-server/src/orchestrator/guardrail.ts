// Deterministic post-check on LLM output: every dose amount (mg / mL) it states must appear in a tool
// result from the same turn. The model may phrase, never compute.

const AMOUNT = /(\d+(?:\.\d+)?)\s*(?:mg|ml|milligrams?|milliliters?|millilitres?)\b/gi;
const NUMBER = /\d+(?:\.\d+)?/g;

export const SAFE_FALLBACK = "I can't confirm that amount. Please follow the dose shown on the screen.";

/** Every numeric token in the tool results of this turn. */
export function numbersIn(results: unknown[]): number[] {
  const text = results.map((r) => (typeof r === "string" ? r : JSON.stringify(r) ?? "")).join(" ");
  return (text.match(NUMBER) ?? []).map(Number);
}

/** Dose amounts stated in `text` that no tool result backs. */
export function unbackedAmounts(text: string, results: unknown[]): string[] {
  const allowed = numbersIn(results);
  const bad: string[] = [];
  for (const m of text.matchAll(AMOUNT)) {
    const n = Number(m[1]);
    if (!allowed.some((a) => Math.abs(a - n) < 1e-9)) bad.push(m[0]);
  }
  return bad;
}

export function guardReply(text: string, results: unknown[]): { text: string; replaced: boolean; offending: string[] } {
  const offending = unbackedAmounts(text, results);
  return offending.length ? { text: SAFE_FALLBACK, replaced: true, offending } : { text, replaced: false, offending };
}
