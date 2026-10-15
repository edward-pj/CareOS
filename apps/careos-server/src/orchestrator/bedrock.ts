import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import type { LlmClient, LlmRequest, LlmResponse } from "./llm.js";

/** The slice of the SDK we use; lets tests inject a fake without AWS. */
export interface MessagesApi {
  messages: { create(params: any): Promise<{ content: any[]; stop_reason: string | null }> };
}

export interface BedrockOptions {
  region: string;
  modelId: string;
  maxTokens?: number;
  client?: MessagesApi;
}

/**
 * Claude on Amazon Bedrock via the Mantle Messages API. effort "low" keeps voice-style turns fast;
 * tool_choice stays "auto" (forced tool choice is rejected on Opus 5.5).
 */
export class BedrockLlm implements LlmClient {
  private client: MessagesApi;
  private modelId: string;
  private maxTokens: number;

  constructor(opts: BedrockOptions) {
    this.client = opts.client ?? (new AnthropicBedrockMantle({ awsRegion: opts.region }) as unknown as MessagesApi);
    this.modelId = opts.modelId;
    this.maxTokens = opts.maxTokens ?? 1024;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.client.messages.create({
      model: this.modelId,
      max_tokens: this.maxTokens,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      tool_choice: { type: "auto" },
      output_config: { effort: "low" },
    });

    const content: LlmResponse["content"] = [];
    for (const b of res.content) {
      if (b.type === "text") content.push({ type: "text", text: b.text });
      else if (b.type === "tool_use") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} });
    }
    return { content, stopReason: res.stop_reason ?? "end_turn" };
  }
}
