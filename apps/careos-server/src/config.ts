export interface Config {
  port: number;
  storage: "memory" | "dynamo";
  table: string;
  ddbEndpoint?: string;
  region: string;
  snsTopicArn?: string;
  allowedOrigin: string;
  sseHeartbeatMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const storage = (env.STORAGE ?? "memory") as Config["storage"];
  if (storage !== "memory" && storage !== "dynamo") throw new Error(`STORAGE must be "memory" or "dynamo", got "${storage}"`);
  return {
    port: Number(env.PORT ?? 8787),
    storage,
    table: env.DDB_TABLE ?? "careos",
    ddbEndpoint: env.DDB_ENDPOINT || undefined,
    region: env.AWS_REGION ?? "us-east-1",
    snsTopicArn: env.SNS_TOPIC_ARN || undefined,
    allowedOrigin: env.ALLOWED_ORIGIN ?? "http://localhost:5173",
    sseHeartbeatMs: Number(env.SSE_HEARTBEAT_MS ?? 25_000),
  };
}
