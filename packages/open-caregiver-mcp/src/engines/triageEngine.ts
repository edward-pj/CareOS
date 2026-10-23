import { checklistFor, RED_FLAG_RULES, URGENCY_RANK, type RedFlagRule, type Sign, type Urgency } from "../data/redFlagRules.js";

export interface TriageInput {
  ageDays: number;
  signs: readonly Sign[];
  /** Degrees Fahrenheit. */
  tempF?: number;
  /** How many days the fever has lasted (1.5 = a day and a half). */
  feverDays?: number;
  onAnticoagulant: boolean;
}

export interface TriageResult {
  urgency: Urgency;
  /** Every rule that fired, most urgent first. */
  matched: RedFlagRule[];
  /** True if any firing rule forbids offering or repeating a home dose. */
  noHomeDosing: boolean;
  /** Signs still worth asking about for this person, most relevant first. */
  checklist: Sign[];
}

const inAge = (r: RedFlagRule, ageDays: number) => ageDays >= (r.minAgeDays ?? 0) && ageDays < (r.maxAgeDays ?? Infinity);

/** True when ONE of the rule's conditions is met (signs, temperature, fever duration). */
function fires(r: RedFlagRule, i: TriageInput): boolean {
  if (!inAge(r, i.ageDays)) return false;
  if (r.requiresAnticoagulant && !i.onAnticoagulant) return false;
  if (r.anySigns?.some((s) => i.signs.includes(s))) return true;
  if (r.tempFAtLeast !== undefined && i.tempF !== undefined && i.tempF >= r.tempFAtLeast) return true;
  if (r.feverDaysOver !== undefined && i.feverDays !== undefined && i.feverDays > r.feverDaysOver) return true;
  return false;
}

/** Sign- and age-based escalation (PRD §7.1). Pure: the same inputs always give the same answer, and the rules are data. */
export function triage(i: TriageInput): TriageResult {
  const matched = RED_FLAG_RULES.filter((r) => fires(r, i)).sort((a, b) => URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency]);
  const urgency: Urgency = matched[0]?.urgency ?? "HOME_CARE_OK_WITH_WATCH";
  const asked = new Set(i.signs);
  return {
    urgency,
    matched,
    noHomeDosing: matched.some((r) => r.noHomeDosing),
    checklist: checklistFor(i.ageDays, i.onAnticoagulant).filter((s) => !asked.has(s)),
  };
}
