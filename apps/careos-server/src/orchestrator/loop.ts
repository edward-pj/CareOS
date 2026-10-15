import { guardReply } from "./guardrail.js";
import type { ClaudeTool, ContentBlock, LlmClient, LlmMessage, TextBlock, ToolResultBlock, ToolUseBlock, TurnContext } from "./llm.js";
import type { ToolRunner } from "./mcpClient.js";

export type TurnEventType = "assistant_delta" | "tool_call" | "tool_result" | "card" | "alert" | "error" | "done";
export type Emit = (type: TurnEventType, data: unknown) => void;

export interface RunTurnOptions {
  llm: LlmClient;
  runner: ToolRunner;
  tools: ClaudeTool[];
  system: string;
  history: LlmMessage[];
  transcript: string;
  context: TurnContext;
  emit: Emit;
  maxSteps?: number;
}

const BLOCKING = /^(BLOCKED|REJECTED_.*|SEEK_CARE|OVERRIDE_DENIED)$/;
const GENERIC_FAILURE = "Sorry, something went wrong. Please try again.";

/**
 * One conversational turn: model -> tool calls (parallel) -> model ... until it answers in text.
 * Events are emitted as they happen, so a card reaches the screen as soon as its tool returns,
 * before the spoken/written reply is ready. `done` is always emitted exactly once.
 * Returns the history to keep: the new messages on success, the untouched input history on failure
 * (never a half-finished tool exchange, which the API would reject).
 */
export async function runTurn(o: RunTurnOptions): Promise<LlmMessage[]> {
  const maxSteps = o.maxSteps ?? 6;
  const messages: LlmMessage[] = [...o.history, { role: "user", content: o.transcript }];
  const seen: unknown[] = []; // tool results of THIS turn: the only numbers the reply may quote
  let kept = o.history;

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
          o.emit("alert", { kind: "GUARDRAIL_REPLACED", offending: guarded.offending });
          assistant.content = [{ type: "text", text: guarded.text }]; // keep the unbacked number out of history too
        }
        o.emit("assistant_delta", { text: guarded.text });
        kept = messages;
        return messages;
      }

      const blocks: ToolResultBlock[] = await Promise.all(uses.map((u) => runTool(u, o, seen)));
      messages.push({ role: "user", content: blocks as ContentBlock[] });
    }
    o.emit("error", { message: "Too many tool steps" });
    o.emit("assistant_delta", { text: GENERIC_FAILURE });
    return kept;
  } catch (e) {
    console.error("turn failed:", e);
    o.emit("error", { message: "The assistant is unavailable" });
    o.emit("assistant_delta", { text: GENERIC_FAILURE });
    return kept;
  } finally {
    o.emit("done", {});
  }
}

async function runTool(u: ToolUseBlock, o: RunTurnOptions, seen: unknown[]): Promise<ToolResultBlock> {
  o.emit("tool_call", { id: u.id, name: u.name, input: u.input });
  try {
    const out = await o.runner.callTool(u.name, u.input);
    seen.push(out.payload ?? out.text);
    const status = out.payload?.status;
    o.emit("tool_result", { id: u.id, name: u.name, status, is_error: out.isError });
    const card = out.payload?.card_type;
    if (card) o.emit("card", { card_type: card, tool: u.name, payload: out.payload });
    if (typeof status === "string" && BLOCKING.test(status)) {
      o.emit("alert", { kind: status, violation_type: out.payload?.violation_type ?? null, tool: u.name });
    }
    return { type: "tool_result", tool_use_id: u.id, content: out.text, is_error: out.isError || undefined };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    o.emit("tool_result", { id: u.id, name: u.name, status: "ERROR", is_error: true });
    return { type: "tool_result", tool_use_id: u.id, content: `Tool failed: ${message}`, is_error: true };
  }
}

/** Keep the last `maxTurns` user turns, always cutting on a turn boundary so tool_use/tool_result pairs stay intact. */
export function trimHistory(history: LlmMessage[], maxTurns = 10): LlmMessage[] {
  const starts = history.flatMap((m, i) => (m.role === "user" && typeof m.content === "string" ? [i] : []));
  if (starts.length <= maxTurns) return history;
  return history.slice(starts[starts.length - maxTurns]!);
}
