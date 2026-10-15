import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SNSClient } from "@aws-sdk/client-sns";
import { CareService, MemoryAdapter, createSeed, type StorageAdapter } from "open-caregiver-mcp";
import { ConsoleNotifier, SnsNotifier } from "./adapters/sns.js";
import { DynamoStorage } from "./adapters/dynamoStorage.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { BedrockLlm } from "./orchestrator/bedrock.js";
import { Orchestrator } from "./orchestrator/index.js";
import { McpToolClient } from "./orchestrator/mcpClient.js";
import { MockLlm } from "./orchestrator/mock.js";

const cfg = loadConfig();

let storage: StorageAdapter;
if (cfg.storage === "dynamo") {
  const ddb = new DynamoStorage(new DynamoDBClient({ region: cfg.region, endpoint: cfg.ddbEndpoint, ...(cfg.ddbEndpoint ? { credentials: { accessKeyId: "local", secretAccessKey: "local" } } : {}) }), cfg.table);
  await ddb.ensureTable();
  if ((await ddb.listPatients()).length === 0) await ddb.reset(createSeed(Date.now()));
  storage = ddb;
} else {
  storage = new MemoryAdapter(createSeed(Date.now()));
}

const notifier = cfg.snsTopicArn ? new SnsNotifier(new SNSClient({ region: cfg.region }), cfg.snsTopicArn) : new ConsoleNotifier();
const service = new CareService(storage, { notifier });
// The orchestrator reaches the MCP server over a real HTTP hop, so it connects after we are listening.
const mcpClient = new McpToolClient();
const llm = cfg.llmMode === "bedrock" ? new BedrockLlm({ region: cfg.region, modelId: cfg.bedrockModelId }) : new MockLlm();
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
