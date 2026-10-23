import type { Settings } from "../lib/settings";

const ROWS: Array<[keyof Settings, string, string]> = [
  ["highContrast", "High contrast", "Pure black and white with thicker borders."],
  ["reducedMotion", "Reduced motion", "No pulsing or fill animation."],
  ["screenless", "Screenless mode", "Hide the screen and show only what a speaker would say."],
  ["speakReplies", "Speak replies", "Read answers aloud in this browser."],
];

/** A switch drawn over a real checkbox, so keyboard and screen readers behave exactly as before. */
function Switch({ checked, onChange, label }: { checked: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <span className="relative inline-flex h-[44px] w-[56px] shrink-0 items-center">
      <input type="checkbox" role="switch" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0" />
      <span className="absolute left-1 top-[8px] h-[28px] w-[48px] rounded-full bg-white/20 transition-colors peer-checked:bg-[#2fb594] peer-focus-visible:outline peer-focus-visible:outline-[3px] peer-focus-visible:outline-offset-2 peer-focus-visible:outline-glow" />
      <span className="absolute left-[6px] top-[10px] h-6 w-6 rounded-full bg-white transition-transform duration-300 peer-checked:translate-x-[20px]" />
    </span>
  );
}

export function SettingsPanel({ settings, update, onClose, onReset, resetting, showPrompts, onShowPrompts }: { settings: Settings; update: (p: Partial<Settings>) => void; onClose: () => void; onReset: () => void; resetting: boolean; showPrompts: boolean; onShowPrompts: (on: boolean) => void }) {
  const row = "flex min-h-[63px] items-center justify-between gap-4 border-b border-white/10 py-3";
  return (
    <section role="dialog" aria-label="Settings" className="sheet glass absolute inset-0 z-20 overflow-auto rounded-[32px] p-7" style={{ backgroundColor: "rgba(8,16,36,.62)" }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[14px] text-muted">This screen</div>
          <h2 className="mt-1 text-[36px] font-semibold text-white">Settings</h2>
        </div>
        <button onClick={onClose} aria-label="Close settings" className="ghost grid h-[44px] min-w-[44px] place-items-center rounded-full border border-white/15 bg-white/5 px-4 text-[16px] font-medium text-[#dbe6f2]">Done</button>
      </div>
      <ul className="mt-3 flex max-w-[648px] flex-col">
        {ROWS.map(([key, label, hint]) => (
          <li key={key} className={row}>
            <div>
              <div className="text-[18px] font-medium text-white">{label}</div>
              <div className="mt-0.5 text-[13px] text-dim">{hint}</div>
            </div>
            <Switch checked={settings[key]} onChange={(on) => update({ [key]: on })} label={label} />
          </li>
        ))}
        <li className={row}>
          <div>
            <div className="text-[18px] font-medium text-white">Demo prompts</div>
            <div className="mt-0.5 text-[13px] text-dim">Quick questions above the ask bar.</div>
          </div>
          <Switch checked={showPrompts} onChange={onShowPrompts} label="Demo prompts" />
        </li>
        <li className="flex min-h-[63px] items-center justify-between gap-4 py-3">
          <div>
            <div className="text-[18px] font-medium text-white">Reset demo</div>
            <div className="mt-0.5 text-[13px] text-dim">Clears doses, orders and edits.</div>
          </div>
          <button onClick={onReset} disabled={resetting} className="ghost min-h-[44px] rounded-full border border-warn/60 bg-warn/10 px-5.5 text-[16px] font-semibold text-warn disabled:opacity-40">Reset demo data</button>
        </li>
      </ul>
    </section>
  );
}
