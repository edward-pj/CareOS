import {
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
  TransactionCanceledException,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  checkInterval,
  type Cart,
  type Caregiver,
  type CommitDoseArgs,
  type CommitResult,
  type DoseEvent,
  type InventoryItem,
  type Patient,
  type SeedData,
  type StorageAdapter,
} from "open-caregiver-mcp";

/**
 * Single-table design:
 *   PATIENT#id  | PROFILE                 patient profile
 *   PATIENT#id  | EVENT#<at>#<eventId>    administration ledger
 *   PATIENT#id  | LOCK#<ingredient>       optimistic-concurrency token + nextEligibleAt
 *   PATIENT#id  | OVERRIDE#<ingredient>   PIN override window
 *   HOUSEHOLD   | CAREGIVER#id, INVENTORY#id
 *   IDEMP#key   | IDEMP                   idempotency record -> event key
 *   CART#id     | CART
 *
 * commitDose is one TransactWriteItems: lock (version-checked) + event + idempotency
 * record + inventory decrement (remaining >= :v). If another caregiver wrote first the
 * lock version has moved, the transaction is cancelled, and we re-read and re-decide.
 */
type Item = Record<string, unknown>;
const MAX_ATTEMPTS = 6;
const H = 3_600_000;

const pk = (id: string) => `PATIENT#${id}`;
const eventSk = (e: DoseEvent) => `EVENT#${String(e.at).padStart(15, "0")}#${e.eventId}`;
const strip = <T>(item: Item | undefined): T | undefined => {
  if (!item) return undefined;
  const { PK: _pk, SK: _sk, ...rest } = item;
  return rest as T;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DynamoStorage implements StorageAdapter {
  private doc: DynamoDBDocumentClient;

  constructor(private client: DynamoDBClient, private table = "careos") {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async ensureTable(): Promise<void> {
    const client = this.client;
    try {
      await client.send(new DescribeTableCommand({ TableName: this.table }));
      return;
    } catch (e) {
      if (!(e instanceof ResourceNotFoundException)) throw e;
    }
    await client.send(
      new CreateTableCommand({
        TableName: this.table,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
      }),
    );
    for (let i = 0; i < 50; i++) {
      const d = await client.send(new DescribeTableCommand({ TableName: this.table }));
      if (d.Table?.TableStatus === "ACTIVE") return;
      await sleep(200);
    }
    throw new Error(`Table ${this.table} did not become ACTIVE`);
  }

  // ------------------------------------------------------------------ reads
  private async get(PK: string, SK: string, consistent = true): Promise<Item | undefined> {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: { PK, SK }, ConsistentRead: consistent }));
    return r.Item;
  }

  private async query(PK: string, prefix: string): Promise<Item[]> {
    const out: Item[] = [];
    let key: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :p)",
          ExpressionAttributeValues: { ":pk": PK, ":p": prefix },
          ConsistentRead: true,
          ExclusiveStartKey: key,
        }),
      );
      out.push(...(r.Items ?? []));
      key = r.LastEvaluatedKey;
    } while (key);
    return out;
  }

  async getPatient(id: string) { return strip<Patient>(await this.get(pk(id), "PROFILE")); }

  async listPatients(): Promise<Patient[]> {
    // Two patients: a filtered scan is fine here. A GSI on SK would replace it at scale.
    const r = await this.doc.send(new ScanCommand({ TableName: this.table, FilterExpression: "SK = :s", ExpressionAttributeValues: { ":s": "PROFILE" } }));
    return (r.Items ?? []).map((i) => strip<Patient>(i)!);
  }

  async getCaregivers() { return (await this.query("HOUSEHOLD", "CAREGIVER#")).map((i) => strip<Caregiver>(i)!); }
  async getInventory() { return (await this.query("HOUSEHOLD", "INVENTORY#")).map((i) => strip<InventoryItem>(i)!); }
  async getLedger(patientId: string) { return (await this.query(pk(patientId), "EVENT#")).map((i) => strip<DoseEvent>(i)!); }

  async getEventByKey(key: string): Promise<DoseEvent | undefined> {
    const idem = await this.get(`IDEMP#${key}`, "IDEMP");
    if (!idem) return undefined;
    return strip<DoseEvent>(await this.get(idem.eventPK as string, idem.eventSK as string));
  }

  async saveCart(cart: Cart) { await this.doc.send(new PutCommand({ TableName: this.table, Item: { PK: `CART#${cart.cartId}`, SK: "CART", ...cart } })); }
  async getCart(id: string) { return strip<Cart>(await this.get(`CART#${id}`, "CART")); }

  async setOverride(patientId: string, ingredient: string, expiresAt: number) {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { PK: pk(patientId), SK: `OVERRIDE#${ingredient}`, expiresAt, ttl: Math.ceil(expiresAt / 1000) + 3600 } }));
  }
  async getOverride(patientId: string, ingredient: string) {
    return (await this.get(pk(patientId), `OVERRIDE#${ingredient}`))?.expiresAt as number | undefined;
  }

  // ----------------------------------------------------------------- commit
  async commitDose(a: CommitDoseArgs): Promise<CommitResult> {
    const { event } = a;
    const lockSk = `LOCK#${event.ingredient}`;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const prior = await this.getEventByKey(event.idempotencyKey);
      if (prior) return this.replay(prior, a.inventoryItemId);

      // Order matters: read the lock BEFORE the ledger. A writer that commits after this lock
      // read bumps the version, so our transaction is cancelled; one that committed before it
      // is guaranteed to be visible in the ledger read below. Reading them in parallel would
      // let a commit land between the two reads and pass the version check on a stale ledger.
      const lock = await this.get(pk(event.patientId), lockSk);
      const [ledger, inv] = await Promise.all([
        this.getLedger(event.patientId),
        a.inventoryItemId ? this.get("HOUSEHOLD", `INVENTORY#${a.inventoryItemId}`) : Promise.resolve(undefined),
      ]);
      const interval = checkInterval(ledger, event.ingredient, a.rule, a.now);
      if (interval.status === "DAILY_MAX_REACHED" || (interval.status === "DOUBLE_DOSE_LOCKED" && !a.bypassLock)) {
        // The lock we see may be the one this very request's sibling just created.
        const sibling = await this.getEventByKey(event.idempotencyKey);
        if (sibling) return this.replay(sibling, a.inventoryItemId);
        return interval.status === "DAILY_MAX_REACHED" ? { ok: false, reason: "DAILY_MAX", interval } : { ok: false, reason: "LOCKED", interval };
      }

      const vol = event.volumeMl ?? 0;
      const decrement = inv && inv.unit === "mL" && vol > 0;
      const version = (lock?.version as number | undefined) ?? 0;
      const evSk = eventSk(event);

      const items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]> = [
        {
          Put: {
            TableName: this.table,
            Item: { PK: pk(event.patientId), SK: lockSk, ingredient: event.ingredient, version: version + 1, nextEligibleAt: event.at + a.rule.minIntervalHours * H, lastEventId: event.eventId },
            ...(lock ? { ConditionExpression: "#v = :v", ExpressionAttributeNames: { "#v": "version" }, ExpressionAttributeValues: { ":v": version } } : { ConditionExpression: "attribute_not_exists(PK)" }),
          },
        },
        { Put: { TableName: this.table, Item: { PK: pk(event.patientId), SK: evSk, ...event }, ConditionExpression: "attribute_not_exists(PK)" } },
        {
          Put: {
            TableName: this.table,
            Item: { PK: `IDEMP#${event.idempotencyKey}`, SK: "IDEMP", eventPK: pk(event.patientId), eventSK: evSk, ttl: Math.ceil(event.at / 1000) + 7 * 86_400 },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
      ];
      if (decrement) {
        items.push({
          Update: {
            TableName: this.table,
            Key: { PK: "HOUSEHOLD", SK: `INVENTORY#${a.inventoryItemId}` },
            UpdateExpression: "SET remaining = remaining - :v",
            ConditionExpression: "remaining >= :v",
            ExpressionAttributeValues: { ":v": vol },
          },
        });
      }

      try {
        await this.doc.send(new TransactWriteCommand({ TransactItems: items }));
      } catch (e) {
        if (!(e instanceof TransactionCanceledException)) throw e;
        const reasons = e.CancellationReasons ?? [];
        const code = (i: number) => reasons[i]?.Code;
        if (code(2) === "ConditionalCheckFailed") continue; // someone recorded this key: loop returns the replay
        if (decrement && code(3) === "ConditionalCheckFailed") return { ok: false, reason: "INSUFFICIENT_STOCK" };
        // Lost the race (lock version moved) or a transaction conflict: re-read and decide again.
        await sleep(15 * (attempt + 1));
        continue;
      }

      const after = a.inventoryItemId ? (strip<InventoryItem>(await this.get("HOUSEHOLD", `INVENTORY#${a.inventoryItemId}`))) : undefined;
      return { ok: true, event, inventoryRemaining: after?.remaining, lowStock: after ? after.remaining < after.lowThreshold : false, replay: false };
    }
    throw new Error("commitDose: too much contention, giving up");
  }

  private async replay(event: DoseEvent, inventoryItemId?: string): Promise<CommitResult> {
    const item = inventoryItemId ? strip<InventoryItem>(await this.get("HOUSEHOLD", `INVENTORY#${inventoryItemId}`)) : undefined;
    return { ok: true, event, inventoryRemaining: item?.remaining, lowStock: item ? item.remaining < item.lowThreshold : false, replay: true };
  }

  // ------------------------------------------------------------------ reset
  async reset(seed: SeedData): Promise<void> {
    const keys: { PK: string; SK: string }[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(new ScanCommand({ TableName: this.table, ProjectionExpression: "PK, SK", ExclusiveStartKey: start }));
      keys.push(...((r.Items ?? []) as { PK: string; SK: string }[]));
      start = r.LastEvaluatedKey;
    } while (start);
    await this.batch(keys.map((Key) => ({ DeleteRequest: { Key } })));

    const puts: Item[] = [
      ...seed.patients.map((p) => ({ PK: pk(p.id), SK: "PROFILE", ...p })),
      ...seed.caregivers.map((c) => ({ PK: "HOUSEHOLD", SK: `CAREGIVER#${c.id}`, ...c })),
      ...seed.inventory.map((i) => ({ PK: "HOUSEHOLD", SK: `INVENTORY#${i.id}`, ...i })),
      ...seed.ledger.flatMap((e) => [
        { PK: pk(e.patientId), SK: eventSk(e), ...e },
        { PK: `IDEMP#${e.idempotencyKey}`, SK: "IDEMP", eventPK: pk(e.patientId), eventSK: eventSk(e) },
      ]),
    ];
    await this.batch(puts.map((Item) => ({ PutRequest: { Item } })));
  }

  private async batch(requests: Record<string, unknown>[]): Promise<void> {
    for (let i = 0; i < requests.length; i += 25) {
      let pending: Record<string, unknown>[] | undefined = requests.slice(i, i + 25);
      for (let tries = 0; pending?.length && tries < 5; tries++) {
        const r: { UnprocessedItems?: Record<string, Record<string, unknown>[]> } = await this.doc.send(new BatchWriteCommand({ RequestItems: { [this.table]: pending as never } }));
        pending = r.UnprocessedItems?.[this.table];
        if (pending?.length) await sleep(50 * (tries + 1));
      }
    }
  }
}
