import { GoogleGenAI, type Content, type FunctionDeclaration, type GenerateContentParameters, type GenerateContentResponse, type Part } from "@google/genai";
import type { ContentBlock, LlmClient, LlmMessage, LlmRequest, LlmResponse, LlmTool } from "./llm.js";

/** The slice of the Gemini response we use; lets unit tests inject a fake without external network calls. */
export interface GeminiApiResponse {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{
        functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
        text?: string;
        thoughtSignature?: string;
      }>;
    };
  }>;
}

export interface GeminiApi {
  generateContent(params: GenerateContentParameters): Promise<GeminiApiResponse>;
}

export interface GeminiOptions {
  apiKey?: string;
  modelId?: string;
  maxTokens?: number;
  client?: GeminiApi;
}

export function toGeminiTools(tools: LlmTool[]): FunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: t.input_schema,
  }));
}

export function toGeminiContents(messages: LlmMessage[]): Content[] {
  const toolIdToName = new Map<string, string>();
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === "tool_use") {
          toolIdToName.set(b.id, b.name);
        }
      }
    }
  }

  const contents: Content[] = [];

  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const parts: Part[] = [];

    if (typeof m.content === "string") {
      parts.push({ text: m.content });
    } else {
      for (const b of m.content) {
        if (b.type === "text") {
          parts.push({ text: b.text });
        } else if (b.type === "tool_use") {
          parts.push({
            functionCall: {
              id: b.id,
              name: b.name,
              args: b.input as Record<string, unknown>,
            },
            ...(b.thoughtSignature ? { thoughtSignature: b.thoughtSignature } : {}),
          });
        } else if (b.type === "tool_result") {
          let responseObj: Record<string, unknown>;
          try {
            const parsed = JSON.parse(b.content);
            responseObj = typeof parsed === "object" && parsed !== null ? parsed : { result: parsed };
          } catch {
            responseObj = { output: b.content };
          }
          if (b.is_error) {
            responseObj.is_error = true;
          }

          parts.push({
            functionResponse: {
              id: b.tool_use_id,
              name: toolIdToName.get(b.tool_use_id) ?? "tool",
              response: responseObj,
            },
          });
        }
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  return contents;
}

/**
 * Gemini API implementation of LlmClient.
 * Temperature 0 keeps tool selection deterministic.
 */
export class GeminiLlm implements LlmClient {
  private client: GeminiApi;
  private modelId: string;
  private maxTokens: number;

  constructor(opts: GeminiOptions) {
    if (opts.client) {
      this.client = opts.client;
    } else {
      if (!opts.apiKey) {
        throw new Error("GEMINI_API_KEY is required for GeminiLlm");
      }
      const ai = new GoogleGenAI({ apiKey: opts.apiKey });
      this.client = {
        generateContent: (params) => ai.models.generateContent(params),
      };
    }
    this.modelId = opts.modelId ?? "gemini-2.5-flash";
    this.maxTokens = opts.maxTokens ?? 1024;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const contents = toGeminiContents(req.messages);
    const tools = req.tools.length > 0 ? [{ functionDeclarations: toGeminiTools(req.tools) }] : undefined;

    const res = await this.client.generateContent({
      model: this.modelId,
      contents,
      config: {
        systemInstruction: req.system,
        temperature: 0,
        maxOutputTokens: this.maxTokens,
        ...(tools ? { tools } : {}),
      },
    });

    const candidate = res.candidates?.[0];
    const content: LlmResponse["content"] = [];

    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall?.name) {
        content.push({
          type: "tool_use",
          id: part.functionCall.id ?? `call_${part.functionCall.name}_${Math.random().toString(36).slice(2, 9)}`,
          name: part.functionCall.name,
          input: (part.functionCall.args ?? {}) as Record<string, unknown>,
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        });
      } else if (part.text) {
        content.push({
          type: "text",
          text: part.text,
        });
      }
    }

    return {
      content,
      stopReason: candidate?.finishReason ?? "STOP",
    };
  }
}
