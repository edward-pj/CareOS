import type { PatientSnapshot } from "../api/types";
import { formatClock } from "../lib/time";

const DAY = 86_400_000;

/** The care card: what CareOS has on file for the active person. Read-only here; it is changed by telling CareOS (or by a confirmed prescription). */
export function CareSheet({ snap, now, onClose }: { snap?: PatientSnapshot; now: number; onClose: () => void }) {
  const p = snap?.profile;
  const ledger = (snap?.medication_history ?? []).filter((e) => e.at > now - DAY).sort((a, b) => b.at - a.at);
  const list = (items: string[] | undefined) => (items && items.length > 0 ? items.join(", ") : "Not recorded");
  const rows: Array<[string, string]> = [
    ["Weight", p?.weightLbs !== undefined ? `${p.weightLbs} lb${snap?.weight_days_ago != null ? ` (${snap.weight_days_ago} days ago)` : ""}` : "Not recorded"],
    ["Allergies", list(p?.allergies)],
    ["Conditions", list(p?.conditions)],
    ["Medicines on file", list(p?.activeRx)],
  ];
  return (
    <section role="dialog" aria-label="Care card" className="sheet glass absolute inset-0 z-20 overflow-auto rounded-[32px] p-7" style={{ backgroundColor: "rgba(8,16,36,.62)" }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[14px] text-muted">Care card</div>
          <div className="mt-1 flex items-baseline gap-3"><span className="text-[36px] font-semibold text-white">{p?.name ?? "…"}</span><span className="text-[16px] text-[#aab8c9]">{p ? (p.kind === "infant" ? "Infant" : "Elder") : ""}</span></div>
        </div>
        <button onClick={onClose} aria-label="Close care card" className="ghost grid h-[44px] w-[44px] place-items-center rounded-full border border-white/15 bg-white/5 text-[#dbe6f2]">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>
      <div className="mt-5.5 grid grid-cols-2 gap-11">
        <dl className="flex flex-col gap-4">
          {rows.map(([label, value]) => (
            <div key={label} className="flex flex-col gap-1 border-b border-white/15 pb-2">
              <dt className="text-[13px] text-muted">{label}</dt>
              <dd className="m-0 text-[18px] text-white">{value}</dd>
            </div>
          ))}
        </dl>
        <div>
          <div className="mb-3 text-[14px] text-muted">Safety ledger, last 24 hours</div>
          {ledger.length === 0 ? (
            <p className="max-w-[374px] text-[16px] leading-relaxed text-dim">Nothing given yet. Every dose, by anyone, appears here on every screen in the house.</p>
          ) : (
            <ol>
              {ledger.map((e) => (
                <li key={e.eventId} className="flex items-baseline justify-between gap-4 border-b border-white/10 py-3">
                  <div>
                    <div className="text-[18px] font-medium text-white">{e.medication}{e.volumeMl !== undefined && <> · {e.volumeMl} mL</>}</div>
                    <div className="mt-0.5 text-[13px] text-[#aab8c9]">by {e.caregiver}</div>
                  </div>
                  <div className="whitespace-nowrap text-[16px] tabular-nums text-[#dbe6f2]">{formatClock(e.at)}</div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}
