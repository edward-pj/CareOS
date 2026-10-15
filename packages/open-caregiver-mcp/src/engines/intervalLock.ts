export interface LedgerEntry {
  ingredient: string;
  caregiver: string;
  /** Epoch ms. */
  at: number;
  volumeMl?: number;
}

export interface IntervalRule {
  minIntervalHours: number;
  maxDosesPer24h: number;
}

export type IntervalResult =
  | { status: "CLEAR"; nextEligibleAt: number }
  | {
      status: "DOUBLE_DOSE_LOCKED";
      nextEligibleAt: number;
      remainingMs: number;
      last: LedgerEntry;
      minutesAgo: number;
    }
  | { status: "DAILY_MAX_REACHED"; nextEligibleAt: number; remainingMs: number; dosesLast24h: number };

const H = 3_600_000;

/** Pure: `now` is always passed in. Lock is keyed by active ingredient, not brand. */
export function checkInterval(
  ledger: LedgerEntry[],
  ingredient: string,
  rule: IntervalRule,
  now: number,
): IntervalResult {
  const doses = ledger.filter((e) => e.ingredient === ingredient).sort((a, b) => a.at - b.at);
  const last = doses[doses.length - 1];

  const window = doses.filter((e) => e.at > now - 24 * H);
  if (window.length >= rule.maxDosesPer24h) {
    // Next slot opens when the oldest dose in the window ages out.
    const oldestCounting = window[window.length - rule.maxDosesPer24h]!;
    const nextEligibleAt = oldestCounting.at + 24 * H;
    return { status: "DAILY_MAX_REACHED", nextEligibleAt, remainingMs: nextEligibleAt - now, dosesLast24h: window.length };
  }

  if (last) {
    const nextEligibleAt = last.at + rule.minIntervalHours * H;
    if (now < nextEligibleAt) {
      return {
        status: "DOUBLE_DOSE_LOCKED",
        nextEligibleAt,
        remainingMs: nextEligibleAt - now,
        last,
        minutesAgo: Math.floor((now - last.at) / 60_000),
      };
    }
  }
  return { status: "CLEAR", nextEligibleAt: now + rule.minIntervalHours * H };
}
