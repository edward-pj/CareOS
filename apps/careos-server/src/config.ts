import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  port: number;
  storage: "memory" | "dynamo" | "supabase";
  table: string;
  ddbEndpoint?: string;
  region: string;
  snsTopicArn?: string;
  supabaseUrl?: string;
  supabaseKey?: string;
  /** Browser origin to allow via CORS. Unset when the web app reaches the server through the Vite proxy (same origin). */
  allowedOrigin?: string;
  host: string;
  /** CAREOS_TOKENS: "token=household:caregiver,..." bearer credentials. Unset means open mode (loopback only). */
  tokens?: string;
  llmMode: "mock" | "bedrock" | "gemini";
  bedrockModelId: string;
  geminiApiKey?: string;
  geminiModelId: string;
  sseHeartbeatMs: number;
  /** How long a simulated Amazon order takes to arrive, in seconds (SHOP_DEMO_SECONDS). The real promise is shown as the ETA. */
  shopDemoSeconds: number;
  /** QUIET_HOURS="22:00-07:00": non-safety alerts to other caregivers wait until the window ends. */
  quietHours?: string;
  /** IANA zone the quiet hours are read in (CAREOS_TIMEZONE). */
  timeZone?: string;
  locale: "US" | "IN";
  /** Where the household is, for the nearby-hospitals search (HOUSEHOLD_LAT / HOUSEHOLD_LNG). */
  origin?: { lat: number; lng: number };
  /** Read prescription and bottle photos with Gemini (needs GEMINI_API_KEY). Off with VISION=off. */
  vision: boolean;
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

export function loadConfig(env?: NodeJS.ProcessEnv): Config {
  tryLoadEnv();
  const activeEnv = env ? { ...process.env, ...env } : process.env;
  const storage = (activeEnv.STORAGE ?? "memory") as Config["storage"];
  if (storage !== "memory" && storage !== "dynamo" && storage !== "supabase") {
    throw new Error(`STORAGE must be "memory", "dynamo", or "supabase", got "${storage}"`);
  }
  if (storage === "supabase" && (!activeEnv.SUPABASE_URL || !activeEnv.SUPABASE_KEY)) {
    throw new Error("SUPABASE_URL and SUPABASE_KEY are required when STORAGE=supabase");
  }

  const llmMode = (activeEnv.LLM_MODE ?? "mock") as Config["llmMode"];
  if (llmMode !== "mock" && llmMode !== "bedrock" && llmMode !== "gemini") {
    throw new Error(`LLM_MODE must be "mock", "bedrock", or "gemini", got "${llmMode}"`);
  }
  if (llmMode === "gemini" && !activeEnv.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is required when LLM_MODE=gemini");
  }

  return {
    llmMode,
    bedrockModelId: activeEnv.BEDROCK_MODEL_ID ?? "us.amazon.nova-pro-v1:0",
    geminiApiKey: activeEnv.GEMINI_API_KEY || undefined,
    geminiModelId: activeEnv.GEMINI_MODEL_ID ?? "gemini-2.5-flash",
    port: Number(activeEnv.PORT ?? 8787),
    storage,
    table: activeEnv.DDB_TABLE ?? "careos",
    ddbEndpoint: activeEnv.DDB_ENDPOINT || undefined,
    region: activeEnv.AWS_REGION ?? "us-east-1",
    snsTopicArn: activeEnv.SNS_TOPIC_ARN || undefined,
    supabaseUrl: activeEnv.SUPABASE_URL || undefined,
    supabaseKey: activeEnv.SUPABASE_KEY || undefined,
    allowedOrigin: activeEnv.ALLOWED_ORIGIN || undefined,
    // Loopback by default: the demo server is unauthenticated, so it should not listen on the LAN unless asked.
    host: activeEnv.HOST ?? "127.0.0.1",
    tokens: activeEnv.CAREOS_TOKENS || undefined,
    sseHeartbeatMs: Number(activeEnv.SSE_HEARTBEAT_MS ?? 25_000),
    quietHours: activeEnv.QUIET_HOURS || undefined,
    timeZone: activeEnv.CAREOS_TIMEZONE || undefined,
    locale: (activeEnv.CAREOS_LOCALE ?? "US").toUpperCase() === "IN" ? "IN" : "US",
    origin: Number.isFinite(Number(activeEnv.HOUSEHOLD_LAT)) && Number.isFinite(Number(activeEnv.HOUSEHOLD_LNG)) && activeEnv.HOUSEHOLD_LAT && activeEnv.HOUSEHOLD_LNG ? { lat: Number(activeEnv.HOUSEHOLD_LAT), lng: Number(activeEnv.HOUSEHOLD_LNG) } : undefined,
    vision: activeEnv.VISION !== "off" && Boolean(activeEnv.GEMINI_API_KEY),
    shopDemoSeconds: Math.min(3600, Math.max(5, Number(activeEnv.SHOP_DEMO_SECONDS ?? 60) || 60)),
  };
}
