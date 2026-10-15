export interface Config {
  port: number;
  storage: "memory" | "dynamo";
  table: string;
  ddbEndpoint?: string;
  region: string;
  snsTopicArn?: string;
  /** Browser origin to allow via CORS. Unset for the native Vega client. */
  allowedOrigin?: string;
  host: string;
  llmMode: "mock" | "bedrock";
  bedrockModelId: string;
  sseHeartbeatMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
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
    // 0.0.0.0 so a Vega device / virtual device on the LAN can reach the server.
    host: env.HOST ?? "0.0.0.0",
    sseHeartbeatMs: Number(env.SSE_HEARTBEAT_MS ?? 25_000),
  };
}
