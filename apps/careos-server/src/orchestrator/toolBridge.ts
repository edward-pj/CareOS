import type { ClaudeTool } from "./llm.js";

type Json = Record<string, any>;

export interface McpToolDef { name: string; description?: string; inputSchema: Json }

/**
 * Makes an MCP JSON schema acceptable to strict tool use: inlines $ref/$defs, collapses anyOf/oneOf of
 * literals into a single enum, and closes every object with additionalProperties:false.
 * Anything it cannot express (a real union) throws, so a bad tool schema fails at startup, not mid-conversation.
 */
export function sanitizeSchema(schema: Json, where = "schema"): Json {
  const defs: Json = { ...(schema.$defs ?? {}), ...(schema.definitions ?? {}) };

  const walk = (node: any, seen: string[]): any => {
    if (Array.isArray(node)) return node.map((n) => walk(n, seen));
    if (!node || typeof node !== "object") return node;

    if (typeof node.$ref === "string") {
      const name = node.$ref.split("/").pop()!;
      if (seen.includes(name) || !defs[name]) throw new Error(`${where}: cannot resolve $ref ${node.$ref}`);
      return walk(defs[name], [...seen, name]);
    }

    const alt = node.anyOf ?? node.oneOf;
    if (Array.isArray(alt)) {
      const literals = alt.every((a) => a && (a.const !== undefined || Array.isArray(a.enum)));
      if (!literals) throw new Error(`${where}: unsupported anyOf/oneOf (only unions of literals can be flattened)`);
      const values = alt.flatMap((a) => (a.const !== undefined ? [a.const] : a.enum));
      const { anyOf: _a, oneOf: _o, ...rest } = node;
      return walk({ ...rest, enum: values, type: rest.type ?? typeof values[0] }, seen);
    }

    const out: Json = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$defs" || k === "definitions" || k === "$schema") continue;
      out[k] = walk(v, seen);
    }
    if (out.type === "object") out.additionalProperties = false;
    return out;
  };

  return walk(schema, []);
}

/**
 * Tools the model must never see. override_lockout takes a caregiver PIN; PINs are entered on the
 * device keypad and sent to /api/override, so they can never pass through a transcript or the model.
 */
export const MODEL_HIDDEN_TOOLS = new Set(["override_lockout"]);

export function toClaudeTools(tools: McpToolDef[]): ClaudeTool[] {
  return tools
    .filter((t) => !MODEL_HIDDEN_TOOLS.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description ?? t.name,
      input_schema: sanitizeSchema(t.inputSchema, `tool ${t.name}`),
      strict: true as const,
    }));
}
