import { FAIL_CLOSED_MESSAGE } from "open-caregiver-mcp";
import { guardReply } from "./guardrail.js";
import type { LlmTool, ContentBlock, LlmClient, LlmMessage, TextBlock, ToolResultBlock, ToolUseBlock, TurnContext } from "./llm.js";
import type { ToolRunner } from "./mcpClient.js";
import { BLOCKING_STATUS } from "./statuses.js";

export type TurnEventType = "assistant_delta" | "tool_call" | "tool_result" | "card" | "alert" | "numeric_guard" | "error" | "done";
export type Emit = (type: TurnEventType, data: unknown) => void;

export interface RunTurnOptions {
  llm: LlmClient;
  runner: ToolRunner;
  tools: LlmTool[];
  system: string;
  history: LlmMessage[];
  transcript: string;
  context: TurnContext;
  emit: Emit;
  maxSteps?: number;
}

/** What one tool call produced, beyond the text the model sees. */
interface ToolRun {
  block: ToolResultBlock;
  payload?: Record<string, unknown>;
  failed: boolean;
}

/**
 * One conversational turn: model -> tool calls (parallel) -> ... until a reply exists.
 *
 * Three rules keep the model from putting words in the safety engine's mouth:
 *  1. A tool result flagged `read_verbatim` is spoken AS IS. The model is not asked to rephrase it, so it cannot
 *     restate a dose wrongly (the reply is the tool's `speech`, plus its `followup`).
 *  2. Any other reply the model drafts goes through the Numeric Guard: an unbacked number replaces the whole draft.
 *  3. If a tool fails, the reply is the fail-closed message. The model never improvises around a broken safety tool.
 *
 * Events are emitted as they happen, so a card reaches the screen as soon as its tool returns. `done` is emitted
 * exactly once. Returns the history to keep: the new messages on success, the untouched input history on failure.
 */
export async function runTurn(o: RunTurnOptions): Promise<LlmMessage[]> {
  const maxSteps = o.maxSteps ?? 6;
  const messages: LlmMessage[] = [...o.history, { role: "user", content: o.transcript }];
  const seen: unknown[] = []; // tool results of THIS turn: the only numbers a reply may quote
  let kept = o.history;

  const finish = (text: string, extra: Record<string, unknown> = {}) => {
    messages.push({ role: "assistant", content: [{ type: "text", text }] });
    o.emit("assistant_delta", { text, ...extra });
    kept = messages;
    return messages;
  };

  try {
    for (let step = 0; step < maxSteps; step++) {
      const res = await o.llm.complete({ system: o.system, messages, tools: o.tools, context: o.context });
      const assistant: LlmMessage = { role: "assistant", content: res.content };
      messages.push(assistant);

      const uses = res.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      if (uses.length === 0) {
        const raw = res.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join(" ").trim();
        const guarded = guardReply(raw, seen);
        if (guarded.replaced) {
          o.emit("numeric_guard", { kind: "numeric_guard.blocked", offending: guarded.offending, draft: guarded.draft, replacement: guarded.text });
          o.emit("alert", { kind: "GUARDRAIL_REPLACED", offending: guarded.offending });
          assistant.content = [{ type: "text", text: guarded.text }]; // keep the unbacked number out of history too
        }
        o.emit("assistant_delta", { text: guarded.text });
        kept = messages;
        return messages;
      }

      const runs = await Promise.all(uses.map((u) => runTool(u, o, seen)));
      messages.push({ role: "user", content: runs.map((r) => r.block) as ContentBlock[] });

      // Rule 3: a failed safety tool is never papered over by the model.
      if (runs.some((r) => r.failed)) {
        o.emit("error", { message: "A safety tool failed; answered with the fail-closed message" });
        return finish(FAIL_CLOSED_MESSAGE);
      }

      // Rule 1: speak the tool's own words.
      const spoken = runs.flatMap((r) => (r.payload?.read_verbatim === true && typeof r.payload.speech === "string" ? [r.payload] : []));
      if (spoken.length > 0) {
        const text = spoken.map((p) => p.speech as string).join(" ");
        const followups = spoken.map((p) => p.followup).filter((f): f is string => typeof f === "string" && f.length > 0);
        const followup = followups.length > 0 ? followups.join(" ") : undefined;
        messages.push({ role: "assistant", content: [{ type: "text", text: followup ? `${text} ${followup}` : text }] });
        o.emit("assistant_delta", { text, verbatim: true, ...(followup ? { followup } : {}) });
        kept = messages;
        return messages;
      }
    }
    o.emit("error", { message: "Too many tool steps" });
    o.emit("assistant_delta", { text: FAIL_CLOSED_MESSAGE });
    return kept;
  } catch (e) {
    console.error("turn failed:", e);
    o.emit("error", { message: "The assistant is unavailable" });
    o.emit("assistant_delta", { text: FAIL_CLOSED_MESSAGE });
    return kept;
  } finally {
    o.emit("done", {});
  }
}

async function runTool(u: ToolUseBlock, o: RunTurnOptions, seen: unknown[]): Promise<ToolRun> {
  o.emit("tool_call", { id: u.id, name: u.name, input: u.input });
  try {
    const out = await o.runner.callTool(u.name, u.input);
    const status = out.payload?.status;
    o.emit("tool_result", { id: u.id, name: u.name, status, is_error: out.isError });
    if (out.isError) {
      return { block: { type: "tool_result", tool_use_id: u.id, content: out.text, is_error: true }, failed: true };
    }
    seen.push(out.payload ?? out.text);
    const card = out.payload?.card_type;
    if (card) o.emit("card", { card_type: card, tool: u.name, payload: out.payload });
    if (typeof status === "string" && BLOCKING_STATUS.test(status)) {
      o.emit("alert", { kind: status, violation_type: out.payload?.violation_type ?? null, tool: u.name });
    }
    return { block: { type: "tool_result", tool_use_id: u.id, content: out.text }, payload: out.payload, failed: false };
  } catch (e) {
    // The detail stays in the server log; the model and the caregiver only see that the check could not be made.
    console.error(`tool ${u.name} failed:`, e);
    o.emit("tool_result", { id: u.id, name: u.name, status: "ERROR", is_error: true });
    return { block: { type: "tool_result", tool_use_id: u.id, content: "Tool failed", is_error: true }, failed: true };
  }
}

/** Keep the last `maxTurns` user turns, always cutting on a turn boundary so tool_use/tool_result pairs stay intact. */
export function trimHistory(history: LlmMessage[], maxTurns = 10): LlmMessage[] {
  const starts = history.flatMap((m, i) => (m.role === "user" && typeof m.content === "string" ? [i] : []));
  if (starts.length <= maxTurns) return history;
  return history.slice(starts[starts.length - maxTurns]!);
}
