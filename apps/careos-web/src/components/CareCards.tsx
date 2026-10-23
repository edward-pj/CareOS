import { useState } from "react";
import { api } from "../api/client";
import { previewFor } from "../lib/photos";
import { signsMessage } from "../lib/signs";
import { ActionButton, Chip, Shell, Sources, num, obj, recs, str, strs, type CardContext, type Payload } from "./Cards";

// P1 cards (PRD §10): Emergency Locator, Red-Flag Checklist, Nurse-Line Brief, Rx Confirmation, Label Lens.
// Like every card, each number and sentence is copied from the tool payload. The one thing computed here is layout.

// ----------------------------------------------------------------------------------------------- emergency

export function EmergencyLocator({ payload }: { payload: Payload }) {
  const e = obj(payload.emergency);
  const urgent = str(payload.urgency) ?? str(payload.status);
  const emergency = urgent === "CALL_EMERGENCY";
  const number = str(e.number) ?? "911";
  const hospitals = recs(e.hospitals);
  const src = obj(e.hospitals_source);
  const sbar = obj(e.sbar);
  const poison = obj(e.poison);
  const rules = recs(payload.rules);
  const [showSbar, setShowSbar] = useState(false);
  return (
    <section role="alert" aria-label={emergency ? "Emergency" : "Get seen now"} className="glass glass-danger flex h-full flex-col overflow-y-auto rounded-[29px] border-2 border-red-500/70 p-6.5">
      <h3 className="flex items-center gap-3 text-[24px] font-extrabold uppercase tracking-widest text-red-100">
        <span aria-hidden>🚨</span> {emergency ? "This could be an emergency" : "Needs to be seen right away"}
      </h3>
      <div className="mt-3 grid grid-cols-[1fr_1fr] gap-4">
        <div>
          <a href={str(e.tel) ?? `tel:${number}`} className="flex min-h-[75px] items-center justify-center rounded-full bg-[#ff5a5a] px-4 text-center text-[32px] font-semibold leading-tight text-[#2a0408] no-underline hover:bg-[#ff7272]">
            📞 {emergency ? `Call ${number}` : `If no answer, call ${number}`}
          </a>
          <p className="mt-2 text-[16px] text-red-50">{str(e.disclosure)}</p>
          {str(e.ambulance_number) && <p className="text-[16px] text-red-50">Ambulance: {str(e.ambulance_number)}</p>}
          <p className="mt-1 text-[16px] text-red-50">
            {str(poison.label)}{str(poison.number) ? `: ` : ""}
            {str(poison.tel) && <a className="font-bold underline" href={str(poison.tel)}>{str(poison.number)}</a>}
            {str(poison.note) ? ` ${str(poison.note)}` : ""}
          </p>
          {e.caregivers_notified === true && <p className="mt-1.5 text-[16px] font-semibold text-emerald-200">✔ The other caregivers were alerted.</p>}
        </div>
        <div>
          <div className="text-[16px] font-semibold uppercase tracking-wider text-red-100">Nearby hospitals <span className="ml-1.5 text-[13px] font-normal normal-case tracking-normal">{str(hospitals[0]?.hoursNote)}</span></div>
          <ul className="mt-1.5 space-y-1.5">
            {hospitals.map((h) => (
              <li key={str(h.name)} className="rounded-3xl border border-red-300/30 bg-black/25 px-3 py-1.5">
                <div className="text-[16px] font-bold leading-tight text-white">{str(h.name)}</div>
                <div className="text-[14px] text-slate-200">{num(h.distance)} {str(h.distanceUnit)} · about {num(h.driveMinutes)} min drive (estimate)</div>
              </li>
            ))}
          </ul>
          {src.live === false && <p className="mt-1.5 text-[14px] text-amber-200">⚠ {str(src.note)}</p>}
          <button disabled title="Needs a live place-search service and a way to text you. Not connected in this demo." className="mt-2 min-h-[44px] rounded-full border border-white/20 px-4 text-[14px] text-muted">Send directions to phone (not connected)</button>
        </div>
      </div>

      {rules.length > 0 && (
        <div className="mt-3 rounded-3xl border border-red-300/30 bg-black/25 p-3">
          <div className="text-[16px] font-semibold uppercase tracking-wider text-red-100">Why</div>
          {rules.slice(0, 2).map((r) => (
            <p key={str(r.id)} className="text-[18px] leading-snug text-white">
              {str(r.trigger)}
              <a className="ml-2 text-[14px] text-sky-200 underline" href={str(obj(r.source).url)} target="_blank" rel="noreferrer">{str(obj(r.source).name)}</a>
            </p>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button onClick={() => setShowSbar((s) => !s)} aria-expanded={showSbar} className="ghost min-h-[46px] rounded-full border border-white/40 px-5 text-[16px] font-semibold text-white">{showSbar ? "Hide" : "Show"} what to tell the call-taker</button>
        <span className="text-[16px] text-red-50">{strs(e.first_aid)[0]}</span>
      </div>
      {showSbar && (
        <pre className="mt-2 whitespace-pre-wrap rounded-3xl bg-black/35 p-3.5 font-sans text-[18px] leading-snug text-white">{str(sbar.script) ?? "Say who needs help, where you are, and what happened."}</pre>
      )}
    </section>
  );
}

// ----------------------------------------------------------------------------------------------- checklist

export function RedFlagChecklist({ payload, ctx }: { payload: Payload; ctx: CardContext }) {
  const items = recs(payload.checklist);
  const [on, setOn] = useState<Set<string>>(new Set());
  const watching = str(payload.status) === "HOME_CARE_OK_WITH_WATCH";
  const name = str(payload.patient_name) ?? ctx.patientName;
  const toggle = (s: string) => setOn((prev) => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n; });
  return (
    <Shell tone={watching ? "ok" : "info"} label={watching ? "Keep watching for these" : "Warning-sign check"}>
      <p className="text-[24px] leading-snug text-white">{str(payload.question) ?? str(payload.speech)}</p>
      {str(payload.followup) && <p className="mt-1.5 text-[16px] text-slate-300">{str(payload.followup)}</p>}
      <ul className="mt-3.5 grid grid-cols-2 gap-2" aria-label="Warning signs">
        {items.map((it) => {
          const sign = str(it.sign)!;
          const picked = on.has(sign);
          return (
            <li key={sign}>
              <button onClick={() => toggle(sign)} aria-pressed={picked} className={`min-h-[52px] w-full rounded-3xl border-2 px-3.5 text-left text-[16px] leading-snug ${picked ? "border-red-400 bg-red-500/25 font-bold text-white" : "border-white/20 bg-black/25 text-slate-100 hover:border-white/50"}`}>
                {picked ? "⚠ " : ""}{str(it.question)}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-4 flex flex-wrap gap-3.5">
        <ActionButton disabled={ctx.disabled || on.size === 0} onClick={() => ctx.onSend(signsMessage(name, [...on]))}>Send {on.size || ""} selected</ActionButton>
        <ActionButton tone="quiet" disabled={ctx.disabled} onClick={() => ctx.onSend(`None of those for ${name}`)}>None of these</ActionButton>
      </div>
      <p className="mt-3 text-[16px] text-slate-400">I can't diagnose. This only checks for the warning signs published by the AAP, NHS and CDC.</p>
      <Sources payload={payload} />
    </Shell>
  );
}

// ----------------------------------------------------------------------------------------------- nurse line

export function NurseLineBrief({ payload }: { payload: Payload }) {
  const sbar = obj(payload.sbar);
  const pdf = obj(payload.pdf);
  const rules = recs(payload.rules);
  const urgent = str(payload.status) === "CALL_DOCTOR_TODAY";
  const parts: [string, string | undefined][] = [["Situation", str(sbar.situation)], ["Background", str(sbar.background)], ["Assessment", str(sbar.assessment)], ["Request", str(sbar.recommendation)]];
  return (
    <Shell tone={urgent ? "warn" : "info"} label={urgent ? "Call your doctor or nurse line" : "Nurse-line brief"}>
      {urgent && rules[0] && <p className="mb-2 text-[20px] font-semibold text-amber-100">{str(rules[0].trigger)}</p>}
      <div className="space-y-2">
        {parts.map(([h, t]) => (
          <div key={h} className="rounded-3xl bg-black/25 p-3">
            <div className="text-[14px] font-bold uppercase tracking-widest text-cyan-300">{h}</div>
            <p className="text-[18px] leading-snug text-white">{t}</p>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {str(pdf.download_path) && (
          <a href={str(pdf.download_path)} target="_blank" rel="noreferrer" className="flex min-h-[46px] items-center rounded-full bg-accent px-5 text-[16px] font-semibold text-[#04201a] no-underline hover:brightness-110">📄 Open the PDF for the doctor ({num(payload.hours)} h)</a>
        )}
        <span className="text-[16px] text-slate-300">You place the call. CareOS only reads out what is already in the chart.</span>
      </div>
      <Sources payload={payload} />
    </Shell>
  );
}

// ----------------------------------------------------------------------------------------------- prescriptions

const FIELDS = ["drug", "strength", "frequency", "prescriber"] as const;
type Field = (typeof FIELDS)[number];
const FIELD_LABEL: Record<Field, string> = { drug: "Medicine", strength: "Strength", frequency: "How often", prescriber: "Prescriber" };

interface RowState { values: Record<Field, string>; state: "pending" | "saving" | "saved" | "discarded"; note?: string; unchecked?: boolean }

export function RxConfirmation({ payload, ctx }: { payload: Payload; ctx: CardContext }) {
  const rows = recs(payload.prescriptions);
  const photo = previewFor(str(payload.upload_id));
  const [state, setState] = useState<Record<string, RowState>>(() =>
    Object.fromEntries(rows.map((r) => [str(r.id)!, { values: { drug: str(r.drug) ?? "", strength: str(r.strength) ?? "", frequency: str(r.frequency) ?? "", prescriber: str(r.prescriber) ?? "" }, state: "pending" as const }])),
  );
  const patch = (id: string, p: Partial<RowState>) => setState((s) => ({ ...s, [id]: { ...s[id]!, ...p } }));
  const setValue = (id: string, f: Field, v: string) => setState((s) => ({ ...s, [id]: { ...s[id]!, values: { ...s[id]!.values, [f]: v } } }));

  const confirm = async (id: string) => {
    patch(id, { state: "saving", note: undefined });
    try {
      const r = await api.confirmRx(id, state[id]!.values);
      if (r.status === "CONFIRMED") patch(id, { state: "saved", unchecked: r.unchecked === true, note: str(r.speech) });
      else patch(id, { state: "pending", note: str(r.speech) ?? "That couldn't be saved." });
    } catch (e) { patch(id, { state: "pending", note: e instanceof Error ? e.message : "That couldn't be saved." }); }
  };
  const discard = async (id: string) => {
    patch(id, { state: "saving" });
    try { await api.rejectRx(id); patch(id, { state: "discarded" }); } catch { patch(id, { state: "pending", note: "That couldn't be discarded." }); }
  };

  return (
    <Shell tone="warn" label="Check each medicine">
      <p className="rounded-3xl border-2 border-amber-400/60 bg-amber-400/10 p-2 text-[16px] font-semibold text-amber-100">Nothing is on {str(payload.patient_name)}'s chart until you confirm it here. A pending medicine is never used in a safety check.</p>
      {payload.name_mismatch === true && <p role="alert" className="mt-1.5 text-[16px] font-semibold text-red-200">⚠ The name on the paper ({str(payload.name_on_label)}) doesn't look like {str(payload.patient_name)}.</p>}
      <div className="mt-3 grid grid-cols-[240px_1fr] gap-3.5">
        <div className="rounded-3xl border border-white/15 bg-black/25 p-1.5">
          {photo ? <img src={photo} alt="The photo that was read" className="max-h-[302px] w-full rounded-xl object-contain" /> : <div className="flex h-[144px] items-center justify-center text-center text-[16px] text-slate-400">The photo is only kept on this screen while you check.</div>}
        </div>
        <div className="space-y-3">
          {rows.map((r) => {
            const id = str(r.id)!;
            const st = state[id]!;
            const flags = strs(r.flags);
            const conf = obj(r.confidence);
            return (
              <article key={id} className={`rounded-3xl border-2 p-3 ${st.state === "saved" ? "border-emerald-400/60 bg-emerald-400/10" : st.state === "discarded" ? "border-slate-700 opacity-50" : "border-slate-600 bg-black/25"}`} aria-label={`Medicine ${st.values.drug || "unreadable"}`}>
                <div className="grid grid-cols-2 gap-2">
                  {FIELDS.map((f) => {
                    const low = num(conf[f]) !== undefined && num(conf[f])! < 0.8;
                    return (
                      <label key={f} className="block text-[13px] uppercase tracking-wider text-slate-400">
                        {FIELD_LABEL[f]}{low && <span className="ml-1.5 font-bold text-amber-300">check this</span>}
                        <input value={st.values[f]} disabled={st.state !== "pending"} onChange={(e) => setValue(id, f, e.target.value)} className={`mt-1 min-h-[44px] w-full rounded-3xl border bg-black/30 px-3 text-[16px] normal-case tracking-normal text-white outline-none focus:border-glow ${low || (f === "drug" && !st.values.drug) ? "border-warn" : "border-white/20"}`} />
                      </label>
                    );
                  })}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {flags.map((f) => <Chip key={f} tone={f === "ALREADY_ON_CHART" ? "slate" : "amber"}>{f.replace(/_/g, " ").toLowerCase()}</Chip>)}
                </div>
                {st.state === "pending" || st.state === "saving" ? (
                  <div className="mt-2 flex gap-2">
                    <ActionButton disabled={st.state === "saving" || !st.values.drug.trim()} onClick={() => void confirm(id)}>✔ Confirm</ActionButton>
                    <ActionButton tone="quiet" disabled={st.state === "saving"} onClick={() => void discard(id)}>Discard</ActionButton>
                  </div>
                ) : (
                  <p className={`mt-2 text-[16px] font-semibold ${st.state === "saved" ? "text-emerald-200" : "text-slate-400"}`}>{st.state === "saved" ? "✔ Saved to the chart" : "Discarded. Nothing was saved."}</p>
                )}
                {st.note && <p role="status" className={`mt-1.5 text-[16px] ${st.unchecked ? "text-amber-200" : "text-slate-200"}`}>{st.note}</p>}
              </article>
            );
          })}
        </div>
      </div>
      <Sources payload={payload} />
    </Shell>
  );
}

// ----------------------------------------------------------------------------------------------- label lens

export function LabelLens({ payload, ctx }: { payload: Payload; ctx: CardContext }) {
  const claims = obj(payload.claims);
  const shelf = obj(payload.shelf);
  const photo = previewFor(str(payload.upload_id));
  const expired = payload.expired === true;
  const differs = payload.differs_from_shelf === true;
  const name = str(payload.patient_name) ?? ctx.patientName;
  const ask = () => {
    const bits = [str(claims.strength) ? `The bottle says ${str(claims.strength)}` : undefined, str(claims.expiry) ? `expires ${str(claims.expiry)}` : undefined].filter(Boolean).join(", ");
    ctx.onSend(`How much ${str(claims.product) ?? str(claims.ingredient) ?? "Motrin"} for ${name}? ${bits}. He hasn't had any other.`);
  };
  return (
    <Shell tone={expired ? "danger" : "warn"} label={expired ? "This bottle is expired" : "Is this the bottle?"} alert={expired}>
      <div className="grid grid-cols-[240px_1fr] gap-4">
        <div className="rounded-3xl border border-white/15 bg-black/25 p-1.5">
          {photo ? <img src={photo} alt="The label photo" className="max-h-[274px] w-full rounded-xl object-contain" /> : <div className="flex h-[130px] items-center justify-center text-center text-[16px] text-slate-400">Photo shown here while you check.</div>}
        </div>
        <div>
          <div className="text-[14px] uppercase tracking-widest text-slate-400">The bottle says</div>
          <div className="mt-1 text-[32px] font-bold leading-tight text-white">{str(claims.product) ?? str(claims.ingredient) ?? "(name not readable)"}</div>
          <div className="mt-1.5 text-[28px] font-bold text-emerald-300">{str(claims.strength) ?? "strength not readable"}</div>
          <div className={`mt-1.5 text-[22px] font-semibold ${expired ? "text-red-200" : "text-slate-100"}`}>{str(claims.expiry_label) ? `${expired ? "Expired" : "Expires"} ${str(claims.expiry_label)}` : "No expiry date read"}</div>
          {str(shelf.name) && (
            <p className={`mt-3 rounded-3xl border-2 p-2 text-[16px] ${differs ? "border-amber-400/70 bg-amber-400/10 text-amber-100" : "border-slate-600 text-slate-200"}`}>
              {differs ? "⚠ Different from" : "Same strength as"} the bottle on the chart: {str(shelf.name)}, {str(shelf.strength)}.
            </p>
          )}
          {str(payload.followup) && <p className="mt-2 text-[16px] text-slate-300">{str(payload.followup)}</p>}
        </div>
      </div>
      {!expired && (
        <div className="mt-4 flex gap-3.5">
          <ActionButton disabled={ctx.disabled} onClick={ask}>✔ Yes, plan a dose for this bottle</ActionButton>
          <ActionButton tone="quiet" disabled={ctx.disabled} onClick={() => ctx.onSend("No, that's not the right bottle")}>✖ No</ActionButton>
        </div>
      )}
      <Sources payload={payload} />
    </Shell>
  );
}
