import { useState } from "react";
import { api } from "../api/client";
import type { Household } from "../hooks/useHousehold";
import { useNow } from "../hooks/useNow";
import { buildHandoff } from "../lib/handoff";
import { formatClock, formatRemaining } from "../lib/time";
import type { PatientSnapshot } from "../api/types";

function Panel({ title, children, flash }: { title: string; children: React.ReactNode; flash?: number }) {
  return (
    <section key={flash} className="flash-live rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-400">{title}</h3>
      {children}
    </section>
  );
}

function NextDose({ snap, now, version, stale }: { snap: PatientSnapshot; now: number; version: number; stale?: boolean }) {
  if (stale) {
    // The last known lock state may be out of date; showing "Clear to dose" here would be unsafe.
    return (
      <Panel title="Next dose due" flash={version}>
        <div role="alert" className="text-xl font-semibold text-amber-300">⚠ Status unknown</div>
        <p className="mt-1 text-xs text-amber-200/80">Can't reach CareOS, so dose locks for {snap.profile.name} can't be confirmed. Don't dose from this screen.</p>
      </Panel>
    );
  }
  if (snap.active_locks.length === 0) {
    return (
      <Panel title="Next dose due" flash={version}>
        <div className="text-2xl font-semibold text-emerald-300">🟢 Clear to dose</div>
        <p className="mt-1 text-xs text-slate-400">No active lockouts for {snap.profile.name}.</p>
      </Panel>
    );
  }
  return (
    <Panel title="Next dose due" flash={version}>
      <ul className="space-y-3">
        {snap.active_locks.map((l) => {
          const at = Date.parse(l.next_eligible_time);
          const left = at - now;
          return (
            <li key={l.ingredient}>
              <div className="flex items-baseline gap-3">
                <span className="text-3xl font-bold tabular-nums text-red-300">🔴 {formatClock(at)}</span>
                <span className="text-sm capitalize text-slate-300">{l.ingredient}</span>
              </div>
              <div className="text-xs text-red-200/80">
                {l.status === "DAILY_MAX_REACHED" ? "Daily maximum reached" : "Lockout active"} · {formatRemaining(left)} remaining
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function Timeline({ snap, version }: { snap: PatientSnapshot; version: number }) {
  const rows = [...snap.medication_history].sort((a, b) => b.at - a.at).slice(0, 8);
  return (
    <Panel title="Caregiver activity timeline" flash={version}>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-400">Nothing recorded yet.</p>
      ) : (
        <ol className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.eventId} className="flex gap-3 text-sm">
              <span className="w-20 shrink-0 tabular-nums text-slate-400">{formatClock(r.at)}</span>
              <span>
                {r.medication}{r.volumeMl !== undefined && ` ${r.volumeMl} mL`} <span className="text-slate-400">· {r.caregiver}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

export function DashboardPane(props: { household: Household; patientId: string; onPatient: (id: string) => void; caregiver: string; onCaregiver: (name: string) => void }) {
  const { household: h, patientId, onPatient, caregiver, onCaregiver } = props;
  const now = useNow(h.clockSkewMs);
  const live = h.liveConnected && !h.error;
  const [showWire, setShowWire] = useState(false);
  const [openFrame, setOpenFrame] = useState<number>();
  const [resetting, setResetting] = useState(false);

  const snap = h.data?.patients.find((p) => p.profile.id === patientId) ?? h.data?.patients[0];
  const handoff = snap && h.data ? buildHandoff(snap, h.data.inventory, caregiver) : undefined;

  async function reset() {
    setResetting(true);
    try {
      await api.resetDemo();
      await h.refresh();
    } finally {
      setResetting(false);
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="CareOS live monitor">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-5 py-3">
        <h2 className="text-sm font-semibold tracking-wide">CareOS <span className="text-slate-400">live monitor</span></h2>
        <span className={`flex items-center gap-1.5 text-xs ${live ? "text-emerald-300" : "text-amber-300"}`}>
          <span className={`h-2 w-2 rounded-full ${live ? "bg-emerald-400 pulse-dot" : "bg-amber-400"}`} />
          {live ? "LIVE" : "reconnecting"}
        </span>
        <div className="ml-auto flex items-center gap-2 text-xs">
          <select value={snap?.profile.id ?? ""} onChange={(e) => onPatient(e.target.value)} aria-label="Active profile" className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1">
            {h.data?.patients.map((p) => <option key={p.profile.id} value={p.profile.id}>{p.profile.name}</option>)}
          </select>
          <select value={caregiver} onChange={(e) => onCaregiver(e.target.value)} aria-label="Active caregiver" className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1">
            {h.data?.caregivers.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
          <button onClick={() => void reset()} disabled={resetting} className="rounded-lg border border-slate-700 px-2 py-1 text-slate-300 hover:border-slate-500 disabled:opacity-40">
            Reset demo
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {h.error && <div role="alert" className="rounded-xl border border-amber-400/50 bg-amber-400/10 px-4 py-2 text-sm text-amber-200">{h.error}</div>}
        {!h.data && !h.error && <p className="text-sm text-slate-400">Loading…</p>}

        {snap && (
          <>
            <Panel title="Active profile" flash={h.version}>
              <div className="text-xl font-semibold">{snap.profile.name} <span className="text-sm font-normal capitalize text-slate-400">({snap.profile.kind}{snap.profile.weight_kg !== null && `, ${snap.profile.weight_kg} kg`})</span></div>
              {snap.profile.activeRx.length > 0 && <p className="mt-1 text-xs text-slate-400">Active Rx: {snap.profile.activeRx.join(", ")}</p>}
              {snap.profile.allergies.length > 0 && <p className="text-xs text-amber-300">Allergies: {snap.profile.allergies.join(", ")}</p>}
            </Panel>
            <NextDose snap={snap} now={now} version={h.version} stale={!!h.error} />
            <Timeline snap={snap} version={h.version} />
          </>
        )}

        {handoff && (
          <section className={`rounded-2xl border p-4 ${handoff.attention ? "border-amber-400/50 bg-amber-400/10" : "border-emerald-400/40 bg-emerald-400/5"}`}>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-widest text-slate-300">Caregiver handoff summary</h3>
            <div className="mb-1 font-medium">{handoff.headline}</div>
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-slate-200">
              {handoff.lines.map((l) => <li key={l}>{l}</li>)}
            </ul>
          </section>
        )}

        {h.data && (
          <Panel title="Supplies" flash={h.version}>
            <ul className="space-y-1.5">
              {h.data.inventory.filter((i) => i.unit !== "pantry").map((i) => {
                const low = i.remaining < i.lowThreshold;
                return (
                  <li key={i.id} className="flex items-center justify-between text-sm">
                    <span>{i.name}</span>
                    <span className={low ? "font-medium text-red-300" : "text-slate-300"}>{i.remaining} {i.unit}{low && " · low"}</span>
                  </li>
                );
              })}
            </ul>
          </Panel>
        )}

        <section className="rounded-2xl border border-slate-800">
          <button onClick={() => setShowWire((s) => !s)} aria-expanded={showWire} className="flex w-full items-center px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-widest text-slate-400">
            MCP wire log ({h.frames.length})<span className="ml-auto">{showWire ? "▾" : "▸"}</span>
          </button>
          {showWire && (
            <ul className="max-h-72 space-y-1 overflow-y-auto border-t border-slate-800 p-2 font-mono text-[11px]">
              {[...h.frames].reverse().map((f) => (
                <li key={f.id}>
                  <button onClick={() => setOpenFrame(openFrame === f.id ? undefined : f.id)} className="flex w-full gap-2 text-left">
                    <span className={f.dir === "in" ? "text-cyan-300" : "text-emerald-300"}>{f.dir === "in" ? "→" : "←"}</span>
                    <span className={f.kind === "blocked" || f.kind === "error" ? "text-red-300" : "text-slate-300"}>{f.summary}</span>
                  </button>
                  {openFrame === f.id && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-900 p-2 text-slate-400">{JSON.stringify(f.message, null, 2)}</pre>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
