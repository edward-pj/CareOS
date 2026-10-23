// Spoken forms. Dose speech says numbers twice (digits, then words) and always with units (PRD §4.4),
// so a mis-heard or mis-paraphrased number is caught by the second form.

const SMALL = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function integerWords(n: number): string {
  if (n < 20) return SMALL[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? `-${SMALL[n % 10]}` : "");
  if (n < 1000) return `${SMALL[Math.floor(n / 100)]} hundred${n % 100 ? ` ${integerWords(n % 100)}` : ""}`;
  return `${integerWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${integerWords(n % 1000)}` : ""}`;
}

/** Trims float noise: 1.8750000000000002 -> "1.875". */
export function fmtNumber(n: number, maxDecimals = 3): string {
  return String(Number(n.toFixed(maxDecimals)));
}

/** 1.875 -> "one point eight seven five"; 5 -> "five". */
export function numberWords(n: number): string {
  const [whole, frac] = fmtNumber(n).split(".");
  const head = integerWords(Number(whole));
  return frac ? `${head} point ${[...frac].map((c) => SMALL[Number(c)]).join(" ")}` : head;
}

/** "1.875 milliliters. That is one point eight seven five milliliters." */
export function twiceWithUnit(n: number, unitPlural: string, unitSingular = unitPlural): string {
  const unit = n === 1 ? unitSingular : unitPlural;
  return `${fmtNumber(n)} ${unit}. That is ${numberWords(n)} ${unit}`;
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${fmtNumber(n)} ${n === 1 ? singular : pluralForm}`;
}

/** 328 -> "5 hours and 28 minutes"; 45 -> "45 minutes". */
export function spokenDuration(totalMinutes: number): string {
  const m = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return plural(r, "minute");
  return r === 0 ? plural(h, "hour") : `${plural(h, "hour")} and ${plural(r, "minute")}`;
}

/** Strips the trailing "(caregiver role)" from names like "Sarah (Mom)" for natural speech. */
export function firstName(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, "").trim() || name;
}

export function clock(ms: number, timeZone?: string): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
}
