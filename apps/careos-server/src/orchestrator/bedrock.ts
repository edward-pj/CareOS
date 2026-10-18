import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { ContentBlock as BrContent, ConverseCommandInput, ConverseCommandOutput, Message } from "@aws-sdk/client-bedrock-runtime";
import type { ContentBlock, LlmClient, LlmMessage, LlmRequest, LlmResponse } from "./llm.js";

/** The slice of the SDK we use; lets tests inject a fake without AWS. */
export interface ConverseApi {
  converse(input: ConverseCommandInput): Promise<Pick<ConverseCommandOutput, "output" | "stopReason">>;
}

export interface BedrockOptions {
  region: string;
  modelId: string;
  maxTokens?: number;
  client?: ConverseApi;
}

function toBedrockContent(content: string | ContentBlock[]): BrContent[] {
  if (typeof content === "string") return [{ text: content }];
  return content.map((b): BrContent => {
    if (b.type === "text") return { text: b.text };
    if (b.type === "tool_use") return { toolUse: { toolUseId: b.id, name: b.name, input: b.input as any } };
    return { toolResult: { toolUseId: b.tool_use_id, content: [{ text: b.content }], status: b.is_error ? "error" : "success" } };
  });
}

export function toBedrockMessages(messages: LlmMessage[]): Message[] {
  return messages.map((m) => ({ role: m.role, content: toBedrockContent(m.content) }));
}

/**
 * Amazon Nova on Amazon Bedrock via the Converse API. Temperature 0 keeps tool selection stable (Nova's
 * recommendation for tool use); toolChoice "auto" lets the model answer directly when no tool applies.
 */
export class BedrockLlm implements LlmClient {
  private client: ConverseApi;
  private modelId: string;
  private maxTokens: number;

  constructor(opts: BedrockOptions) {
    const sdk = opts.client ? undefined : new BedrockRuntimeClient({ region: opts.region });
    this.client = opts.client ?? { converse: (input) => sdk!.send(new ConverseCommand(input)) };
    this.modelId = opts.modelId;
    this.maxTokens = opts.maxTokens ?? 1024;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.client.converse({
      modelId: this.modelId,
      system: [{ text: req.system }],
      messages: toBedrockMessages(req.messages),
      toolConfig: {
        tools: req.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.input_schema as any } } })),
        toolChoice: { auto: {} },
      },
      inferenceConfig: { maxTokens: this.maxTokens, temperature: 0 },
    });

    const content: LlmResponse["content"] = [];
    for (const b of res.output?.message?.content ?? []) {
      if (b.text) content.push({ type: "text", text: b.text });
      else if (b.toolUse) content.push({ type: "tool_use", id: b.toolUse.toolUseId!, name: b.toolUse.name!, input: (b.toolUse.input ?? {}) as Record<string, unknown> });
    }
    return { content, stopReason: res.stopReason ?? "end_turn" };
  }
}
