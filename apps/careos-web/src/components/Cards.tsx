import { useState } from "react";
import { api } from "../api/client";
import type { CardType } from "../api/types";

// Every number rendered here is copied from the tool payload, never derived, so a card cannot
// disagree with the deterministic engines.

type Payload = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const recs = (v: unknown): Payload[] => (Array.isArray(v) ? v.filter((x): x is Payload => typeof x === "object" && x !== null) : []);

export interface CardContext {
  patientId: string;
  caregiver: string;
  onSend: (text: string) => void;
  disabled: boolean;
}

function Shell({ tone, label, children }: { tone: "ok" | "danger" | "warn"; label: string; children: React.ReactNode }) {
  const ring = { ok: "border-cyan-400/40 bg-cyan-400/5", danger: "border-red-500/60 bg-red-500/10", warn: "border-amber-400/50 bg-amber-400/10" }[tone];
  const text = { ok: "text-cyan-300", danger: "text-red-300", warn: "text-amber-300" }[tone];
  return (
    <section className={`rounded-2xl border p-4 ${ring}`} aria-label={label}>
      <h3 className={`mb-2 text-xs font-semibold uppercase tracking-widest ${text}`}>{label}</h3>
      {children}
    </section>
  );
}

function Syringe({ payload }: { payload: Payload }) {
  const ml = num(payload.dispense_volume_ml);
  const mg = num(payload.delivered_dose_mg);
  // Visual fill only (0-5 mL barrel); the numerals come from the payload.
  const fill = ml === undefined ? 0 : Math.min(1, ml / 5);
  return (
    <Shell tone="ok" label="Dose">
      <div className="flex items-end gap-4">
        <div className="text-6xl font-bold tabular-nums text-white">{ml === undefined ? "—" : ml}<span className="ml-1 text-2xl text-cyan-300">mL</span></div>
        <div className="mb-2 text-sm text-slate-300">
          {mg !== undefined && <div>{mg} mg delivered</div>}
          {str(payload.formulation_label) && <div>{str(payload.formulation_label)}</div>}
        </div>
      </div>
      <div className="mt-3 h-4 w-full overflow-hidden rounded-full border border-cyan-400/40 bg-slate-900" role="img" aria-label={`Syringe filled to ${ml ?? 0} millilitres`}>
        <div className="h-full bg-cyan-400 transition-[width] duration-700" style={{ width: `${fill * 100}%` }} />
      </div>
      {str(payload.warning) && <p className="mt-2 text-xs text-amber-300">{str(payload.warning)}</p>}
    </Shell>
  );
}

function DoubleDose({ payload, ctx }: { payload: Payload; ctx: CardContext }) {
  const last = (payload.last_dose ?? {}) as Payload;
  const mins = num(payload.remaining_minutes);
  const ingredient = str(payload.ingredient);
  const [pin, setPin] = useState("");
  const [result, setResult] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function override() {
    if (!ingredient) return;
    setBusy(true);
    try {
      const r = await api.override({ patient_id: ctx.patientId, ingredient, caregiver: ctx.caregiver, pin });
      setResult(r.status === "OVERRIDE_GRANTED" ? "Override granted for a short window." : (r.reason ?? "Override denied."));
    } catch {
      setResult("Override failed.");
    } finally {
      setBusy(false);
      setPin("");
    }
  }

  return (
    <Shell tone="danger" label={str(payload.violation_type) === "DAILY_MAX" ? "Daily maximum reached" : "Double-dose lock"}>
      <div role="alert" className="text-5xl font-bold tabular-nums text-red-200">{mins === undefined ? "—" : mins}<span className="ml-1 text-xl">min</span></div>
      {str(last.caregiver) && (
        <p className="mt-1 text-sm text-slate-200">
          {str(last.caregiver)} gave {str(last.medication) ?? "a dose"} at {str(last.time_label) ?? "an earlier time"}
          {num(last.minutes_ago) !== undefined && ` (${num(last.minutes_ago)} min ago)`}.
        </p>
      )}
      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void override();
        }}
      >
        <input
          type="password"
          inputMode="numeric"
          maxLength={4}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          placeholder="PIN"
          aria-label="Override PIN"
          className="w-20 rounded-lg border border-red-400/40 bg-slate-900 px-3 py-1.5 text-center text-sm tracking-widest"
        />
        <button disabled={pin.length !== 4 || busy} className="rounded-lg border border-red-400/60 px-3 py-1.5 text-sm text-red-200 enabled:hover:bg-red-500/20 disabled:opacity-40">
          Override
        </button>
        {result && <span className="text-xs text-slate-300">{result}</span>}
      </form>
    </Shell>
  );
}

function Shield({ payload }: { payload: Payload }) {
  return (
    <Shell tone="danger" label="Not safe to give">
      <p className="text-sm text-slate-100">{str(payload.clinical_rationale)}</p>
      {strs(payload.conflicting_rx).length > 0 && <p className="mt-1 text-xs text-slate-300">Conflicts with: {strs(payload.conflicting_rx).join(", ")}</p>}
      {str(payload.approved_alternative) && <p className="mt-2 rounded-lg bg-emerald-400/10 px-3 py-1.5 text-sm text-emerald-300">Safer option: {str(payload.approved_alternative)}</p>}
    </Shell>
  );
}

function Pantry({ payload }: { payload: Payload }) {
  return (
    <Shell tone="ok" label={str(payload.remedy_title) ?? "Pantry remedy"}>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-100">
        {strs(payload.preparation_steps).map((s) => <li key={s}>{s}</li>)}
      </ol>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {strs(payload.safety_badges).map((b) => <span key={b} className="rounded-full bg-emerald-400/15 px-2.5 py-0.5 text-xs text-emerald-300">✓ {b}</span>)}
      </div>
    </Shell>
  );
}

function Restock({ payload, ctx }: { payload: Payload; ctx: CardContext }) {
  const items = recs(payload.items);
  const total = num(payload.total_usd);
  return (
    <Shell tone="ok" label="Restock — review your cart">
      <div className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2" role="list">
        {items.map((it) => (
          <div key={str(it.name)} role="listitem" className="w-44 shrink-0 snap-start rounded-xl border border-cyan-400/30 bg-slate-900 p-3">
            <div className="text-xs uppercase tracking-wide text-cyan-300">{str(it.channel)}</div>
            <div className="mt-1 text-sm font-medium text-white">{str(it.name)}</div>
            <div className="text-xs text-slate-400">{str(it.merchant)}</div>
            {num(it.price_usd) !== undefined && <div className="mt-2 text-lg font-semibold text-white">${num(it.price_usd)!.toFixed(2)}</div>}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-slate-300">
          {total !== undefined && <span className="text-lg font-semibold text-white">${total.toFixed(2)}</span>}
          {str(payload.eta) && <span className="ml-2">Arrives {str(payload.eta)}</span>}
        </div>
        <button
          disabled={ctx.disabled}
          onClick={() => ctx.onSend("Confirm the order")}
          className="rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 enabled:hover:bg-cyan-300 disabled:opacity-40"
        >
          {str(payload.confirm_label) ?? "Confirm order"}
        </button>
      </div>
    </Shell>
  );
}

export function CardView({ type, payload, ctx }: { type: CardType; payload: Payload; ctx: CardContext }) {
  switch (type) {
    case "SYRINGE_CALIBRATOR": return <Syringe payload={payload} />;
    case "DOUBLE_DOSE_INTERCEPT": return <DoubleDose payload={payload} ctx={ctx} />;
    case "CONTRAINDICATION_SHIELD": return <Shield payload={payload} />;
    case "PANTRY_REMEDY": return <Pantry payload={payload} />;
    case "AMAZON_RESTOCK_CAROUSEL": return <Restock payload={payload} ctx={ctx} />;
  }
}
