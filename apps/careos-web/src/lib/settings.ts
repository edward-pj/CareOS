export interface Settings {
  highContrast: boolean;
  reducedMotion: boolean;
  /** Hide the screen and show only what a speaker without a display would say. */
  screenless: boolean;
  speakReplies: boolean;
}

export const DEFAULT_SETTINGS: Settings = { highContrast: false, reducedMotion: false, screenless: false, speakReplies: true };
const KEY = "careos.settings.v1";

/** localStorage can throw or be empty (private windows, blocked storage): the app must render fine without it. */
export function loadSettings(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): Settings {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      highContrast: parsed.highContrast === true,
      reducedMotion: parsed.reducedMotion === true,
      screenless: parsed.screenless === true,
      speakReplies: parsed.speakReplies !== false,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(s));
  } catch {
    /* non-essential */
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The OS asks for reduced motion: start there unless the person has chosen otherwise. */
export const prefersReducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
