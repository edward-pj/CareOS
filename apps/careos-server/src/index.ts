import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SNSClient } from "@aws-sdk/client-sns";
import { MemoryStorage, createSeed, type StorageRoot } from "open-caregiver-mcp";
import { isLoopbackHost, OPEN_CONTEXT, TokenAuth } from "./auth.js";
import { createTenants } from "./tenants.js";
import { ShopBus, ShopTicker, timelineFor } from "./shop.js";
import { ConsoleNotifier, SnsNotifier } from "./adapters/sns.js";
import { DynamoRoot } from "./adapters/dynamoStorage.js";
import { SupabaseNotifier, SupabaseRoot } from "./adapters/supabaseStorage.js";
import { GeminiVision } from "./orchestrator/geminiVision.js";
import { UploadStore } from "./uploads.js";
import { QuietHoursNotifier, parseQuietHours } from "open-caregiver-mcp";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { BedrockLlm } from "./orchestrator/bedrock.js";
import { GeminiLlm } from "./orchestrator/gemini.js";
import { Orchestrator } from "./orchestrator/index.js";
import { McpRunnerPool, McpToolClient } from "./orchestrator/mcpClient.js";
import { MockLlm } from "./orchestrator/mock.js";

const cfg = loadConfig();

// One root per backend; every request path works through a household-scoped adapter, chosen by the
// household the caller's bearer token belongs to.
let root: StorageRoot;
let supabaseClient: SupabaseClient | undefined;

if (cfg.storage === "dynamo") {
  const ddb = new DynamoRoot(new DynamoDBClient({ region: cfg.region, endpoint: cfg.ddbEndpoint, ...(cfg.ddbEndpoint ? { credentials: { accessKeyId: "local", secretAccessKey: "local" } } : {}) }), cfg.table);
  await ddb.ensureTable();
  root = ddb;
} else if (cfg.storage === "supabase") {
  supabaseClient = createClient(cfg.supabaseUrl!, cfg.supabaseKey!, { auth: { persistSession: false } });
  const supabaseRoot = new SupabaseRoot(supabaseClient);
  await supabaseRoot.assertSchema();
  root = supabaseRoot;
} else {
  root = new MemoryStorage();
}

const auth = cfg.tokens ? TokenAuth.fromSpec(cfg.tokens) : TokenAuth.open();
if (auth.mode === "open" && !isLoopbackHost(cfg.host)) {
  throw new Error(`Refusing to listen on ${cfg.host} without authentication. Set CAREOS_TOKENS="token=household:caregiver,..." (or bind HOST=127.0.0.1).`);
}

// Seed demo data into every household that can sign in and is still empty.
for (const household of auth.mode === "bearer" ? auth.households() : [OPEN_CONTEXT.householdId]) {
  const store = root.forHousehold(household);
  if ((await store.listPatients()).length === 0) await store.reset(createSeed(Date.now()));
}

// NOTE: one SNS topic serves every household until per-household topics land (Phase 7).
const snsNotifier = cfg.snsTopicArn ? new SnsNotifier(new SNSClient({ region: cfg.region }), cfg.snsTopicArn) : undefined;
const consoleNotifier = new ConsoleNotifier();

const shopBus = new ShopBus();
const uploads = new UploadStore();
const quiet = parseQuietHours(cfg.quietHours, cfg.timeZone);
const quietWrappers: QuietHoursNotifier[] = [];
const tenants = createTenants(root, {
  uploads,
  vision: cfg.vision ? new GeminiVision({ apiKey: cfg.geminiApiKey, modelId: cfg.geminiModelId }) : undefined,
  locale: cfg.locale,
  origin: cfg.origin ? { ...cfg.origin, label: "Household location" } : undefined,
  shopTimeline: timelineFor(cfg.shopDemoSeconds),
  onShopEvent: (householdId, e) => shopBus.publish(householdId, e),
  notifierFor: (householdId) => {
    const base = cfg.snsTopicArn ? snsNotifier : supabaseClient ? new SupabaseNotifier(supabaseClient, householdId) : consoleNotifier;
    if (!quiet || !base) return base;
    // Quiet hours hold ordinary alerts; lockouts, critical blocks and emergencies always go through.
    const wrapped = new QuietHoursNotifier(base, quiet);
    quietWrappers.push(wrapped);
    return wrapped;
  },
});
if (quiet) setInterval(() => { for (const w of quietWrappers) void w.flushIfDue().catch((e) => console.error("[quiet-hours] flush failed:", e)); }, 30_000).unref();
// The orchestrator reaches the MCP server over a real HTTP hop, so it connects after we are listening.
// Boot-time tool discovery uses an internal token; each turn then runs as the caller's own token.
const internalToken = auth.mode === "bearer" ? auth.mint({ householdId: "_system", caregiverId: "system" }) : undefined;
const mcpUrl = new URL(`http://127.0.0.1:${cfg.port}/mcp`);
const mcpClient = new McpToolClient();
const runners = new McpRunnerPool(mcpUrl);
const llm =
  cfg.llmMode === "bedrock"
    ? new BedrockLlm({ region: cfg.region, modelId: cfg.bedrockModelId })
    : cfg.llmMode === "gemini"
    ? new GeminiLlm({ apiKey: cfg.geminiApiKey!, modelId: cfg.geminiModelId })
    : new MockLlm();
const orchestrator = new Orchestrator({ llm, runner: mcpClient, runnerFor: (bearer) => runners.forToken(bearer) });
const { app } = createApp({ tenants, auth, shopBus, uploads, backend: cfg.storage, orchestrator, allowedOrigin: cfg.allowedOrigin, sseHeartbeatMs: cfg.sseHeartbeatMs });

// Orders keep moving while nobody is watching: pick up any order already in flight (e.g. after a restart).
const ticker = new ShopTicker(tenants, shopBus);
// "_system" is only the orchestrator's boot-time identity: it owns no data, so there is nothing to tick.
for (const household of auth.mode === "bearer" ? auth.households().filter((h) => h !== "_system") : [OPEN_CONTEXT.householdId]) ticker.watch(household);
ticker.start();

app.listen(cfg.port, cfg.host, () => {
  console.error(`careos-server ${cfg.host}:${cfg.port}  storage=${cfg.storage}  alerts=${cfg.snsTopicArn ? "sns" : "console"}  llm=${cfg.llmMode}  vision=${cfg.vision ? "gemini" : "off"}  quiet=${cfg.quietHours ?? "off"}  locale=${cfg.locale}  mcp=/mcp (stateless, auth=${auth.mode})`);
  mcpClient
    .connect(mcpUrl, internalToken)
    .then(() => orchestrator.init())
    .then(() => console.error(`orchestrator ready: ${orchestrator.toolNames.join(", ")}`))
    .catch((e) => console.error("orchestrator failed to start; /api/converse will return 503:", e));
});
