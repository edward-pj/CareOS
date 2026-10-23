import type { PatientSnapshot } from "../api/types";
import type { Household } from "../hooks/useHousehold";
import { useNow } from "../hooks/useNow";
import { formatClock } from "../lib/time";

interface Props {
  household: Household;
  patientId: string;
  onPatient: (id: string) => void;
  onEmergency: () => void;
  onInspector: () => void;
  inspectorOpen: boolean;
}

const PILL_W = 140;
const PILL_H = 44;
const role = (p: PatientSnapshot) => (p.profile.kind === "infant" ? "Infant" : "Elder");

/** Top bar: brand, who the active person is, live status, clock, and the always-available Emergency button. */
export function Header({ household: h, patientId, onPatient, onEmergency, onInspector, inspectorOpen }: Props) {
  const now = useNow(h.clockSkewMs);
  const patients: PatientSnapshot[] = h.data?.patients ?? [];
  const index = Math.max(0, patients.findIndex((p) => p.profile.id === patientId));
  const slide = { width: PILL_W, height: PILL_H, borderRadius: PILL_H / 2, background: "#1b6064" };
  return (
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-4 px-8.5 pt-5.5">
      <div className="flex flex-1 basis-[187px]">
        <div className="relative font-display text-[28px] font-medium leading-none tracking-[.1em] text-white">
          CARE<span className="text-teal">OS</span>
          <span className="absolute -right-3.5 -top-1.5 h-2.5 w-2.5 rounded-full bg-teal shadow-[0_0_10px_#3ee7c0]" aria-hidden />
        </div>
      </div>

      <nav className="glass flex rounded-full p-1.5" aria-label="Active person">
        <div aria-hidden className="pointer-events-none absolute inset-1.5 [filter:url(#goo)]">
          <div className="absolute left-0 top-0" style={{ ...slide, transform: `translateX(${index * PILL_W}px)`, transition: "transform .45s cubic-bezier(.3,1.35,.4,1)" }} />
          <div className="absolute left-0 top-0" style={{ ...slide, transform: `translateX(${index * PILL_W}px)`, transition: "transform .75s cubic-bezier(.3,1,.3,1)" }} />
        </div>
        {patients.map((p) => {
          const on = p.profile.id === patientId;
          return (
            <button
              key={p.profile.id}
              onClick={() => onPatient(p.profile.id)}
              aria-pressed={on}
              style={{ width: PILL_W, height: PILL_H }}
              className={`relative rounded-full text-[16px] font-medium transition-colors duration-300 ${on ? "text-white" : "text-[#a9bbcf]"}`}
            >
              {p.profile.name} ({role(p)})
            </button>
          );
        })}
      </nav>

      <div className="flex flex-1 basis-[187px] items-center justify-end gap-5">
        <button onClick={onInspector} aria-expanded={inspectorOpen} className="ghost flex h-[44px] items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 text-[13px] font-medium text-soft">MCP Inspector</button>
        <button onClick={onEmergency} className="ghost flex h-[44px] items-center gap-2 rounded-full border border-[rgba(255,122,122,.55)] bg-[rgba(255,90,90,.08)] px-4 text-[14px] font-semibold text-[#ff9a9a]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M7 19v-6a5 5 0 0 1 10 0v6" /><path d="M5 19h14M12 3v2M4.5 6l1.5 1.5M19.5 6 18 7.5" /></svg>
          Emergency
        </button>
        <div className="text-right">
          <div className="whitespace-nowrap text-[28px] font-medium leading-[1.1] tabular-nums text-white" aria-label="Time">{formatClock(now)}</div>
        </div>
      </div>
    </header>
  );
}
