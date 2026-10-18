// Provider-neutral shapes for the tool-use loop. The Bedrock client and the offline mock both implement LlmClient.

export interface TextBlock { type: "text"; text: string }
export interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; /** Opaque Gemini token that must be echoed back with the call. */ thoughtSignature?: string }
export interface ToolResultBlock { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface LlmMessage { role: "user" | "assistant"; content: string | ContentBlock[] }

export interface LlmTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Per-turn facts injected into the prompt (and read by the mock). */
export interface TurnContext {
  turnId: string;
  activeProfile: string;
  caregiver: string;
  nowIso: string;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  context: TurnContext;
}

export interface LlmResponse {
  content: Array<TextBlock | ToolUseBlock>;
  stopReason: string;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}
