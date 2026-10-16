import { useCallback, useEffect, useRef, useState } from "react";

// Minimal typings for the (still prefixed in Chromium) Web Speech recognition API.
interface RecognitionResult { isFinal: boolean; 0: { transcript: string } }
interface RecognitionEvent { results: ArrayLike<RecognitionResult> }
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => Recognition;

const Ctor = (): RecognitionCtor | undefined => {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

export interface Speech {
  micSupported: boolean;
  listening: boolean;
  interim: string;
  toggleMic: () => void;
  speak: (text: string) => void;
  voiceReplies: boolean;
  setVoiceReplies: (v: boolean) => void;
}

/** Browser voice for the simulator: mic -> transcript via Web Speech, replies via speechSynthesis. */
export function useSpeech(onFinalTranscript: (text: string) => void): Speech {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [voiceReplies, setVoiceReplies] = useState(true);
  const rec = useRef<Recognition | undefined>(undefined);
  const micSupported = typeof window !== "undefined" && !!Ctor();
  const onFinal = useRef(onFinalTranscript);
  onFinal.current = onFinalTranscript;

  useEffect(() => () => rec.current?.stop(), []);

  const toggleMic = useCallback(() => {
    const C = Ctor();
    if (!C) return;
    if (rec.current) {
      rec.current.stop();
      return;
    }
    const r = new C();
    r.lang = "en-US";
    r.interimResults = true;
    r.continuous = false;
    r.onresult = (e) => {
      let text = "";
      let final = false;
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i]!;
        text += res[0].transcript;
        final ||= res.isFinal;
      }
      setInterim(text);
      if (final) onFinal.current(text.trim());
    };
    const end = () => {
      rec.current = undefined;
      setListening(false);
      setInterim("");
    };
    r.onend = end;
    r.onerror = end;
    rec.current = r;
    setListening(true);
    r.start();
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!voiceReplies || typeof speechSynthesis === "undefined") return;
      speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    },
    [voiceReplies],
  );

  return { micSupported, listening, interim, toggleMic, speak, voiceReplies, setVoiceReplies };
}
