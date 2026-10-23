import { useCallback, useEffect, useState } from "react";
import { loadSettings, prefersReducedMotion, saveSettings, type Settings } from "../lib/settings";

/** Accessibility + display toggles. Applied as data attributes on <html> so plain CSS can react to them. */
export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState<Settings>(() => {
    const s = loadSettings();
    return { ...s, reducedMotion: s.reducedMotion || prefersReducedMotion() };
  });

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.contrast = settings.highContrast ? "high" : "normal";
    root.dataset.motion = settings.reducedMotion ? "reduced" : "full";
  }, [settings.highContrast, settings.reducedMotion]);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  return [settings, update];
}
