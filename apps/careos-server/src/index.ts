import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SNSClient } from "@aws-sdk/client-sns";
import { CareService, MemoryAdapter, createSeed, type StorageAdapter } from "open-caregiver-mcp";
import { ConsoleNotifier, SnsNotifier } from "./adapters/sns.js";
import { DynamoStorage } from "./adapters/dynamoStorage.js";
import { SupabaseStorage, SupabaseNotifier } from "./adapters/supabaseStorage.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { BedrockLlm } from "./orchestrator/bedrock.js";
import { GeminiLlm } from "./orchestrator/gemini.js";
import { Orchestrator } from "./orchestrator/index.js";
import { McpToolClient } from "./orchestrator/mcpClient.js";
import { MockLlm } from "./orchestrator/mock.js";

const cfg = loadConfig();

let storage: StorageAdapter;
let supabaseClient: SupabaseClient | undefined;

if (cfg.storage === "dynamo") {
  const ddb = new DynamoStorage(new DynamoDBClient({ region: cfg.region, endpoint: cfg.ddbEndpoint, ...(cfg.ddbEndpoint ? { credentials: { accessKeyId: "local", secretAccessKey: "local" } } : {}) }), cfg.table);
  await ddb.ensureTable();
  if ((await ddb.listPatients()).length === 0) await ddb.reset(createSeed(Date.now()));
  storage = ddb;
} else if (cfg.storage === "supabase") {
  supabaseClient = createClient(cfg.supabaseUrl!, cfg.supabaseKey!, { auth: { persistSession: false } });
  const supa = new SupabaseStorage(cfg.supabaseUrl!, cfg.supabaseKey!, supabaseClient);
  if ((await supa.listPatients()).length === 0) await supa.reset(createSeed(Date.now()));
  storage = supa;
} else {
  storage = new MemoryAdapter(createSeed(Date.now()));
}

const notifier = cfg.snsTopicArn
  ? new SnsNotifier(new SNSClient({ region: cfg.region }), cfg.snsTopicArn)
  : supabaseClient
  ? new SupabaseNotifier(supabaseClient)
  : new ConsoleNotifier();
const service = new CareService(storage, { notifier });
// The orchestrator reaches the MCP server over a real HTTP hop, so it connects after we are listening.
const mcpClient = new McpToolClient();
const llm =
  cfg.llmMode === "bedrock"
    ? new BedrockLlm({ region: cfg.region, modelId: cfg.bedrockModelId })
    : cfg.llmMode === "gemini"
    ? new GeminiLlm({ apiKey: cfg.geminiApiKey!, modelId: cfg.geminiModelId })
    : new MockLlm();
const orchestrator = new Orchestrator({ llm, runner: mcpClient });
const { app } = createApp({ service, storage, orchestrator, allowedOrigin: cfg.allowedOrigin, sseHeartbeatMs: cfg.sseHeartbeatMs });

app.listen(cfg.port, cfg.host, () => {
  console.error(`careos-server ${cfg.host}:${cfg.port}  storage=${cfg.storage}  alerts=${cfg.snsTopicArn ? "sns" : "console"}  llm=${cfg.llmMode}  mcp=/mcp`);
  mcpClient
    .connect(new URL(`http://127.0.0.1:${cfg.port}/mcp`))
    .then(() => orchestrator.init())
    .then(() => console.error(`orchestrator ready: ${orchestrator.toolNames.join(", ")}`))
    .catch((e) => console.error("orchestrator failed to start; /api/converse will return 503:", e));
});
