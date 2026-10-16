import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  port: number;
  storage: "memory" | "dynamo";
  table: string;
  ddbEndpoint?: string;
  region: string;
  snsTopicArn?: string;
  /** Browser origin to allow via CORS. Unset when the web app reaches the server through the Vite proxy (same origin). */
  allowedOrigin?: string;
  host: string;
  llmMode: "mock" | "bedrock";
  bedrockModelId: string;
  sseHeartbeatMs: number;
}

function tryLoadEnv(): void {
  if (typeof process.loadEnvFile !== "function") return;
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(import.meta.dirname, "../../../.env"),
    resolve(import.meta.dirname, "../../.env"),
  ];
  for (const file of candidates) {
    if (existsSync(file)) {
      try {
        process.loadEnvFile(file);
        break;
      } catch {
        // Ignore unreadable .env
      }
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env) {
    tryLoadEnv();
  }
  const storage = (env.STORAGE ?? "memory") as Config["storage"];
  if (storage !== "memory" && storage !== "dynamo") throw new Error(`STORAGE must be "memory" or "dynamo", got "${storage}"`);
  const llmMode = (env.LLM_MODE ?? "mock") as Config["llmMode"];
  if (llmMode !== "mock" && llmMode !== "bedrock") throw new Error(`LLM_MODE must be "mock" or "bedrock", got "${llmMode}"`);
  return {
    llmMode,
    bedrockModelId: env.BEDROCK_MODEL_ID ?? "anthropic.claude-opus-5-5",
    port: Number(env.PORT ?? 8787),
    storage,
    table: env.DDB_TABLE ?? "careos",
    ddbEndpoint: env.DDB_ENDPOINT || undefined,
    region: env.AWS_REGION ?? "us-east-1",
    snsTopicArn: env.SNS_TOPIC_ARN || undefined,
    allowedOrigin: env.ALLOWED_ORIGIN || undefined,
    // Loopback by default: the demo server is unauthenticated, so it should not listen on the LAN unless asked.
    host: env.HOST ?? "127.0.0.1",
    sseHeartbeatMs: Number(env.SSE_HEARTBEAT_MS ?? 25_000),
  };
}
