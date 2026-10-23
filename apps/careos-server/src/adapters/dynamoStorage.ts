import {
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
  TransactionCanceledException,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  checkInterval,
  type AdviceMemory,
  type AuditEntry,
  type Observation,
  type ObservationType,
  type Cart,
  type CartStatus,
  type Episode,
  type Prescription,
  type Caregiver,
  type CommitDoseArgs,
  type CommitResult,
  type DoseEvent,
  type InventoryItem,
  type Patient,
  type SeedData,
  type StorageAdapter,
  type StorageRoot,
  DEFAULT_HOUSEHOLD_ID,
} from "open-caregiver-mcp";

/**
 * Single-table design. Every PK is prefixed `H#<householdId>#` (omitted below) for tenant isolation:
 *   HOUSEHOLD   | PATIENT#id               index row: lists the household's people with a Query (never a table Scan)
 *   PATIENT#id  | PROFILE                 patient profile
 *   PATIENT#id  | EVENT#<at>#<eventId>    administration ledger
 *   PATIENT#id  | LOCK#<ingredient>       optimistic-concurrency token + nextEligibleAt
 *   PATIENT#id  | OBS#<type>#<at>#<id>    observations (weight, temperature, ...)
 *   PATIENT#id  | EP#<id>                 illness episode
 *   PATIENT#id  | RX#<id>                 prescription (PENDING until a person confirms)
 *   AUDIT       | <at>#<id>               append-only safety audit log
 *   ADVICE      | ADVICE#<id>             remembered advice (Memory Conflict Guard)
 *   HOUSEHOLD   | CAREGIVER#id, INVENTORY#id
 *   IDEMP#key   | IDEMP                   idempotency record -> event key
 *   CART#id     | CART                 simulated Amazon cart / order (status moves by conditional update)
 *   HOUSEHOLD   | CARTIDX#<createdAt>#id  index row so carts can be listed newest first
 *
 * commitDose is one TransactWriteItems: lock (version-checked) + event + idempotency
 * record + inventory decrement (remaining >= :v). If another caregiver wrote first the
 * lock version has moved, the transaction is cancelled, and we re-read and re-decide.
 */
type Item = Record<string, unknown>;
const MAX_ATTEMPTS = 6;
const H = 3_600_000;

const eventSk = (e: DoseEvent) => `EVENT#${String(e.at).padStart(15, "0")}#${e.eventId}`;
const strip = <T>(item: Item | undefined): T | undefined => {
  if (!item) return undefined;
  const { PK: _pk, SK: _sk, ...rest } = item;
  return rest as T;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DynamoStorage implements StorageAdapter {
  private doc: DynamoDBDocumentClient;

  /** Every partition key starts with this, so a household's rows are unreachable from any other household. */
  private readonly prefix: string;

  constructor(private client: DynamoDBClient, private table = "careos", readonly householdId = DEFAULT_HOUSEHOLD_ID) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
    this.prefix = `H#${householdId}#`;
  }

  private pk(patientId: string) { return `${this.prefix}PATIENT#${patientId}`; }
  private get hh() { return `${this.prefix}HOUSEHOLD`; }
  private idemPk(key: string) { return `${this.prefix}IDEMP#${key}`; }
  private cartPk(id: string) { return `${this.prefix}CART#${id}`; }
  /** Index key: newest first when read backwards. The timestamp is zero-padded so it sorts as text. */
  private cartIdx(c: Cart) { return `CARTIDX#${String(c.createdAt).padStart(15, "0")}#${c.cartId}`; }
  private get auditPk() { return `${this.prefix}AUDIT`; }
  private get advicePk() { return `${this.prefix}ADVICE`; }

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

  async getPatient(id: string) { return strip<Patient>(await this.get(this.pk(id), "PROFILE")); }

  /**
   * Reads the household's patient index (one small row per person in the household partition), then each profile. The first
   * version scanned the whole table with a filter: Scan only looks at 1 MB per page, so on a busy table the household's rows
   * fell outside the first page and people silently vanished. A Query on the household partition cannot do that.
   */
  async listPatients(): Promise<Patient[]> {
    const idx = await this.query(this.hh, "PATIENT#");
    const profiles = await Promise.all(idx.map((i) => this.get(this.pk(String(i.id)), "PROFILE")));
    return profiles.filter((p): p is Item => p !== undefined).map((p) => strip<Patient>(p)!);
  }

  async getCaregivers() { return (await this.query(this.hh, "CAREGIVER#")).map((i) => strip<Caregiver>(i)!); }
  async getInventory() { return (await this.query(this.hh, "INVENTORY#")).map((i) => strip<InventoryItem>(i)!); }
  async getLedger(patientId: string) { return (await this.query(this.pk(patientId), "EVENT#")).map((i) => strip<DoseEvent>(i)!); }

  async getEventByKey(key: string): Promise<DoseEvent | undefined> {
    const idem = await this.get(this.idemPk(key), "IDEMP");
    if (!idem) return undefined;
    return strip<DoseEvent>(await this.get(idem.eventPK as string, idem.eventSK as string));
  }

  async addObservation(o: Observation) {
    const sk = `OBS#${o.type}#${String(o.at).padStart(15, "0")}#${o.id}`;
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { PK: this.pk(o.patientId), SK: sk, ...o } }));
  }
  async getObservations(patientId: string, type?: ObservationType) {
    const rows = await this.query(this.pk(patientId), type ? `OBS#${type}#` : "OBS#");
    return rows.map((i) => strip<Observation>(i)!).sort((a, b) => a.at - b.at);
  }
  async setPatientWeight(patientId: string, weightLbs: number, at: number) {
    await this.doc.send(new UpdateCommand({
      TableName: this.table,
      Key: { PK: this.pk(patientId), SK: "PROFILE" },
      UpdateExpression: "SET weightLbs = :w, weightAt = :a",
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeValues: { ":w": weightLbs, ":a": at },
    }));
  }
  async appendAudit(e: AuditEntry) {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { PK: this.auditPk, SK: `${String(e.at).padStart(15, "0")}#${e.id}`, ...e } }));
  }
  async getAudit(limit = 100) {
    const r = await this.doc.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": this.auditPk },
      ScanIndexForward: false,
      Limit: limit,
      ConsistentRead: true,
    }));
    return (r.Items ?? []).map((i) => strip<AuditEntry>(i)!);
  }
  async getAdvice(patientId?: string) {
    const all = (await this.query(this.advicePk, "ADVICE#")).map((i) => strip<AdviceMemory>(i)!);
    return patientId === undefined ? all : all.filter((a) => a.patientId === patientId);
  }

  async getEpisodes(patientId?: string): Promise<Episode[]> {
    const pids = patientId ? [patientId] : (await this.listPatients()).map((p) => p.id);
    const rows = (await Promise.all(pids.map((id) => this.query(this.pk(id), "EP#")))).flat();
    return rows.map((i) => strip<Episode>(i)!).sort((a, b) => b.openedAt - a.openedAt);
  }
  async saveEpisode(e: Episode) { await this.doc.send(new PutCommand({ TableName: this.table, Item: { PK: this.pk(e.patientId), SK: `EP#${e.id}`, ...e } })); }
  async getPrescriptions(patientId?: string): Promise<Prescription[]> {
    const pids = patientId ? [patientId] : (await this.listPatients()).map((p) => p.id);
    const rows = (await Promise.all(pids.map((id) => this.query(this.pk(id), "RX#")))).flat();
    return rows.map((i) => strip<Prescription>(i)!).sort((a, b) => a.createdAt - b.createdAt);
  }
  async savePrescription(r: Prescription) { await this.doc.send(new PutCommand({ TableName: this.table, Item: { PK: this.pk(r.patientId), SK: `RX#${r.id}`, ...r } })); }
  async deletePrescription(id: string) {
    const found = (await this.getPrescriptions()).find((r) => r.id === id);
    if (found) await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { PK: this.pk(found.patientId), SK: `RX#${id}` } }));
  }
  async setActiveRx(patientId: string, activeRx: string[]) {
    await this.doc.send(new UpdateCommand({ TableName: this.table, Key: { PK: this.pk(patientId), SK: "PROFILE" }, UpdateExpression: "SET activeRx = :r", ConditionExpression: "attribute_exists(PK)", ExpressionAttributeValues: { ":r": activeRx } }));
  }
  /** Deletes the patient's partition (profile, doses, locks, observations, episodes, prescriptions), the idempotency records of their doses, and their remembered advice. */
  async deletePatient(patientId: string) {
    const ledger = await this.getLedger(patientId);
    const advice = (await this.query(this.advicePk, "ADVICE#")).filter((a) => a.patientId === patientId);
    const part: { PK: string; SK: string }[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(new QueryCommand({ TableName: this.table, KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": this.pk(patientId) }, ProjectionExpression: "PK, SK", ExclusiveStartKey: start, ConsistentRead: true }));
      part.push(...((r.Items ?? []) as { PK: string; SK: string }[]));
      start = r.LastEvaluatedKey;
    } while (start);
    const keys = [
      ...part,
      { PK: this.hh, SK: `PATIENT#${patientId}` },
      ...ledger.map((e) => ({ PK: this.idemPk(e.idempotencyKey), SK: "IDEMP" })),
      ...advice.map((a) => ({ PK: this.advicePk, SK: `ADVICE#${String(a.id)}` })),
    ];
    await this.batch(keys.map((Key) => ({ DeleteRequest: { Key } })));
  }

  async saveCart(cart: Cart) {
    await this.doc.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: this.table, Item: { PK: this.cartPk(cart.cartId), SK: "CART", ...cart } } },
        { Put: { TableName: this.table, Item: { PK: this.hh, SK: this.cartIdx(cart), cartId: cart.cartId } } },
      ],
    }));
  }
  async getCart(id: string) { return strip<Cart>(await this.get(this.cartPk(id), "CART")); }
  async listCarts(limit = 50): Promise<Cart[]> {
    const idx = await this.doc.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :p)",
      ExpressionAttributeValues: { ":pk": this.hh, ":p": "CARTIDX#" },
      ScanIndexForward: false,
      Limit: limit,
      ConsistentRead: true,
    }));
    const carts = await Promise.all((idx.Items ?? []).map((i) => this.getCart(String(i.cartId))));
    return carts.filter((c): c is Cart => c !== undefined);
  }

  /** Conditional update: the status check and the write are one atomic DynamoDB operation. */
  async transitionCart(cartId: string, from: CartStatus[], patch: Partial<Omit<Cart, "cartId">>): Promise<Cart | undefined> {
    const names: Record<string, string> = { "#st": "status" };
    const values: Record<string, unknown> = {};
    const sets: string[] = [];
    Object.entries(patch).forEach(([k, v], i) => {
      if (v === undefined) return;
      names[`#f${i}`] = k;
      values[`:v${i}`] = v;
      sets.push(`#f${i} = :v${i}`);
    });
    from.forEach((f, i) => { values[`:from${i}`] = f; });
    try {
      const r = await this.doc.send(new UpdateCommand({
        TableName: this.table,
        Key: { PK: this.cartPk(cartId), SK: "CART" },
        UpdateExpression: sets.length ? `SET ${sets.join(", ")}` : "SET #st = #st",
        ConditionExpression: `attribute_exists(PK) AND #st IN (${from.map((_, i) => `:from${i}`).join(", ")})`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      }));
      return strip<Cart>(r.Attributes);
    } catch (e) {
      if ((e as { name?: string }).name === "ConditionalCheckFailedException") return undefined;
      throw e;
    }
  }

  /** Server-side `remaining = remaining + :d`: atomic under any amount of contention. A decrease that would go below zero floors at zero. */
  async addInventory(itemId: string, delta: number): Promise<number | undefined> {
    const Key = { PK: this.hh, SK: `INVENTORY#${itemId}` };
    const bump = async (condition: string, values: Record<string, unknown>) => {
      try {
        const r = await this.doc.send(new UpdateCommand({ TableName: this.table, Key, UpdateExpression: "SET remaining = remaining + :d", ConditionExpression: condition, ExpressionAttributeValues: { ":d": delta, ...values }, ReturnValues: "UPDATED_NEW" }));
        return { ok: true as const, value: Math.round(Number(r.Attributes?.remaining) * 1000) / 1000 };
      } catch (e) {
        if ((e as { name?: string }).name === "ConditionalCheckFailedException") return { ok: false as const };
        throw e;
      }
    };
    const done = delta >= 0 ? await bump("attribute_exists(PK)", {}) : await bump("attribute_exists(PK) AND remaining >= :need", { ":need": -delta });
    if (done.ok) return done.value;
    if (delta >= 0 || !(await this.get(Key.PK, Key.SK))) return undefined; // unknown item
    await this.doc.send(new UpdateCommand({ TableName: this.table, Key, UpdateExpression: "SET remaining = :z", ConditionExpression: "attribute_exists(PK)", ExpressionAttributeValues: { ":z": 0 } }));
    return 0;
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
      const lock = await this.get(this.pk(event.patientId), lockSk);
      const [ledger, inv] = await Promise.all([
        this.getLedger(event.patientId),
        a.inventoryItemId ? this.get(this.hh, `INVENTORY#${a.inventoryItemId}`) : Promise.resolve(undefined),
      ]);
      const interval = checkInterval(ledger, event.ingredient, a.rule, a.now);
      if (interval.status === "DAILY_MAX_REACHED" || interval.status === "DOUBLE_DOSE_LOCKED") {
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
            Item: { PK: this.pk(event.patientId), SK: lockSk, ingredient: event.ingredient, version: version + 1, nextEligibleAt: event.at + a.rule.minIntervalHours * H, lastEventId: event.eventId },
            ...(lock ? { ConditionExpression: "#v = :v", ExpressionAttributeNames: { "#v": "version" }, ExpressionAttributeValues: { ":v": version } } : { ConditionExpression: "attribute_not_exists(PK)" }),
          },
        },
        { Put: { TableName: this.table, Item: { PK: this.pk(event.patientId), SK: evSk, ...event }, ConditionExpression: "attribute_not_exists(PK)" } },
        {
          Put: {
            TableName: this.table,
            Item: { PK: this.idemPk(event.idempotencyKey), SK: "IDEMP", eventPK: this.pk(event.patientId), eventSK: evSk, ttl: Math.ceil(event.at / 1000) + 7 * 86_400 },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
      ];
      if (decrement) {
        items.push({
          Update: {
            TableName: this.table,
            Key: { PK: this.hh, SK: `INVENTORY#${a.inventoryItemId}` },
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

      const after = a.inventoryItemId ? (strip<InventoryItem>(await this.get(this.hh, `INVENTORY#${a.inventoryItemId}`))) : undefined;
      return { ok: true, event, inventoryRemaining: after?.remaining, lowStock: after ? after.remaining < after.lowThreshold : false, replay: false };
    }
    throw new Error("commitDose: too much contention, giving up");
  }

  private async replay(event: DoseEvent, inventoryItemId?: string): Promise<CommitResult> {
    const item = inventoryItemId ? strip<InventoryItem>(await this.get(this.hh, `INVENTORY#${inventoryItemId}`)) : undefined;
    return { ok: true, event, inventoryRemaining: item?.remaining, lowStock: item ? item.remaining < item.lowThreshold : false, replay: true };
  }

  // ------------------------------------------------------------------ reset
  async reset(seed: SeedData): Promise<void> {
    const keys: { PK: string; SK: string }[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(new ScanCommand({ TableName: this.table, ProjectionExpression: "PK, SK", FilterExpression: "begins_with(PK, :h)", ExpressionAttributeValues: { ":h": this.prefix }, ExclusiveStartKey: start }));
      keys.push(...((r.Items ?? []) as { PK: string; SK: string }[]));
      start = r.LastEvaluatedKey;
    } while (start);
    await this.batch(keys.map((Key) => ({ DeleteRequest: { Key } })));

    const puts: Item[] = [
      ...seed.patients.map((p) => ({ PK: this.pk(p.id), SK: "PROFILE", ...p })),
      ...seed.patients.map((p) => ({ PK: this.hh, SK: `PATIENT#${p.id}`, id: p.id })),
      ...seed.caregivers.map((c) => ({ PK: this.hh, SK: `CAREGIVER#${c.id}`, ...c })),
      ...seed.inventory.map((i) => ({ PK: this.hh, SK: `INVENTORY#${i.id}`, ...i })),
      ...seed.observations.map((o) => ({ PK: this.pk(o.patientId), SK: `OBS#${o.type}#${String(o.at).padStart(15, "0")}#${o.id}`, ...o })),
      ...seed.advice.map((a) => ({ PK: this.advicePk, SK: `ADVICE#${a.id}`, ...a })),
      ...seed.ledger.flatMap((e) => [
        { PK: this.pk(e.patientId), SK: eventSk(e), ...e },
        { PK: this.idemPk(e.idempotencyKey), SK: "IDEMP", eventPK: this.pk(e.patientId), eventSK: eventSk(e) },
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

/** Multi-tenant entry point: one table, one DynamoStorage per household. */
export class DynamoRoot implements StorageRoot {
  constructor(private client: DynamoDBClient, private table = "careos") {}

  /** Table creation does not depend on a household. */
  ensureTable(): Promise<void> {
    return new DynamoStorage(this.client, this.table).ensureTable();
  }

  forHousehold(householdId: string): DynamoStorage {
    return new DynamoStorage(this.client, this.table, householdId);
  }
}
