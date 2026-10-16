import { useState } from "react";
import type { TraceStep } from "../lib/conversation";

const DOT: Record<TraceStep["state"], string> = {
  running: "bg-amber-400 pulse-dot",
  ok: "bg-emerald-400",
  blocked: "bg-red-500",
  error: "bg-red-500",
};

function Step({ step }: { step: TraceStep }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-slate-700/70 bg-slate-900/70">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-xs" aria-expanded={open}>
        <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[step.state]}`} />
        <span className="text-amber-300">⚡ {step.name}</span>
        <span className="ml-auto text-slate-400">{step.state === "running" ? "running…" : (step.status ?? step.state)}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-slate-700/70 px-3 py-2 font-mono text-[11px] text-slate-300">
          <div>
            <div className="mb-0.5 text-slate-500">arguments</div>
            <pre className="whitespace-pre-wrap break-all">{JSON.stringify(step.input, null, 2)}</pre>
          </div>
          {step.payload && (
            <div>
              <div className="mb-0.5 text-slate-500">MCP payload</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(step.payload, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** Agent reasoning: which MCP tool Bedrock picked and what came back. */
export function AgentTrace({ steps, progress }: { steps: TraceStep[]; progress?: string }) {
  if (steps.length === 0 && !progress) return null;
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-widest text-slate-400">Agent reasoning (Bedrock)</h3>
      <ul className="space-y-1.5">
        {steps.map((s) => <Step key={s.id} step={s} />)}
        {steps.length === 0 && progress && <li className="font-mono text-xs text-slate-400">{progress}</li>}
      </ul>
    </div>
  );
}
