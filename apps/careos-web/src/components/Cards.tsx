import { useNow } from "../hooks/useNow";
import type { CardType } from "../api/types";
import { formatRemaining } from "../lib/time";
import { EmergencyLocator, LabelLens, NurseLineBrief, RedFlagChecklist, RxConfirmation } from "./CareCards";

// Echo Show cards. Designed at 1080p for reading from 8-10 feet: one primary number per card, large type, and colour
// ALWAYS paired with an icon and words (never colour alone). Every number is copied from the tool payload, never
// derived here, so a card cannot disagree with the deterministic engines.

export type Payload = Record<string, unknown>;
export const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
export const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
export const recs = (v: unknown): Payload[] => (Array.isArray(v) ? v.filter((x): x is Payload => typeof x === "object" && x !== null) : []);
export const obj = (v: unknown): Payload => (typeof v === "object" && v !== null ? (v as Payload) : {});

export interface CardContext {
  patientId: string;
  caregiver: string;
  onSend: (text: string) => void;
  disabled: boolean;
  /** Opens the always-available help card (emergency numbers, what to do now). */
  onHelp: () => void;
  /** Opens the Orders screen (cart, tracking, supplies). */
  onOpenShop?: () => void;
  /** Shows a payload the card fetched itself (e.g. after a prescription is confirmed). */
  onShowPayload?: (userText: string, payload: Record<string, unknown>) => void;
  patientName: string;
}

export type Tone = "ok" | "danger" | "warn" | "info";
const TONE: Record<Tone, { box: string; label: string; icon: string; word: string }> = {
  ok: { box: "glass glass-ok", label: "text-mint", icon: "✔", word: "Verified" },
  danger: { box: "glass glass-danger", label: "text-alert", icon: "⛔", word: "Stop" },
  warn: { box: "glass glass-warn", label: "text-warn", icon: "⚠", word: "Check" },
  info: { box: "glass glass-info", label: "text-glow", icon: "❓", word: "Question" },
};

export function Shell({ tone, label, children, alert }: { tone: Tone; label: string; children: React.ReactNode; alert?: boolean }) {
  const t = TONE[tone];
  return (
    <section role={alert ? "alert" : undefined} aria-label={label} className={`${t.box} flex h-full flex-col overflow-y-auto rounded-[29px] p-6.5`}>
      <h3 className={`mb-2 flex shrink-0 items-center gap-2 text-[18px] font-semibold tracking-wide ${t.label}`}>
        <span aria-hidden>{t.icon}</span>
        <span>{label}</span>
      </h3>
      <div className="my-auto">{children}</div>
    </section>
  );
}

export const Chip = ({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "green" | "amber" | "red" }) => {
  const c = { slate: "border-white/20 text-soft", green: "border-mint/50 text-mint", amber: "border-warn/50 text-warn", red: "border-alert/50 text-alert" }[tone];
  return <span className={`rounded-full border px-3 py-0.5 text-[13px] ${c}`}>{children}</span>;
};

export const Sources = ({ payload }: { payload: Payload }) => {
  const sources = strs(payload.sources);
  const codes = strs(payload.reason_codes);
  if (sources.length === 0 && codes.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Why, and where this comes from">
      {codes.map((c) => <Chip key={c}>{c}</Chip>)}
      {sources.map((s) => <Chip key={s} tone="green">📄 {s.replace(/^FDA-LABEL:/, "FDA label ")}</Chip>)}
    </div>
  );
};

export function ActionButton({ children, onClick, disabled, tone = "primary" }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; tone?: "primary" | "danger" | "quiet" }) {
  const c = {
    primary: "bg-accent text-[#04201a] enabled:hover:brightness-110",
    danger: "bg-[#ff5a5a] text-[#2a0408] enabled:hover:bg-[#ff7272]",
    quiet: "border border-white/25 bg-white/5 text-[#dbe6f2] enabled:hover:bg-white/15",
  }[tone];
  return (
    <button onClick={onClick} disabled={disabled} className={`min-h-[52px] min-w-[144px] rounded-full px-6.5 text-[18px] font-semibold transition-colors disabled:opacity-40 ${c}`}>
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------------------------------- dose cards

function Syringe({ payload }: { payload: Payload }) {
  const ml = num(payload.dispense_volume_ml);
  const scale = num(payload.device_scale_ml) ?? 5;
  // Visual fill only; the numerals come from the payload. GPU-friendly: a scaleX transform, never an animated width.
  const fill = ml === undefined ? 0 : Math.min(1, ml / scale);
  const lb = num(payload.weight_lb);
  const kg = num(payload.weight_kg);
  const notes = strs(payload.notes);
  return (
    <Shell tone="ok" label="Verified dose">
      <div className="text-[20px] font-semibold uppercase tracking-wider text-slate-300">Fill to</div>
      <div className="font-bold leading-none tabular-nums text-white" style={{ fontSize: 95 }} aria-label={`Fill to ${str(payload.dose_display) ?? ""}`}>
        {str(payload.dose_display) ?? (ml === undefined ? "—" : `${ml} mL`)}
      </div>
      <div className="mt-3 text-[22px] font-semibold text-emerald-200">{str(payload.product_spoken)} <span className="text-slate-300">· {str(payload.concentration)}</span></div>
      <div className="mt-3 h-10 w-full overflow-hidden rounded-full border border-mint/50 bg-black/40" role="img" aria-label={`Illustrative syringe filled to ${ml ?? 0} millilitres`}>
        <div className="syringe-fill h-full origin-left rounded-full bg-accent" style={{ transform: `scaleX(${fill})`, willChange: "transform" }} />
      </div>
      <p className="mt-1.5 text-[16px] text-slate-400">Illustration only. Use {str(payload.device_name) ?? "the device that came in the box"}.</p>
      <div className="mt-3 flex flex-wrap gap-x-7 gap-y-1.5 text-[20px] text-slate-200">
        {str(payload.next_eligible_label) && <span>Next dose after <b className="text-white">{str(payload.next_eligible_label)}</b></span>}
        {lb !== undefined && kg !== undefined && <span>Weight used: <b className="text-white">{lb} lb ({kg} kg)</b></span>}
        {num(payload.mg_per_kg) !== undefined && <span>{num(payload.delivered_dose_mg)} mg · {num(payload.mg_per_kg)} mg/kg</span>}
      </div>
      {notes.map((n) => <p key={n} className="mt-2 text-[16px] text-amber-200">ℹ {n}</p>)}
      {str(payload.warning) && <p className="mt-2 text-[16px] text-amber-300">{str(payload.warning)}</p>}
      <Sources payload={payload} />
    </Shell>
  );
}

function Tablet({ payload }: { payload: Payload }) {
  const ingredients = strs(payload.ingredients);
  return (
    <Shell tone="ok" label="Verified dose">
      <div className="text-[20px] font-semibold uppercase tracking-wider text-slate-300">Take</div>
      <div className="font-bold leading-none tabular-nums text-white" style={{ fontSize: 95 }}>{str(payload.dose_display)}</div>
      <div className="mt-4 text-[22px] font-semibold text-emerald-200">{str(payload.product_spoken)} <span className="text-slate-300">· {num(payload.delivered_dose_mg)} mg</span></div>
      {ingredients.length > 1 && <p className="mt-2 text-[18px] text-amber-200">Contains {ingredients.join(", ")}. Every ingredient is counted toward its daily limit.</p>}
      <p className="mt-4 text-[20px] text-slate-200">Next dose after <b className="text-white">{str(payload.next_eligible_label) ?? "—"}</b></p>
      {str(payload.warning) && <p className="mt-2 text-[16px] text-amber-300">{str(payload.warning)}</p>}
      <Sources payload={payload} />
    </Shell>
  );
}

// ------------------------------------------------------------------------------------------------- blocking cards

function DoubleDose({ payload, ctx }: { payload: Payload; ctx: CardContext }) {
  const now = useNow(0);
  const last = obj(payload.last_dose);
  const end = str(payload.next_eligible_time) ? Date.parse(str(payload.next_eligible_time)!) : undefined;
  const left = end === undefined ? undefined : end - now;
  const ceiling = num(payload.ceiling_mg_24h);
  const daily = str(payload.violation_type) === "DAILY_MAX";
  return (
    <section role="alert" aria-label="Administration locked" className="glass glass-danger flex h-full flex-col justify-center rounded-[29px] border-2 border-red-500/70 p-7">
      <h3 className="flex items-center gap-3 text-[28px] font-extrabold uppercase tracking-widest text-red-200"><span aria-hidden>⛔</span> {daily ? "Daily limit reached" : "Administration locked"}</h3>
      <div className="mt-4 font-bold leading-none tabular-nums text-white" style={{ fontSize: 108 }} aria-live="off">
        {left === undefined ? (num(payload.remaining_minutes) ?? "—") : formatRemaining(left)}
      </div>
      <p className="mt-1.5 text-[20px] text-red-100">until the next dose is allowed{str(payload.next_eligible_label) ? ` (${str(payload.next_eligible_label)})` : ""}</p>
      {str(last.caregiver) && (
        <p className="mt-5.5 text-[24px] leading-snug text-white">
          <b>{str(last.caregiver)}</b> gave <b>{str(last.medication)}</b>
          {num(last.volume_ml) !== undefined && <> ({num(last.volume_ml)} mL)</>} at <b>{str(last.time_label)}</b>, {num(last.minutes_ago)} minutes ago.
        </p>
      )}
      {ceiling !== undefined && <p className="mt-5.5 text-[24px] text-white">{num(payload.mg_last_24h)} mg of acetaminophen in 24 hours. The limit is <b>{ceiling} mg</b>, counting every product.</p>}
      <p className="mt-4 text-[20px] font-semibold text-red-100">This cannot be overridden by anyone.</p>
      <div className="mt-5.5 flex gap-3">
        <ActionButton tone="danger" onClick={ctx.onHelp}>Call the nurse line</ActionButton>
      </div>
      <Sources payload={payload} />
    </section>
  );
}

function Shield({ payload }: { payload: Payload }) {
  const status = str(payload.status);
  const clinician = status === "NEEDS_CLINICIAN";
  const alt = str(payload.approved_alternative);
  const altDetail = obj(payload.alternative_detail);
  const rx = str(payload.conflicting_rx);
  const hasConflict = rx && rx !== "n/a";
  return (
    <Shell tone={clinician ? "warn" : "danger"} label={clinician ? "Ask a clinician" : "Not safe to give"} alert>
      <div className="grid grid-cols-2 gap-5.5">
        <div className="rounded-3xl border border-white/15 bg-black/25 p-3.5">
          <div className="text-[16px] uppercase tracking-wider text-slate-400">You asked for</div>
          <div className="mt-1 text-[28px] font-bold text-white">{str(payload.requested) ?? "this medicine"}</div>
        </div>
        <div className="rounded-3xl border border-alert/40 bg-black/25 p-4">
          <div className="text-[16px] uppercase tracking-wider text-slate-400">{hasConflict ? "Conflicts with" : "Because"}</div>
          <div className="mt-1 text-[28px] font-bold capitalize text-red-200">{hasConflict ? rx : "label guidance"}</div>
        </div>
      </div>
      <p className="mt-3.5 text-[22px] leading-snug text-white">{str(payload.clinical_rationale)}</p>
      {alt && (
        <div className="mt-3.5 rounded-3xl border border-mint/40 bg-mint/10 p-3.5">
          <div className="text-[16px] font-semibold uppercase tracking-wider text-emerald-300">✔ A safer option to ask about</div>
          <div className="mt-1 text-[26px] font-bold capitalize text-white">{alt}</div>
          {str(altDetail.product) && (
            <p className="mt-1.5 text-[20px] text-emerald-100">
              {str(altDetail.product)}: no more than {num(altDetail.max_units_24h)} {str(altDetail.unit_label)} in 24 hours ({num(altDetail.ceiling_mg_24h)} mg).
            </p>
          )}
          <p className="mt-1.5 text-[18px] text-slate-200">Check with {str(payload.patient_name) ? `${str(payload.patient_name)}'s` : "their"} clinician first.</p>
        </div>
      )}
      {!alt && <p className="mt-4 text-[20px] text-slate-200">{str(payload.followup)}</p>}
      <Sources payload={payload} />
    </Shell>
  );
}

function MemoryConflict({ payload, ctx }: { payload: Payload; ctx: CardContext }) {
  const old = obj(payload.old_advice);
  const conflict = obj(payload.conflict);
  const who = str(payload.call_target) ?? "the doctor";
  return (
    <Shell tone="danger" label="Old advice, no longer safe" alert>
      <div className="grid grid-cols-2 gap-5.5">
        <div className="rounded-3xl border border-white/15 bg-black/25 p-4">
          <div className="text-[16px] uppercase tracking-wider text-slate-400">Old advice · {str(old.given_on)} · {str(old.given_by)}</div>
          <div className="mt-1.5 text-[32px] font-bold capitalize text-slate-300 line-through decoration-red-400 decoration-4">{str(old.drug)}</div>
        </div>
        <div className="rounded-3xl border border-alert/50 bg-alert/10 p-4">
          <div className="text-[16px] uppercase tracking-wider text-slate-400">Now blocked because</div>
          <div className="mt-1.5 text-[32px] font-bold text-red-200">{str(payload.patient_name)} takes <span className="capitalize">{str(conflict.because)}</span></div>
        </div>
      </div>
      <p className="mt-5.5 text-[22px] leading-snug text-white">{str(conflict.rationale)}</p>
      <div className="mt-5.5 flex flex-wrap items-center gap-4">
        <ActionButton tone="danger" onClick={ctx.onHelp}>📞 Call {who}</ActionButton>
        <span className="text-[16px] text-slate-400">No phone number on file for {who}.</span>
      </div>
      <Sources payload={payload} />
    </Shell>
  );
}

// ----------------------------------------------------------------------------------------------- question cards

function ConfirmDose({ payload, ctx }: { payload: Payload; ctx: CardContext }) {
  return (
    <Shell tone="warn" label="Is this correct?">
      <p className="text-[32px] leading-tight text-white">
        Log <b className="text-emerald-300">{str(payload.dose_display)}</b> of <b>{str(payload.product_spoken)}</b> for <b>{str(payload.patient_name)}</b>, given by <b>{str(payload.given_by)}</b> <b>{str(payload.given_label)}</b>?
      </p>
      <p className="mt-4 text-[18px] text-slate-300">Nothing is saved until you say yes. This starts the safety timer for everyone in the house.</p>
      <div className="mt-7 flex gap-4">
        <ActionButton onClick={() => ctx.onSend("Yes, that's correct")} disabled={ctx.disabled}>✔ Yes, log it</ActionButton>
        <ActionButton tone="quiet" onClick={() => ctx.onSend("No, that's wrong")} disabled={ctx.disabled}>✖ No</ActionButton>
      </div>
      <Sources payload={payload} />
    </Shell>
  );
}

/** Answers for the questions the safety engine asks, as one-tap buttons. Anything else is spoken or typed. */
function answersFor(payload: Payload): string[] {
  const options = strs(payload.options);
  switch (str(payload.missing)) {
    case "elsewhere": return ["No, nothing else today", "Yes, I already gave some"];
    case "weight_unit": return options.length ? options.map((o) => o) : ["pounds", "kilograms"];
    default: return options;
  }
}

function NeedsInfo({ payload, ctx }: { payload: Payload; ctx: CardContext }) {
  const answers = answersFor(payload);
  return (
    <Shell tone="info" label="One quick question">
      <p className="text-[36px] font-semibold leading-tight text-white">{str(payload.question) ?? str(payload.speech)}</p>
      {answers.length > 0 && (
        <div className="mt-7 flex flex-wrap gap-3.5">
          {answers.map((a) => <ActionButton key={a} tone="quiet" onClick={() => ctx.onSend(a)} disabled={ctx.disabled}>{a}</ActionButton>)}
        </div>
      )}
      <p className="mt-5.5 text-[16px] text-slate-400">Say or type your answer. I won't guess.</p>
    </Shell>
  );
}

// ----------------------------------------------------------------------------------------------------- P2 cards

function Pantry({ payload }: { payload: Payload }) {
  return (
    <Shell tone="ok" label={str(payload.remedy_title) ?? "Pantry remedy"}>
      <ol className="list-decimal space-y-2 pl-7 text-[24px] text-slate-100">
        {strs(payload.preparation_steps).map((s) => <li key={s}>{s}</li>)}
      </ol>
      <div className="mt-5.5 flex flex-wrap gap-2">
        {strs(payload.safety_badges).map((b) => <Chip key={b} tone="green">✓ {b}</Chip>)}
      </div>
    </Shell>
  );
}

function Restock({ payload, ctx }: { payload: Payload; ctx: CardContext }) {
  const items = recs(payload.items);
  const total = num(payload.total_usd);
  return (
    <Shell tone="ok" label="Restock: review your cart">
      <div className="-mx-1 flex snap-x snap-mandatory gap-4 overflow-x-auto px-1 pb-3" role="list">
        {items.map((it) => (
          <div key={str(it.name)} role="listitem" className="w-[245px] shrink-0 snap-start rounded-3xl border border-glow/30 bg-black/30 p-4">
            <div className="text-[16px] uppercase tracking-wide text-cyan-300">{str(it.channel)}</div>
            <div className="mt-1.5 text-[22px] font-semibold text-white">{str(it.name)}</div>
            <div className="text-[16px] text-slate-400">{str(it.merchant)}</div>
            {num(it.price_usd) !== undefined && <div className="mt-3 text-[28px] font-bold text-white">${num(it.price_usd)!.toFixed(2)}</div>}
          </div>
        ))}
      </div>
      <p className="text-[16px] text-amber-300">Simulated checkout. No real order is placed.</p>
      <div className="mt-3 flex items-center justify-between gap-4">
        <div className="text-[22px] text-slate-200">
          {total !== undefined && <b className="text-[32px] text-white">${total.toFixed(2)}</b>}
          {str(payload.eta) && <span className="ml-3">Arrives {str(payload.eta)}</span>}
        </div>
        <ActionButton disabled={ctx.disabled} onClick={() => ctx.onSend("Confirm the order")}>{str(payload.confirm_label) ?? "Confirm order"}</ActionButton>
      </div>
      {strs(payload.already_on_order).length > 0 && <p className="mt-3 text-[16px] text-amber-300">⚠ {strs(payload.already_on_order).map((n) => n.split(" (")[0]).join(", ")} is already on its way.</p>}
      {ctx.onOpenShop && <button onClick={ctx.onOpenShop} className="ghost mt-3 min-h-[46px] rounded-full border border-white/25 px-5 text-[16px] font-semibold text-[#dbe6f2]">🛒 View cart and orders</button>}
    </Shell>
  );
}

export function CardView({ type, payload, ctx }: { type: CardType; payload: Payload; ctx: CardContext }) {
  switch (type) {
    case "SYRINGE_CALIBRATOR": return <Syringe payload={payload} />;
    case "TABLET_DOSE": return <Tablet payload={payload} />;
    case "DOUBLE_DOSE_INTERCEPT": return <DoubleDose payload={payload} ctx={ctx} />;
    case "CONTRAINDICATION_SHIELD": return <Shield payload={payload} />;
    case "MEMORY_CONFLICT": return <MemoryConflict payload={payload} ctx={ctx} />;
    case "CONFIRM_DOSE": return <ConfirmDose payload={payload} ctx={ctx} />;
    case "NEEDS_INFO": return <NeedsInfo payload={payload} ctx={ctx} />;
    case "PANTRY_REMEDY": return <Pantry payload={payload} />;
    case "AMAZON_RESTOCK_CAROUSEL": return <Restock payload={payload} ctx={ctx} />;
    case "EMERGENCY_LOCATOR": return <EmergencyLocator payload={payload} />;
    case "RED_FLAG_CHECKLIST": return <RedFlagChecklist payload={payload} ctx={ctx} />;
    case "NURSE_LINE_BRIEF": return <NurseLineBrief payload={payload} />;
    case "RX_CONFIRMATION": return <RxConfirmation payload={payload} ctx={ctx} />;
    case "LABEL_LENS": return <LabelLens payload={payload} ctx={ctx} />;
  }
}

