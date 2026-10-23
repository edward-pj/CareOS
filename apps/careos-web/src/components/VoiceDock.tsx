import { useEffect, useRef, useState } from "react";
import type { Caregiver, PatientSnapshot } from "../api/types";
import type { Speech } from "../hooks/useSpeech";
import { presets } from "../lib/presets";
import { Dock, type DockProps } from "./Dock";

interface Props {
  busy: boolean;
  send: (text: string) => void;
  speech: Speech;
  patient?: PatientSnapshot;
  caregiver: string;
  caregivers: Caregiver[];
  onCaregiver: (name: string) => void;
  /** Whether the one-tap question chips are shown above the ask bar. */
  showPresets: boolean;
  dock: DockProps;
  /** A photo the caregiver chose. The App uploads it and shows the result as a card. */
  onPhoto?: (kind: "prescription" | "label", file: File) => void;
  photoBusy?: boolean;
}

const round = "grid h-[44px] w-[44px] shrink-0 place-items-center rounded-full border-0";
const svg = { width: 28, height: 28, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

/** Bottom dock: question chips, the ask bar (mic, text, photo, who is speaking, send) and the menu. */
export function VoiceDock({ busy, send, speech, patient, caregiver, caregivers, onCaregiver, showPresets, dock, onPhoto, photoBusy }: Props) {
  const [text, setText] = useState("");
  const [menu, setMenu] = useState(false);
  const kind = useRef<"prescription" | "label">("prescription");
  const file = useRef<HTMLInputElement>(null);
  const pick = (k: "prescription" | "label") => { kind.current = k; setMenu(false); file.current?.click(); };
  const submit = (t: string) => {
    if (!t.trim()) return;
    send(t);
    setText("");
  };

  // The mic result is shown in the box as you speak, then sent on its own, like saying "Alexa, ...".
  useEffect(() => { if (speech.interim) setText(speech.interim); }, [speech.interim]);
  useEffect(() => { if (!speech.listening) setText(""); }, [speech.listening]);

  return (
    <footer className="flex shrink-0 flex-col items-center gap-3 px-5.5 pb-2 pt-1.5">
      {showPresets && (
        <div className="rail flex w-full max-w-[1100px] items-center gap-2 overflow-x-auto py-0.5 [justify-content:safe_center]" aria-label="Suggested questions">
          <span className="shrink-0 pr-1.5 text-[13px] text-muted">Try</span>
          {presets(patient, caregivers, caregiver).slice(0, 6).map((p) => (
            <button key={p} disabled={busy} onClick={() => submit(p)} title={p} className="chip min-h-[44px] shrink-0 whitespace-nowrap rounded-full border border-white/15 bg-white/5 px-4 text-[13px] text-soft transition-colors disabled:opacity-40">
              {p}
            </button>
          ))}
        </div>
      )}

      {photoBusy && (
        <div role="status" className="glass flex items-center rounded-full px-5 py-2 text-[13px] text-[#dbe6f2]">Reading the photo…</div>
      )}

      <div className="flex w-full max-w-[1100px] flex-wrap items-center justify-center gap-4">
        <form className="glass flex h-[60px] min-w-[403px] max-w-[706px] flex-1 items-center gap-1.5 rounded-full px-2" onSubmit={(e) => { e.preventDefault(); submit(text); }}>
          <button
            type="button"
            onClick={speech.toggleMic}
            disabled={!speech.micSupported}
            title={speech.micSupported ? "Toggle microphone" : "Speech recognition is not available in this browser (use Chrome)"}
            aria-pressed={speech.listening}
            aria-label="Microphone"
            className={`${round} transition-colors disabled:opacity-40 ${speech.listening ? "pulse-dot bg-accent text-[#04201a]" : "bg-white/10 text-[#dbe6f2]"}`}
          >
            <svg {...svg}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
          </button>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={speech.listening ? "Listening…" : `Ask CareOS as ${caregiver}…`}
            aria-label="Message to Alexa"
            className="h-[44px] min-w-0 flex-1 border-0 bg-transparent px-2 text-[16px] text-white outline-none"
          />
          <div aria-hidden data-live={speech.listening} className="flex h-8 shrink-0 items-center gap-1">
            {[-0.1, -0.5, -0.3, -0.7, -0.2].map((d) => <span key={d} className="wave-bar" style={{ animationDelay: `${d}s` }} />)}
          </div>
          {onPhoto && (
            <div className="relative">
              <button type="button" onClick={() => setMenu((m) => !m)} disabled={busy || photoBusy} aria-haspopup="menu" aria-expanded={menu} aria-label="Add a photo" className={`${round} ghost bg-transparent text-soft disabled:opacity-40`}>
                {photoBusy ? "…" : <svg {...svg}><path d="M4 8h3l1.5-2h7L17 8h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>}
              </button>
              {menu && (
                <div role="menu" className="glass absolute bottom-[60px] right-0 z-30 w-[331px] rounded-[20px] p-2" style={{ backgroundColor: "rgba(8,16,36,.82)" }}>
                  <button role="menuitem" onClick={() => pick("prescription")} className="row min-h-[46px] w-full rounded-2xl px-3.5 text-left text-[16px] font-medium text-white">💊 Prescription for {patient?.profile.name ?? "this person"}</button>
                  <button role="menuitem" onClick={() => pick("label")} className="row min-h-[46px] w-full rounded-2xl px-3.5 text-left text-[16px] font-medium text-white">🔎 Medicine bottle label</button>
                  <p className="px-3.5 pb-1 pt-1.5 text-[12px] text-muted">The photo is read once and not stored.</p>
                </div>
              )}
              <input ref={file} type="file" accept="image/*" capture="environment" className="hidden" aria-label="Choose a photo" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onPhoto(kind.current, f); }} />
            </div>
          )}
          <select value={caregiver} onChange={(e) => onCaregiver(e.target.value)} aria-label="Active caregiver" className="h-[44px] max-w-[137px] shrink-0 border-0 bg-transparent px-1 text-[13px] text-soft">
            {caregivers.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
          <button disabled={busy || !text.trim()} aria-label="Send" className={`${round} bg-accent text-[#04201a] transition-opacity enabled:hover:brightness-110 disabled:opacity-40`}>
            <svg {...svg} strokeWidth={2}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </button>
        </form>

        <Dock {...dock} />
      </div>
    </footer>
  );
}
