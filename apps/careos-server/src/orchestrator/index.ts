import type { LlmTool, LlmClient, LlmMessage } from "./llm.js";
import type { ToolRunner } from "./mcpClient.js";
import { runTurn, trimHistory } from "./loop.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { toLlmTools } from "./toolBridge.js";
import { TurnStore } from "./turns.js";

export interface ConverseRequest { session_id: string; active_profile: string; caregiver: string; transcript: string }

/** Who is speaking: scopes the session and turn to a household and makes tool calls run as that caller. */
export interface Caller { householdId: string; bearer?: string }
const DEFAULT_CALLER: Caller = { householdId: "demo" };

export interface OrchestratorOptions {
  llm: LlmClient;
  /** Default runner: used to discover tools at boot and for callers without their own. */
  runner: ToolRunner;
  /** Per-caller runner (one MCP connection per bearer token) so tool calls act as the caller's household. */
  runnerFor?: (bearer: string | undefined) => Promise<ToolRunner>;
  now?: () => number;
  maxHistoryTurns?: number;
  maxSessions?: number;
}

/** Owns conversation sessions and turn event logs. One turn per session at a time. */
export class Orchestrator {
  readonly turns = new TurnStore();
  private tools: LlmTool[] = [];
  private sessions = new Map<string, LlmMessage[]>();
  private busy = new Set<string>();
  private ready = false;

  constructor(private o: OrchestratorOptions) {}

  get isReady() { return this.ready; }

  /** Fetches the tool list from the MCP server and prepares it for the model. Call after the server is listening. */
  async init(): Promise<void> {
    this.tools = toLlmTools(await this.o.runner.listTools());
    this.ready = true;
  }

  get toolNames(): string[] { return this.tools.map((t) => t.name); }

  start(req: ConverseRequest, caller: Caller = DEFAULT_CALLER): { turnId: string } | "busy" {
    // Session ids are chosen by the client, so namespace them: one household can never join another's conversation.
    const sessionKey = `${caller.householdId}:${req.session_id}`;
    if (this.busy.has(sessionKey)) return "busy";
    this.busy.add(sessionKey);
    const turnId = this.turns.create(caller.householdId);
    void this.run(turnId, req, sessionKey, caller);
    return { turnId };
  }

  private async run(turnId: string, req: ConverseRequest, sessionKey: string, caller: Caller): Promise<void> {
    const now = (this.o.now ?? Date.now)();
    const context = { turnId, activeProfile: req.active_profile, caregiver: req.caregiver, nowIso: new Date(now).toISOString() };
    try {
      const runner = this.o.runnerFor ? await this.o.runnerFor(caller.bearer) : this.o.runner;
      const history = await runTurn({
        llm: this.o.llm,
        runner,
        tools: this.tools,
        system: buildSystemPrompt(context),
        history: this.sessions.get(sessionKey) ?? [],
        transcript: req.transcript,
        context,
        emit: (type, data) => this.turns.append(turnId, type, data),
      });
      this.remember(sessionKey, trimHistory(history, this.o.maxHistoryTurns ?? 10));
    } catch (e) {
      // Connecting to the tool server failed before the turn could start: report it instead of leaving the turn open.
      console.error("turn failed before start:", e);
      this.turns.append(turnId, "error", { message: "Could not reach the safety tools" });
      this.turns.append(turnId, "assistant_delta", { text: "Sorry, something went wrong. Please try again." });
      this.turns.append(turnId, "done", {});
    } finally {
      this.busy.delete(sessionKey);
    }
  }

  private remember(sessionId: string, history: LlmMessage[]): void {
    this.sessions.delete(sessionId); // re-insert so the oldest session is evicted first
    this.sessions.set(sessionId, history);
    const max = this.o.maxSessions ?? 200;
    while (this.sessions.size > max) this.sessions.delete(this.sessions.keys().next().value!);
  }
}
