import type { ClaudeTool, LlmClient, LlmMessage } from "./llm.js";
import type { ToolRunner } from "./mcpClient.js";
import { runTurn, trimHistory } from "./loop.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { toClaudeTools } from "./toolBridge.js";
import { TurnStore } from "./turns.js";

export interface ConverseRequest { session_id: string; active_profile: string; caregiver: string; transcript: string }

export interface OrchestratorOptions {
  llm: LlmClient;
  runner: ToolRunner;
  now?: () => number;
  maxHistoryTurns?: number;
  maxSessions?: number;
}

/** Owns conversation sessions and turn event logs. One turn per session at a time. */
export class Orchestrator {
  readonly turns = new TurnStore();
  private tools: ClaudeTool[] = [];
  private sessions = new Map<string, LlmMessage[]>();
  private busy = new Set<string>();
  private ready = false;

  constructor(private o: OrchestratorOptions) {}

  get isReady() { return this.ready; }

  /** Fetches the tool list from the MCP server and prepares it for the model. Call after the server is listening. */
  async init(): Promise<void> {
    this.tools = toClaudeTools(await this.o.runner.listTools());
    this.ready = true;
  }

  get toolNames(): string[] { return this.tools.map((t) => t.name); }

  start(req: ConverseRequest): { turnId: string } | "busy" {
    if (this.busy.has(req.session_id)) return "busy";
    this.busy.add(req.session_id);
    const turnId = this.turns.create();
    void this.run(turnId, req);
    return { turnId };
  }

  private async run(turnId: string, req: ConverseRequest): Promise<void> {
    const now = (this.o.now ?? Date.now)();
    const context = { turnId, activeProfile: req.active_profile, caregiver: req.caregiver, nowIso: new Date(now).toISOString() };
    try {
      const history = await runTurn({
        llm: this.o.llm,
        runner: this.o.runner,
        tools: this.tools,
        system: buildSystemPrompt(context),
        history: this.sessions.get(req.session_id) ?? [],
        transcript: req.transcript,
        context,
        emit: (type, data) => this.turns.append(turnId, type, data),
      });
      this.remember(req.session_id, trimHistory(history, this.o.maxHistoryTurns ?? 10));
    } finally {
      this.busy.delete(req.session_id);
    }
  }

  private remember(sessionId: string, history: LlmMessage[]): void {
    this.sessions.delete(sessionId); // re-insert so the oldest session is evicted first
    this.sessions.set(sessionId, history);
    const max = this.o.maxSessions ?? 200;
    while (this.sessions.size > max) this.sessions.delete(this.sessions.keys().next().value!);
  }
}
