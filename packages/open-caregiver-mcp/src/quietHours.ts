import type { Notifier } from "./storage/types.js";

// Quiet hours (PRD H10): alerts to the other caregivers wait until morning, EXCEPT the ones that exist to stop harm. A repeat-dose
// attempt, a critical block and an emergency always go out immediately. Everything else is held and delivered as one short
// digest with the next message after quiet hours end, so nothing is lost and nobody is woken for "the order shipped".

export interface QuietHours {
  /** "HH:MM", 24 hour, in `timeZone`. */
  start: string;
  end: string;
  /** IANA zone, e.g. "America/Los_Angeles". Defaults to the server's zone. */
  timeZone?: string;
}

type Kind = Parameters<Notifier["send"]>[0];

/** Never held back. */
export const QUIET_EXEMPT: readonly Kind[] = ["LOCKOUT_ATTEMPT", "CRITICAL_BLOCK", "EMERGENCY"];

const minutes = (hhmm: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Quiet hours time must look like "22:00", got "${hhmm}"`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/** Parses "22:00-07:00" (QUIET_HOURS). Returns undefined for an empty value. */
export function parseQuietHours(spec: string | undefined, timeZone?: string): QuietHours | undefined {
  if (!spec?.trim()) return undefined;
  const [start, end, ...extra] = spec.split("-").map((s) => s.trim());
  if (!start || !end || extra.length) throw new Error(`QUIET_HOURS must look like "22:00-07:00", got "${spec}"`);
  minutes(start); minutes(end);
  return { start, end, timeZone };
}

function localMinutes(ms: number, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).formatToParts(new Date(ms));
  return Number(parts.find((p) => p.type === "hour")!.value) * 60 + Number(parts.find((p) => p.type === "minute")!.value);
}

/** True when `ms` falls inside the window. Handles windows that cross midnight; start == end means "never quiet". */
export function isQuiet(ms: number, q: QuietHours | undefined): boolean {
  if (!q) return false;
  const s = minutes(q.start);
  const e = minutes(q.end);
  if (s === e) return false;
  const t = localMinutes(ms, q.timeZone);
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/** Wraps a notifier. Exempt kinds pass straight through; the rest are held during quiet hours and sent as one digest after. */
export class QuietHoursNotifier implements Notifier {
  /** What is waiting for morning. Exposed for tests and the Data Inspector. */
  readonly held: { kind: Kind; text: string; at: number }[] = [];

  constructor(private inner: Notifier, private quiet: QuietHours | undefined, private clock: () => number = Date.now) {}

  async send(kind: Kind, text: string): Promise<string | undefined> {
    const now = this.clock();
    if (!QUIET_EXEMPT.includes(kind) && isQuiet(now, this.quiet)) {
      this.held.push({ kind, text, at: now });
      return undefined;
    }
    if (!QUIET_EXEMPT.includes(kind)) await this.flushIfDue();
    return this.inner.send(kind, text);
  }

  /** Sends what was held, as one digest, once quiet hours have ended. Safe to call on a timer. Returns how many updates it sent. */
  async flushIfDue(): Promise<number> {
    if (this.held.length === 0 || isQuiet(this.clock(), this.quiet)) return 0;
    const batch = this.held.splice(0);
    const digest = batch.length === 1 ? batch[0]!.text : `CareOS: ${batch.length} updates while you were resting. ${batch.map((h) => h.text.replace(/^CareOS:\s*/, "")).join(" ")}`;
    await this.inner.send(batch.every((h) => h.kind === batch[0]!.kind) ? batch[0]!.kind : "DOSE_LOGGED", digest);
    return batch.length;
  }
}
