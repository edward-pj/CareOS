import type { PatientSnapshot } from "../api/types";
import type { Conversation } from "../hooks/useConversation";
import type { Household } from "../hooks/useHousehold";
import type { Speech } from "../hooks/useSpeech";
import { lastHeard, lastToolUsed } from "../lib/conversation";
import { formatClock } from "../lib/time";

function status(p: PatientSnapshot, error: string | undefined): { text: string; color: string } {
  if (error) return { text: "Status unknown", color: "#ffbf5e" };
  const lock = p.active_locks[0];
  if (lock) return { text: `Locked until ${formatClock(Date.parse(lock.next_eligible_time))}`, color: "#ffbf5e" };
  return { text: "Clear to dose", color: "#4ff0b4" };
}

/** Left panel: the household (tap to switch person), what Alexa heard, which tool answered, and what Alexa said. */
export function People({ household: h, convo, speech, patientId, onPatient }: { household: Household; convo: Conversation; speech: Speech; patientId: string; onPatient: (id: string) => void }) {
  const patients = h.data?.patients ?? [];
  const heard = speech.listening && speech.interim ? speech.interim : lastHeard(convo);
  const tool = lastToolUsed(convo);
  const lastReply = [...convo.messages].reverse().find((m) => m.role === "assistant");
  return (
    <aside className="glass flex h-full min-h-0 flex-col gap-4 overflow-y-auto rounded-[26px] p-5" aria-label="Household and voice">
      <div className="text-[14px] font-medium text-soft">Household</div>
      <div className="flex flex-col gap-1">
        {patients.map((p) => {
          const st = status(p, h.error);
          const on = p.profile.id === patientId;
          return (
            <button key={p.profile.id} onClick={() => onPatient(p.profile.id)} aria-pressed={on} className={`row flex min-h-[63px] w-full flex-col items-start gap-1 rounded-[17px] px-3.5 py-3 text-left text-white transition-colors ${on ? "bg-white/10" : "bg-transparent"}`}>
              <span className="text-[16px] font-medium">{p.profile.name} <span className="text-[13px] font-normal text-muted">{p.profile.kind === "infant" ? "Infant" : "Elder"}</span></span>
              <span className="flex items-center gap-1.5 text-[13px]" style={{ color: st.color }}>
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: st.color }} aria-hidden />
                {st.text}
              </span>
            </button>
          );
        })}
      </div>

      <div className="h-px shrink-0 bg-white/10" />

      <section>
        <div className="mb-1.5 text-[13px] text-muted">What Alexa heard</div>
        <p className="text-[16px] leading-snug text-white" data-testid="heard">{heard ? `“${heard}”` : "Say “Alexa, ask CareOS…”"}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[13px] text-muted">
          Tool used: <span className="rounded-full border border-warn/60 px-2 py-0.5 font-mono text-warn" data-testid="tool-chip">{convo.busy && convo.progress ? convo.progress : tool ?? "none yet"}</span>
        </div>
      </section>

      {lastReply && (
        <>
          <div className="h-px shrink-0 bg-white/10" />
          <section aria-live="polite" data-testid="reply">
            <div className="mb-1.5 text-[13px] text-glow">Alexa said</div>
            <p className="text-[16px] leading-snug text-white">{lastReply.text}</p>
            {lastReply.followup && <p className="mt-1.5 text-[13px] leading-snug text-soft">{lastReply.followup}</p>}
          </section>
        </>
      )}
    </aside>
  );
}
