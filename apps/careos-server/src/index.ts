import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SNSClient } from "@aws-sdk/client-sns";
import { CareService, MemoryAdapter, createSeed, type StorageAdapter } from "open-caregiver-mcp";
import { ConsoleNotifier, SnsNotifier } from "./adapters/sns.js";
import { DynamoStorage } from "./adapters/dynamoStorage.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

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
const { app } = createApp({ service, storage, allowedOrigin: cfg.allowedOrigin, sseHeartbeatMs: cfg.sseHeartbeatMs });

app.listen(cfg.port, cfg.host, () => {
  console.error(`careos-server ${cfg.host}:${cfg.port}  storage=${cfg.storage}  alerts=${cfg.snsTopicArn ? "sns" : "console"}  mcp=/mcp`);
});
