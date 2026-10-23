import { useState } from "react";
import type { Health, InspectResponse, StateResponse, TraceFrame } from "../api/types";
import type { Conversation } from "../hooks/useConversation";
import { useHealth, useInspect } from "../hooks/useInspect";
import { toCurl } from "../lib/curl";
import { buildHandoff } from "../lib/handoff";
import { formatClock } from "../lib/time";
import type { Household } from "../hooks/useHousehold";

type Tab = "mcp" | "data" | "guard" | "steps" | "house";

const BACKEND_LABEL: Record<string, string> = { memory: "In-memory (demo only, lost on restart)", supabase: "Supabase (Postgres)", dynamo: "Amazon DynamoDB" };
const mono = "font-mono text-[13px]";

function Banner({ health }: { health?: Health }) {
  const m = health?.mcp;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-2xl border border-mint/40 bg-mint/10 px-3.5 py-1.5 text-[14px] text-mint" data-testid="mcp-banner">
      <b>{m ? `${m.transport === "streamable-http" ? "Streamable HTTP" : m.transport} · spec ${m.spec} · ${m.stateless ? "stateless" : "stateful"}` : "Streamable HTTP · spec 2025-11-25 · stateless"}</b>
      {health && <span className="text-slate-300">{health.name} {health.version} · POST {m?.endpoint} · auth: {health.auth}</span>}
    </div>
  );
}

function McpInspector({ frames }: { frames: TraceFrame[] }) {
  const health = useHealth();
  const [open, setOpen] = useState<number>();
  const [copied, setCopied] = useState<number>();
  async function copy(f: TraceFrame) {
    const curl = toCurl(f, window.location.origin);
    if (!curl) return;
    try { await navigator.clipboard.writeText(curl); setCopied(f.id); setTimeout(() => setCopied(undefined), 1500); } catch { /* clipboard blocked: the JSON is still visible */ }
  }
  return (
    <div>
      <Banner health={health} />
      {frames.length === 0 ? <p className="text-[16px] text-slate-400">No MCP traffic yet. Ask a question and the JSON-RPC calls appear here, exactly as Alexa+ would send them.</p> : (
        <ul className={`space-y-1 ${mono}`}>
          {[...frames].reverse().map((f) => (
            <li key={f.id}>
              <div className="flex items-center gap-2">
                <button onClick={() => setOpen(open === f.id ? undefined : f.id)} aria-expanded={open === f.id} className="flex min-w-0 flex-1 gap-2 text-left">
                  <span className={f.dir === "in" ? "text-cyan-300" : "text-emerald-300"}>{f.dir === "in" ? "→" : "←"}</span>
                  <span className={`truncate ${f.kind === "blocked" || f.kind === "error" ? "text-red-300" : "text-slate-200"}`}>{f.summary}</span>
                </button>
                {f.dir === "in" && <button onClick={() => void copy(f)} className="ghost shrink-0 rounded-full border border-white/20 px-3 py-1 text-[12px] text-slate-200">{copied === f.id ? "Copied ✔" : "Copy as curl"}</button>}
              </div>
              {open === f.id && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-2xl bg-black/40 p-2 text-slate-400">{JSON.stringify(f.message, null, 2)}</pre>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-3">
      <h4 className="mb-1 text-[13px] font-medium text-muted">{title}</h4>
      {children}
    </section>
  );
}

function DataInspector({ data, error, state }: { data?: InspectResponse; error?: string; state?: StateResponse }) {
  if (error) return <p role="alert" className="text-[16px] text-amber-300">{error}</p>;
  if (!data) return <p className="text-[16px] text-slate-400">Loading stored data…</p>;
  const locks = (state?.patients ?? []).flatMap((p) => p.active_locks.map((l) => ({ patient: p.profile.name, ...l })));
  return (
    <div className={mono}>
      <div className="mb-2 rounded-2xl border border-glow/40 bg-glow/10 px-3.5 py-1.5 text-[14px] text-cyan-100" data-testid="backend-banner">
        Read-only view of what is really stored · household <b>{data.household_id}</b> · backend: <b>{BACKEND_LABEL[data.backend] ?? data.backend}</b>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Section title={`Dose ledger (${data.ledger.length})`}>
            {data.ledger.length === 0 ? <p className="text-slate-500">empty</p> : data.ledger.slice(0, 8).map((e) => <div key={e.eventId}>{formatClock(e.at)} {e.patientId} {e.medication} {e.volumeMl ?? ""}{e.volumeMl !== undefined ? " mL" : ""} {e.amountMg ?? ""}{e.amountMg !== undefined ? " mg" : ""} · {e.caregiver}</div>)}
          </Section>
          <Section title={`Locks (${locks.length})`}>
            {locks.length === 0 ? <p className="text-slate-500">none</p> : locks.map((l) => <div key={`${l.patient}${l.ingredient}`}>{l.patient} {l.ingredient} until {formatClock(Date.parse(l.next_eligible_time))} ({l.status})</div>)}
          </Section>
          <Section title={`Episodes (${data.episodes?.length ?? 0})`}>
            {!data.episodes?.length ? <p className="text-slate-500">none</p> : data.episodes.slice(0, 4).map((e) => <div key={e.id}>{e.patientId} <b className={e.urgency === "CALL_EMERGENCY" || e.urgency === "GO_TO_ER_NOW" ? "text-red-300" : "text-amber-300"}>{e.urgency}</b> · {e.status} · {e.timeline.at(-1)?.text.slice(0, 70)}</div>)}
          </Section>
          <Section title={`Prescriptions (${data.prescriptions?.length ?? 0})`}>
            {!data.prescriptions?.length ? <p className="text-slate-500">none</p> : data.prescriptions.slice(0, 6).map((r) => <div key={r.id}>{r.patientId}: {r.drug || "(unreadable)"} {r.strength ?? ""} · <b className={r.status === "PENDING" ? "text-amber-300" : "text-emerald-300"}>{r.status}</b></div>)}
          </Section>
          <Section title="Remembered advice">
            {data.advice.length === 0 ? <p className="text-slate-500">none</p> : data.advice.map((a) => <div key={a.id}>{a.patientId}: {a.drug} ({a.topic}) · {a.givenBy}</div>)}
          </Section>
        </div>
        <div>
          <Section title={`Audit trail, append-only (${data.audit.length})`}>
            {data.audit.length === 0 ? <p className="text-slate-500">empty</p> : data.audit.slice(0, 10).map((a) => (
              <div key={a.id}>{formatClock(a.at)} <span className="text-amber-300">{a.tool}</span> {a.patientId ?? ""} → <b className={/^(APPROVED|LOGGED|OK)/.test(a.verdict) ? "text-emerald-300" : "text-red-300"}>{a.verdict}</b> <span className="text-slate-500">{a.reasonCodes.slice(0, 2).join(",")} #{a.inputHash}</span></div>
            ))}
          </Section>
          <Section title={`Observations (${data.observations.length})`}>
            {data.observations.slice(0, 5).map((o) => <div key={o.id}>{formatClock(o.at)} {o.patientId} {o.type} {o.value} {o.unit} · {o.source}</div>)}
          </Section>
        </div>
      </div>
    </div>
  );
}

function GuardLog({ convo }: { convo: Conversation }) {
  if (convo.guardLog.length === 0) {
    return <p className="text-[16px] text-slate-400" data-testid="guard-empty">No interventions yet. If the assistant ever drafts a number the safety engine did not give, the draft and its replacement are logged here as <code>numeric_guard.blocked</code>.</p>;
  }
  return (
    <ul className="space-y-2">
      {convo.guardLog.map((g) => (
        <li key={g.id} className="rounded-2xl border border-alert/40 bg-alert/10 p-3 text-[14px]" data-testid="guard-entry">
          <div className="text-red-300"><b>numeric_guard.blocked</b> · {formatClock(g.at)} · {g.offending.map((o) => <code key={o} className="mx-1 rounded bg-black/40 px-1.5 py-0.5">{o}</code>)}</div>
          <div className="mt-1 text-slate-400">Model draft: <s>{g.draft}</s></div>
          <div className="mt-1 text-emerald-200">Spoken instead: {g.replacement}</div>
        </li>
      ))}
    </ul>
  );
}

function AgentSteps({ convo }: { convo: Conversation }) {
  if (convo.steps.length === 0) return <p className="text-[16px] text-slate-400">The tools the assistant calls appear here for the current question.</p>;
  return (
    <ul className={`space-y-1.5 ${mono}`}>
      {convo.steps.map((s) => (
        <li key={s.id} className="rounded-2xl border border-white/12 bg-white/5 p-3">
          <div className="flex items-center gap-2"><span className={s.state === "blocked" || s.state === "error" ? "text-red-300" : s.state === "running" ? "text-amber-300" : "text-emerald-300"}>⚡ {s.name}</span><span className="text-slate-400">{s.state === "running" ? "running…" : s.status ?? s.state}</span></div>
          <pre className="mt-1 whitespace-pre-wrap break-all text-slate-400">{JSON.stringify(s.input)}</pre>
        </li>
      ))}
    </ul>
  );
}

function Household({ h, patientId, caregiver }: { h: Household; patientId: string; caregiver: string }) {
  const snap = h.data?.patients.find((p) => p.profile.id === patientId) ?? h.data?.patients[0];
  const handoff = snap && h.data ? buildHandoff(snap, h.data.inventory, caregiver) : undefined;
  return (
    <div className="grid grid-cols-2 gap-4 text-[16px]">
      <Section title="Caregiver handoff summary">
        {handoff ? <><div className="mb-1 font-semibold">{handoff.headline}</div><ul className="list-disc space-y-1 pl-4 text-slate-200">{handoff.lines.map((l) => <li key={l}>{l}</li>)}</ul></> : <p className="text-slate-400">Loading…</p>}
      </Section>
      <Section title="Supplies">
        <ul className="space-y-1">
          {(h.data?.inventory ?? []).filter((i) => i.unit !== "pantry").map((i) => {
            const low = i.remaining < i.lowThreshold;
            return <li key={i.id} className="flex justify-between"><span>{i.name}</span><span className={low ? "font-semibold text-red-300" : "text-slate-300"}>{i.remaining} {i.unit}{low && " · low"}</span></li>;
          })}
        </ul>
      </Section>
    </div>
  );
}

const TABS: Array<[Tab, string]> = [["mcp", "MCP Inspector"], ["data", "Data Inspector"], ["guard", "Numeric Guard"], ["steps", "Agent steps"], ["house", "Handoff & supplies"]];

/** Judge's drawer. Collapsed it is a 64px bar showing the latest MCP call; open it covers the lower half of the screen. */
export function Drawer({ household: h, convo, patientId, caregiver, open, onClose }: { household: Household; convo: Conversation; patientId: string; caregiver: string; open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("mcp");
  const inspect = useInspect(open && tab === "data", h.version + h.frames.length);

  if (!open) return null;

  return (
    <div className="glass absolute inset-x-6 bottom-2 z-30 flex h-[460px] flex-col rounded-[32px]" style={{ backgroundColor: "rgba(6,12,28,.92)" }}>
      <div className="flex h-[56px] shrink-0 items-center gap-3 px-4">
        <button onClick={onClose} aria-label="Close MCP Inspector" className="ghost flex min-h-[40px] shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-5 text-[13px] font-medium text-soft">
          MCP Inspector
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
        </button>
        <div role="tablist" className="flex gap-2">
          {TABS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`min-h-[40px] rounded-full px-4 text-[13px] transition-colors ${tab === id ? "bg-[#1b6064] font-medium text-white" : "ghost border border-white/15 text-soft"}`}>
              {label}{id === "guard" && convo.guardLog.length > 0 && <span className="ml-2 rounded-full bg-red-500 px-2 text-white">{convo.guardLog.length}</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-6" role="tabpanel">
        {tab === "mcp" && <McpInspector frames={h.frames} />}
        {tab === "data" && <DataInspector data={inspect.data} error={inspect.error} state={h.data} />}
        {tab === "guard" && <GuardLog convo={convo} />}
        {tab === "steps" && <AgentSteps convo={convo} />}
        {tab === "house" && <Household h={h} patientId={patientId} caregiver={caregiver} />}
      </div>
    </div>
  );
}
