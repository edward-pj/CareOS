import { describe, expect, it } from "vitest";
import { GeminiLlm, toGeminiContents, toGeminiTools } from "../src/orchestrator/gemini.js";
import type { LlmMessage, LlmTool, TurnContext } from "../src/orchestrator/llm.js";

const ctx: TurnContext = { turnId: "t1", activeProfile: "leo", caregiver: "Sarah", nowIso: "2026-10-18T00:00:00.000Z" };

describe("toGeminiTools", () => {
  it("converts LlmTool definitions to Gemini functionDeclarations with parametersJsonSchema", () => {
    const tools: LlmTool[] = [
      {
        name: "calculate_pediatric_dose",
        description: "Calculates dosage",
        input_schema: {
          type: "object",
          properties: { patient_id: { type: "string" } },
          required: ["patient_id"],
        },
      },
    ];
    const decls = toGeminiTools(tools);
    expect(decls).toEqual([
      {
        name: "calculate_pediatric_dose",
        description: "Calculates dosage",
        parametersJsonSchema: {
          type: "object",
          properties: { patient_id: { type: "string" } },
          required: ["patient_id"],
        },
      },
    ]);
  });
});

describe("toGeminiContents", () => {
  it("converts messages across conversational turns including tool calls and tool responses", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: "How much Motrin for Leo?" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_123",
            name: "calculate_pediatric_dose",
            input: { patient_id: "leo", weight_value: 19, weight_unit: "lbs" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_123",
            content: JSON.stringify({ status: "APPROVED", dispense_volume_ml: 2 }),
            is_error: false,
          },
        ],
      },
    ];

    const contents = toGeminiContents(messages);

    expect(contents).toHaveLength(3);
    expect(contents[0]).toEqual({
      role: "user",
      parts: [{ text: "How much Motrin for Leo?" }],
    });
    expect(contents[1]).toEqual({
      role: "model",
      parts: [
        {
          functionCall: {
            id: "call_123",
            name: "calculate_pediatric_dose",
            args: { patient_id: "leo", weight_value: 19, weight_unit: "lbs" },
          },
        },
      ],
    });
    expect(contents[2]).toEqual({
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "call_123",
            name: "calculate_pediatric_dose",
            response: { status: "APPROVED", dispense_volume_ml: 2 },
          },
        },
      ],
    });
  });

  it("handles string tool results and marks errors in tool responses", () => {
    const messages: LlmMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_err",
            name: "failing_tool",
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_err",
            content: "Database timeout",
            is_error: true,
          },
        ],
      },
    ];

    const contents = toGeminiContents(messages);
    expect(contents[1]?.parts?.[0]).toEqual({
      functionResponse: {
        id: "call_err",
        name: "failing_tool",
        response: { output: "Database timeout", is_error: true },
      },
    });
  });
});

describe("GeminiLlm", () => {
  it("calls Gemini with model, contents, systemInstruction, tools and temperature 0", async () => {
    let capturedParams: any;
    const llm = new GeminiLlm({
      modelId: "gemini-2.5-flash",
      client: {
        generateContent: async (params: any) => {
          capturedParams = params;
          return {
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    {
                      functionCall: {
                        id: "call_abc",
                        name: "calculate_pediatric_dose",
                        args: { patient_id: "leo" },
                      },
                    },
                    {
                      text: "Checking dosage for Leo...",
                    },
                  ],
                },
              },
            ],
          };
        },
      },
    });

    const tools: LlmTool[] = [
      { name: "calculate_pediatric_dose", description: "calc", input_schema: { type: "object" } },
    ];
    const messages: LlmMessage[] = [{ role: "user", content: "Check Leo" }];

    const res = await llm.complete({
      system: "You are CareOS assistant",
      messages,
      tools,
      context: ctx,
    });

    expect(capturedParams).toMatchObject({
      model: "gemini-2.5-flash",
      config: {
        systemInstruction: "You are CareOS assistant",
        temperature: 0,
        maxOutputTokens: 1024,
        tools: [
          {
            functionDeclarations: [
              {
                name: "calculate_pediatric_dose",
                description: "calc",
                parametersJsonSchema: { type: "object" },
              },
            ],
          },
        ],
      },
    });

    expect(res.stopReason).toBe("STOP");
    expect(res.content).toEqual([
      {
        type: "tool_use",
        id: "call_abc",
        name: "calculate_pediatric_dose",
        input: { patient_id: "leo" },
      },
      {
        type: "text",
        text: "Checking dosage for Leo...",
      },
    ]);
  });

  it("throws when initialized without apiKey and without injected client", () => {
    expect(() => new GeminiLlm({})).toThrow(/GEMINI_API_KEY is required/);
  });
});

describe("thoughtSignature round-trip", () => {
  it("copies the signature from a functionCall response and echoes it on the next request", async () => {
    let sent: any;
    const llm = new GeminiLlm({
      client: {
        generateContent: async (params) => {
          sent = params;
          return {
            candidates: [{ content: { parts: [{ functionCall: { id: "c1", name: "t", args: {} }, thoughtSignature: "sig-abc" }] } }],
          };
        },
      },
    });
    const res = await llm.complete({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [], context: ctx });
    expect(res.content[0]).toMatchObject({ type: "tool_use", thoughtSignature: "sig-abc" });

    const contents = toGeminiContents([{ role: "assistant", content: res.content }]);
    expect(contents[0].parts![0].thoughtSignature).toBe("sig-abc");
    expect(sent.model).toBeTruthy();
  });
});
