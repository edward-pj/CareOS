import type { PatientSnapshot } from "../api/types";
import type { Household } from "../hooks/useHousehold";
import { useNow } from "../hooks/useNow";
import { formatClock, formatRemaining } from "../lib/time";
import { Orb } from "./Orb";

/** The resting card: the Active Care Session status for the selected person. Never says "clear" if it cannot be sure. */
export function IdleCard({ household: h, snap, listening = false }: { household: Household; snap?: PatientSnapshot; listening?: boolean }) {
  const now = useNow(h.clockSkewMs);
  if (!snap) {
    return <Frame title="Connecting" hue={-135}><Headline hot="Connecting" color="#ffbf5e" /><Sub>{h.error ?? "Loading the household…"}</Sub></Frame>;
  }
  const name = snap.profile.name;
  if (h.error) {
    return (
      <Frame title={`${name}: status unknown`} hue={-135} listening={listening}>
        <div role="alert" className="text-[40px] font-semibold leading-tight text-warn">⚠ Status unknown</div>
        <Sub>I can't reach CareOS, so I can't confirm {name}'s dose locks. Don't dose from this screen. Read the label or call your nurse line.</Sub>
      </Frame>
    );
  }
  if (snap.active_locks.length === 0) {
    return (
      <Frame title={`${name}: all clear`} hue={0} listening={listening}>
        <Headline pre={`${name.toUpperCase()} IS`} hot="CLEAR TO DOSE" color="#4ff0b4" />
        <Sub>No dose locks for {name}. Say "Alexa, ask CareOS how much…" and I'll check everything first.</Sub>
      </Frame>
    );
  }
  return (
    <Frame title={`${name}: dose lock`} hue={-135} listening={listening}>
      <Headline pre={`${name.toUpperCase()} IS`} hot="DOSE LOCKED" color="#ffbf5e" />
      <div className="mt-1 flex flex-col items-center gap-2">
        {snap.active_locks.map((l) => {
          const at = Date.parse(l.next_eligible_time);
          return (
            <div key={l.ingredient} className="flex flex-col items-center">
              <div className="text-[14px] uppercase tracking-widest text-muted">Locked until</div>
              <div className="text-[52px] font-semibold leading-none tabular-nums text-warn">{formatClock(at)}</div>
              <p className="mt-1.5 text-[16px] text-soft">
                <span className="capitalize">{l.ingredient}</span> · {l.status === "DAILY_MAX_REACHED" ? "daily maximum reached" : "next dose due"} · {formatRemaining(at - now)} to go
              </p>
            </div>
          );
        })}
      </div>
    </Frame>
  );
}

function Headline({ pre, hot, color }: { pre?: string; hot: string; color: string }) {
  return (
    <h2 className="m-0 text-[40px] font-semibold leading-[1.12] tracking-[.01em] text-white">
      {pre && <>{pre} </>}
      <span style={{ color, transition: "color .8s" }}>{hot}</span>
    </h2>
  );
}

function Sub({ children }: { children: React.ReactNode }) {
  return <p className="m-0 max-w-[518px] text-[16px] leading-normal text-dim [text-wrap:pretty]">{children}</p>;
}

/** The orb above the verdict. The section keeps the title as its accessible name. */
export function Frame({ title, hue, listening = false, children }: { title: string; hue: number; listening?: boolean; children: React.ReactNode }) {
  return (
    <section className="flex h-full flex-col items-center justify-center gap-5.5 text-center" aria-label={title}>
      <Orb size={240} hue={hue} active={listening} />
      <div className="flex flex-col items-center gap-3">{children}</div>
    </section>
  );
}
