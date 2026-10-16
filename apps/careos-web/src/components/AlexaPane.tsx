import { useEffect, useRef, useState } from "react";
import type { PatientSnapshot, Caregiver } from "../api/types";
import type { Conversation } from "../hooks/useConversation";
import type { Speech } from "../hooks/useSpeech";
import { AgentTrace } from "./AgentTrace";
import { CardView } from "./Cards";

interface Props {
  convo: Conversation;
  speech: Speech;
  patient?: PatientSnapshot;
  caregiver: string;
  caregivers: Caregiver[];
}

/** Preset prompts. They use the active profile's own data so they stay valid when the seed changes. */
function presets(patient: PatientSnapshot | undefined, caregivers: Caregiver[], caregiver: string): string[] {
  const name = patient?.profile.name ?? "Leo";
  const weight = patient?.profile.weightLbs;
  const other = caregivers.find((c) => c.name !== caregiver)?.name;
  return [
    weight ? `${name} has a fever and weighs ${weight} lbs. How much Motrin?` : `${name} has a fever. How much Motrin?`,
    `I gave ${name} 2 mL of Motrin`,
    "Can Frank take NyQuil?",
    `${name} has a sore throat`,
    "Restock Motrin",
    ...(other ? [`Switch caregiver shift to ${other}`] : []),
  ];
}

export function AlexaPane({ convo, speech, patient, caregiver, caregivers }: Props) {
  const [text, setText] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const send = (t: string) => {
    void convo.send(t);
    setText("");
  };

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [convo.messages.length, convo.steps.length, convo.card?.key]);

  // Mic result goes straight to the assistant, like saying "Alexa, ..." out loud.
  useEffect(() => {
    if (speech.interim) setText(speech.interim);
  }, [speech.interim]);

  useEffect(() => {
    if (!speech.listening) setText("");
  }, [speech.listening]);

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Alexa+ surface">
      <header className="flex items-center gap-3 border-b border-slate-800 px-5 py-3">
        <div className="h-3 w-3 rounded-full bg-cyan-400 shadow-[0_0_12px_2px_rgba(34,211,238,0.7)]" />
        <h2 className="text-sm font-semibold tracking-wide">Alexa+ <span className="text-slate-400">simulated surface</span></h2>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-400">
          <input type="checkbox" checked={speech.voiceReplies} onChange={(e) => speech.setVoiceReplies(e.target.checked)} />
          Speak replies
        </label>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4" aria-live="polite">
        {convo.messages.length === 0 && (
          <p className="text-sm text-slate-400">
            Say or type what you'd tell Alexa. Bedrock only parses the request; every dose, lock and safety decision comes from the deterministic CareOS MCP tools.
          </p>
        )}
        {convo.messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${m.role === "user" ? "bg-slate-800 text-slate-100" : "border border-cyan-400/30 bg-cyan-400/10 text-cyan-50"}`}>
              {m.role === "user" && <span className="text-slate-400">“Alexa, </span>}
              {m.text}
              {m.role === "user" && <span className="text-slate-400">”</span>}
            </div>
          </div>
        ))}

        <AgentTrace steps={convo.steps} progress={convo.busy ? convo.progress : undefined} />

        {convo.alertText && (
          <div role="alert" className="rounded-xl border border-red-500/60 bg-red-500/15 px-4 py-2 text-sm font-medium text-red-200">
            {convo.alertText}
          </div>
        )}

        {convo.card && (
          <CardView
            key={convo.card.key}
            type={convo.card.cardType}
            payload={convo.card.payload}
            ctx={{ patientId: patient?.profile.id ?? "leo", caregiver, onSend: send, disabled: convo.busy }}
          />
        )}
        <div ref={bottom} />
      </div>

      <div className="space-y-2 border-t border-slate-800 px-5 py-3">
        <div className="flex flex-wrap gap-1.5">
          {presets(patient, caregivers, caregiver).map((p) => (
            <button
              key={p}
              disabled={convo.busy}
              onClick={() => send(p)}
              className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs text-slate-200 enabled:hover:border-cyan-400/60 enabled:hover:text-cyan-200 disabled:opacity-40"
            >
              {p}
            </button>
          ))}
        </div>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(text);
          }}
        >
          <button
            type="button"
            onClick={speech.toggleMic}
            disabled={!speech.micSupported}
            title={speech.micSupported ? "Toggle microphone" : "Speech recognition is not available in this browser (use Chrome)"}
            aria-pressed={speech.listening}
            aria-label="Microphone"
            className={`h-10 w-10 shrink-0 rounded-full border text-lg disabled:opacity-30 ${speech.listening ? "border-cyan-300 bg-cyan-400 text-slate-950 pulse-dot" : "border-slate-600 bg-slate-900"}`}
          >
            🎙
          </button>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={speech.listening ? "Listening…" : `Ask CareOS as ${caregiver}…`}
            aria-label="Message to Alexa"
            className="min-w-0 flex-1 rounded-full border border-slate-700 bg-slate-900 px-4 py-2 text-sm outline-none focus:border-cyan-400"
          />
          <button disabled={convo.busy || !text.trim()} className="rounded-full bg-cyan-400 px-5 py-2 text-sm font-semibold text-slate-950 enabled:hover:bg-cyan-300 disabled:opacity-40">
            Send
          </button>
        </form>
      </div>
    </section>
  );
}
