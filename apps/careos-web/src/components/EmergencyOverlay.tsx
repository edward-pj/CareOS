import { useEffect, useState } from "react";
import { EMERGENCY, telHref, type Locale } from "../lib/emergency";

/**
 * Always available, works with the server down (principle S8): everything here is compiled into the app.
 * CareOS prepares the call; a person places it. It never calls anyone on its own.
 */
export function EmergencyOverlay({ onClose }: { onClose: () => void }) {
  const [locale, setLocale] = useState<Locale>("US");
  const info = EMERGENCY[locale];

  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);

  return (
    <div role="alertdialog" aria-modal="true" aria-label="Emergency" className="absolute inset-0 z-50 flex flex-col overflow-auto bg-[rgba(28,4,10,.92)] p-10 backdrop-blur-2xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[14px] text-[#ff9a9a]">Emergency</div>
          <h2 className="mt-1.5 text-[36px] font-semibold leading-[1.1] text-white">🚨 This could be an emergency</h2>
          <p className="mt-2 text-[16px] text-[#e5c9cc]">Call now, then read the steps to the dispatcher.</p>
        </div>
        <button onClick={onClose} className="ghost min-h-[46px] rounded-full border border-white/25 px-6.5 text-[16px] font-medium text-[#f3dcdc]">Close</button>
      </div>
      <div className="mt-7 flex flex-1 items-center gap-11">
        <div className="flex-1">
          <a href={telHref(info.number)} className="block rounded-full bg-[#ff5a5a] px-8.5 py-8.5 text-center text-[81px] font-semibold leading-none text-[#2a0408] no-underline hover:bg-[#ff7272]">
            {info.label}
          </a>
          <div className="mt-5.5 flex items-center gap-4 text-[20px] text-[#f3dcdc]">
            {info.poison.tel ? <a className="underline" href={telHref(info.poison.tel)}>☠ {info.poison.label}</a> : <span>☠ {info.poison.label}</span>}
            <span className="ml-auto flex items-center gap-2 text-[16px]">
              Region:
              {(["US", "IN"] as const).map((l) => (
                <button key={l} onClick={() => setLocale(l)} aria-pressed={locale === l} className={`min-h-[46px] min-w-[60px] rounded-full border px-4 text-[18px] font-medium transition-colors ${locale === l ? "border-white bg-white text-[#2a0408]" : "ghost border-white/30 text-[#f3dcdc]"}`}>{l}</button>
              ))}
            </span>
          </div>
        </div>
        <ol className="flex-1 list-decimal space-y-3.5 pl-7 text-[22px] leading-snug text-white marker:text-[#ff9a9a]">
          {info.steps.map((s) => <li key={s}>{s}</li>)}
        </ol>
      </div>
      <p className="mt-5.5 text-[16px] text-[#e5b7bb]">CareOS prepares the call; you place it. It never calls anyone on its own. This screen works even if CareOS is offline.</p>
    </div>
  );
}
