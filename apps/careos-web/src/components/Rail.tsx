import type { Observation, PatientSnapshot } from "../api/types";
import { formatClock } from "../lib/time";

const DAY = 86_400_000;

function latest(obs: Observation[], type: Observation["type"]): Observation | undefined {
  return [...obs].filter((o) => o.type === type).sort((a, b) => b.at - a.at)[0];
}
function ago(ms: number, now: number): string {
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** Layout only: a trend line through the last few temperatures. Every number shown as text comes from the readings list. */
function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values) - 1;
  const hi = Math.max(...values) + 1;
  const pts = values.map((v, i) => `${((i * 300) / (values.length - 1)).toFixed(1)},${(52 - ((v - lo) / (hi - lo)) * 48).toFixed(1)}`).join(" ");
  return (
    <svg viewBox="0 0 300 56" width="100%" height="64" role="img" aria-label={`Temperature trend over the last ${values.length} readings`} preserveAspectRatio="none" className="block overflow-visible">
      <polyline points={pts} fill="none" stroke="#7fe7ff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Cell({ label, main, meta, tone, border }: { label: string; main: string; meta?: string; tone?: string; border: string }) {
  return (
    <div className={`px-3 py-3.5 ${border}`}>
      <div className="mb-1 text-[12px] text-muted">{label}</div>
      <div className={`text-[16px] font-medium leading-tight ${tone ?? "text-white"}`}>{main}</div>
      {meta && <div className="mt-0.5 text-[12px] leading-snug text-muted">{meta}</div>}
    </div>
  );
}

/** Right panel: the active episode (temperature, weight, last and next dose) and the Safety Ledger. */
export function Rail({ snap, now }: { snap?: PatientSnapshot; now: number }) {
  const temps = snap ? [...snap.observations].filter((o) => o.type === "temperature").sort((a, b) => b.at - a.at) : [];
  const temp = snap ? latest(snap.observations, "temperature") : undefined;
  const weight = snap ? latest(snap.observations, "weight") : undefined;
  const ledger = (snap?.medication_history ?? []).filter((e) => e.at > now - DAY).sort((a, b) => b.at - a.at);
  const stale = snap && snap.weight_days_ago !== null && snap.profile.kind === "infant" && snap.weight_days_ago > 14;
  const lock = snap?.active_locks[0];
  const lastDose = ledger[0];

  return (
    <aside className="rail flex h-full min-h-0 flex-col gap-4 overflow-y-auto" aria-label="Episode and ledger">
      {snap && (
        <section className="glass flex min-h-0 shrink-0 flex-col gap-3 rounded-[29px] p-5" aria-label="Active episode">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[14px] font-medium text-soft">Active episode · {snap.profile.name}</div>
            <div className={`rounded-full bg-white/10 px-3 py-1 text-[12px] ${lock ? "text-warn" : "text-mint"}`}>{lock ? "Dose locked" : "No dose locks"}</div>
          </div>

          <div>
            {temp ? (
              <>
                <div className="flex items-baseline gap-2">
                  <span className="text-[46px] font-semibold leading-none tracking-tight text-white tabular-nums">{temp.value}°{temp.unit}</span>
                  <span className="text-[14px] text-soft">temperature</span>
                </div>
                <div className="mt-1.5 text-[13px] text-muted">Taken {formatClock(temp.at)} · {ago(temp.at, now)}</div>
              </>
            ) : (
              <div className="text-[16px] text-muted">no temperature yet</div>
            )}
          </div>

          <Spark values={temps.slice(0, 6).reverse().map((o) => o.value)} />

          <div className="grid grid-cols-2 border-t border-white/10">
            <Cell
              label="Weight"
              border="border-b border-white/10 pl-0"
              main={snap.profile.weightLbs !== undefined ? `${snap.profile.weightLbs} lb` : "no weight on file"}
              meta={snap.profile.weightLbs !== undefined ? `${weight ? ago(weight.at, now) : snap.weight_days_ago === null ? "date unknown" : `${snap.weight_days_ago} days ago`}${stale ? ": weigh again" : ""}` : undefined}
              tone={snap.profile.weightLbs === undefined ? "text-muted" : stale ? "text-warn" : undefined}
            />
            <Cell label="Last dose" border="border-b border-l border-white/10" main={lastDose ? lastDose.medication : "None"} meta={lastDose ? `${formatClock(lastDose.at)} · ${lastDose.caregiver}` : "In the last 24 hrs"} />
            <Cell label="Next dose" border="pl-0" main={lock ? formatClock(Date.parse(lock.next_eligible_time)) : "No dose locks"} meta={lock ? `Unlocks ${lock.ingredient}` : undefined} tone={lock ? "text-warn" : undefined} />
            <Cell label="Safety ledger" border="border-l border-white/10" main={lock ? "Locked" : "All locks open"} meta={lock ? snap.active_locks.map((l) => l.ingredient).join(", ") : "No active locks"} />
          </div>
        </section>
      )}

      <section className="glass flex min-h-[122px] flex-1 flex-col overflow-hidden rounded-[29px] p-5" aria-label="Safety Ledger">
        <div className="shrink-0 text-[14px] font-medium text-soft">Safety Ledger · last 24 hours</div>
        {ledger.length === 0 ? (
          <p className="mt-2 text-[14px] leading-snug text-dim">Nothing given yet. Every dose, by anyone, appears here on every screen in the house.</p>
        ) : (
          <ol className="mt-2 min-h-0 overflow-y-auto">
            {ledger.map((e) => (
              <li key={e.eventId} className="flex items-baseline justify-between gap-3 border-b border-white/10 py-2">
                <span className="text-[14px] text-white"><b className="font-medium">{e.caregiver}</b> · {e.medication}{e.volumeMl !== undefined && <> · {e.volumeMl} mL</>}</span>
                <span className="shrink-0 text-[13px] tabular-nums text-soft">{formatClock(e.at)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}
