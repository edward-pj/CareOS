// Numeric Guard (PRD §4.4): a deterministic post-check on whatever the model drafts.
//
// Every number-with-a-unit in the draft (milliliters, milligrams, caplets, minutes, hours, degrees, pounds...) must
// appear in a tool result from THIS turn. Digits and spelled-out numbers ("two milliliters") are both checked.
// If any is unbacked the draft is discarded and the tool's own `speech` is spoken instead, so "the model cannot invent a
// dose" is testable and visible, not a promise.
//
// The check is unit-aware: a number is backed only by the same KIND of unit (volume, mass, time, weight, temperature,
// count). "Give 75 mL" is refused when the tool said 75 mg, which is exactly the mg/mL mix-up that hurts children.
// Known limit: within one kind of unit it does not check WHICH field (6 hours could be lockout_hours or max_doses).

export const SAFE_FALLBACK = "I can't confirm that amount. Please follow what's on the screen, or call your nurse line.";

const UNITS = [
  "mg", "milligrams?", "mcg", "micrograms?", "g", "grams?",
  "ml", "milliliters?", "millilitres?", "l", "liters?", "litres?",
  "tsp", "teaspoons?", "tbsp", "tablespoons?", "oz", "ounces?", "cups?",
  "caplets?", "tablets?", "capsules?", "pills?", "drops?", "doses?", "times",
  "minutes?", "mins?", "hours?", "hrs?", "days?", "weeks?",
  "degrees?", "lbs?", "pounds?", "kg", "kgs", "kilograms?", "kilos?",
  "mg/dl",
].join("|");

/** Digits followed by a unit: "1.875 mL", "6 hours", "103.1 °F", "103 degrees". */
const DIGIT_AMOUNT = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(°\\s*[fc]\\b|(?:${UNITS})\\b)`, "gi");

const SMALL: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const UNIT_WORD = new RegExp(`^(?:${UNITS})$`, "i");

/** "twenty-five" -> 25, "one hundred and five" -> 105, "one point eight seven five" -> 1.875; undefined if not a number. */
export function wordsToNumber(words: string[]): number | undefined {
  const w = words.flatMap((x) => x.split("-")).filter((x) => x !== "and");
  if (w.length === 0) return undefined;
  const point = w.indexOf("point");
  const whole = point === -1 ? w : w.slice(0, point);
  const frac = point === -1 ? [] : w.slice(point + 1);
  let total = 0;
  let current = 0;
  let seen = false;
  for (const token of whole) {
    if (token in SMALL) { current += SMALL[token]!; seen = true; }
    else if (token in TENS) { current += TENS[token]!; seen = true; }
    else if (token === "hundred") { current = (current || 1) * 100; seen = true; }
    else if (token === "thousand") { total += (current || 1) * 1000; current = 0; seen = true; }
    else return undefined;
  }
  if (!seen && point === -1) return undefined;
  let digits = "";
  for (const token of frac) {
    const d = SMALL[token];
    if (d === undefined || d > 9) return undefined;
    digits += String(d);
  }
  if (point !== -1 && digits === "") return undefined;
  return Number(`${total + current}${digits ? `.${digits}` : ""}`);
}

export type UnitKind = "volume" | "mass" | "time" | "weight" | "temperature" | "count";

export interface Amount { raw: string; value: number; kind: UnitKind }

const KIND_PATTERNS: Array<[UnitKind, RegExp]> = [
  ["temperature", /^(?:degrees?|°.*)$/i],
  ["volume", /^(?:ml|milliliters?|millilitres?|l|liters?|litres?|tsp|teaspoons?|tbsp|tablespoons?|oz|ounces?|cups?)$/i],
  ["mass", /^(?:mg|milligrams?|mcg|micrograms?|g|grams?|mg\/dl)$/i],
  ["time", /^(?:minutes?|mins?|hours?|hrs?|days?|weeks?)$/i],
  ["weight", /^(?:lbs?|pounds?|kgs?|kilograms?|kilos?)$/i],
  ["count", /^(?:caplets?|tablets?|capsules?|pills?|drops?|doses?|times)$/i],
];
export function kindOf(unit: string): UnitKind {
  const u = unit.trim();
  return KIND_PATTERNS.find(([, re]) => re.test(u))?.[0] ?? "count";
}

/** Every number-with-unit in `text`, from digits and from number words. */
export function amountsIn(text: string): Amount[] {
  const out: Amount[] = [];
  for (const m of text.matchAll(DIGIT_AMOUNT)) out.push({ raw: m[0].trim(), value: Number(m[1]), kind: kindOf(m[2]!) });

  const tokens = text.toLowerCase().replace(/[,;:!?()"]/g, " ").replace(/\.(?=\s|$)/g, " ").split(/\s+/).filter(Boolean);
  const numberWord = (t: string) => t in SMALL || t in TENS || t === "hundred" || t === "thousand" || t === "point" || t === "and" || (t.includes("-") && t.split("-").every((p) => p in SMALL || p in TENS));
  for (let i = 0; i < tokens.length; i++) {
    if (!UNIT_WORD.test(tokens[i]!)) continue;
    let j = i;
    while (j > 0 && numberWord(tokens[j - 1]!)) j--;
    while (j < i && (tokens[j] === "and" || tokens[j] === "point")) j++; // a number cannot start with "and" / "point"
    if (j === i) continue;
    const value = wordsToNumber(tokens.slice(j, i));
    if (value !== undefined) out.push({ raw: tokens.slice(j, i + 1).join(" "), value, kind: kindOf(tokens[i]!) });
  }
  return out;
}

/** Which kind of unit a numeric field in a tool result holds, judged by its name; unknown names back nothing. */
function kindOfKey(key: string): UnitKind | undefined {
  const k = key.toLowerCase();
  if (/per_kg|mg_per/.test(k)) return "mass";
  if (/(^|_)(ml|volume)(_|$)/.test(k)) return "volume";
  if (/(^|_)mg(_|$)/.test(k)) return "mass";
  if (/(minutes|hours|days|weeks|_mins?$|_hrs?$)/.test(k)) return "time";
  if (/(^|_)(lbs?|kg|weight)(_|$)/.test(k)) return "weight";
  if (/(^|_)(units|doses|caplets|tablets|times)(_|$)|doses_last/.test(k)) return "count";
  if (/temp/.test(k)) return "temperature";
  return undefined;
}

export type Allowed = Record<UnitKind, number[]>;

/**
 * Everything this turn's tool results back, by kind of unit: amounts written with units inside any text (speech,
 * labels, notes) plus numeric fields whose NAME says what they measure (dispense_volume_ml, remaining_minutes...).
 */
export function allowedAmounts(results: unknown[]): Allowed {
  const allowed: Allowed = { volume: [], mass: [], time: [], weight: [], temperature: [], count: [] };
  const walk = (v: unknown, key?: string) => {
    if (typeof v === "string") {
      for (const a of amountsIn(v)) allowed[a.kind].push(a.value);
    } else if (typeof v === "number") {
      const kind = key ? kindOfKey(key) : undefined;
      if (kind) allowed[kind].push(v);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, key);
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  for (const r of results) walk(r);
  // 342 minutes may be said as "5 hours and 42 minutes", and 6 hours as 360 minutes: allow exact conversions of whole values.
  for (const m of [...allowed.time]) if (Number.isInteger(m / 60)) allowed.time.push(m / 60);
  for (const h of [...allowed.time]) allowed.time.push(h * 60);
  return allowed;
}

/** Amounts stated in `text` that no tool result backs with the same kind of unit. */
export function unbackedAmounts(text: string, results: unknown[]): string[] {
  const allowed = allowedAmounts(results);
  return amountsIn(text)
    .filter((a) => !allowed[a.kind].some((n) => Math.abs(n - a.value) < 1e-9))
    .map((a) => a.raw);
}

export interface GuardResult {
  text: string;
  replaced: boolean;
  offending: string[];
  /** The discarded draft, kept for the inspector's Numeric Guard log. */
  draft?: string;
}

/** The latest tool result that carries speech meant to be read verbatim. */
export function latestSpeech(results: unknown[]): string | undefined {
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i];
    if (r && typeof r === "object" && (r as { read_verbatim?: unknown }).read_verbatim === true && typeof (r as { speech?: unknown }).speech === "string") {
      return (r as { speech: string }).speech;
    }
  }
  return undefined;
}

export function guardReply(text: string, results: unknown[]): GuardResult {
  const offending = unbackedAmounts(text, results);
  if (offending.length === 0) return { text, replaced: false, offending };
  return { text: latestSpeech(results) ?? SAFE_FALLBACK, replaced: true, offending, draft: text };
}
