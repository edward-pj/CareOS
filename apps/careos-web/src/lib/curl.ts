import type { TraceFrame } from "../api/types";

/** Shell-safe single quoting: the one character that needs care inside '...' is the single quote itself. */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * "Copy as curl" for a JSON-RPC frame the app sent to /mcp, so a judge can replay exactly what Alexa+ did.
 * The token is never embedded: it is read from $CAREOS_TOKEN. Returns undefined for frames the server sent.
 */
export function toCurl(frame: Pick<TraceFrame, "dir" | "message">, origin: string): string | undefined {
  if (frame.dir !== "in") return undefined;
  return [
    `curl -s -X POST ${shellQuote(`${origin.replace(/\/$/, "")}/mcp`)}`,
    `  -H 'content-type: application/json'`,
    `  -H 'accept: application/json, text/event-stream'`,
    `  -H "authorization: Bearer $CAREOS_TOKEN"`,
    `  -d ${shellQuote(JSON.stringify(frame.message))}`,
  ].join(" \\\n");
}
