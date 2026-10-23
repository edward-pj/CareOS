import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Executes scripts/supabase-schema.sql against a real Postgres (PGlite, in-process) so the SQL we ask people to paste
// into the Supabase editor is known to parse, to be re-runnable, and to implement commit_dose as specified.
// (True multi-connection concurrency is covered by the opt-in live test in supabase.test.ts.)

const schema = readFileSync(fileURLToPath(new URL("../../../scripts/supabase-schema.sql", import.meta.url)), "utf8");
const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 15, 23, 10);

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  // Supabase provides these; a bare Postgres does not.
  await pg.exec(`create role service_role; create role anon; create role authenticated; create publication supabase_realtime;`);
  await pg.exec(schema);
  await pg.exec(schema); // re-runnable: second run must be a no-op, not an error
});
afterAll(async () => { await pg.close(); });

async function household(id: string, motrinMl = 30) {
  await pg.query(`insert into households (id, name) values ($1, $1)`, [id]);
  await pg.query(`insert into patients (household_id, id, name, kind, dob_ms) values ($1, 'leo', 'Leo', 'infant', 0), ($1, 'frank', 'Frank', 'elder', 0)`, [id]);
  await pg.query(`insert into inventory (household_id, id, name, ingredient, sku, unit, remaining, low_threshold) values ($1, 'motrin', 'Motrin', 'ibuprofen', 'infants_motrin_drops', 'mL', $2, 4)`, [id, motrinMl]);
}

async function commit(hid: string, key: string, at: number, volumeMl = 1.875, opts: { now?: number; patient?: string } = {}) {
  const event = { event_id: `ev-${key}`, patient_id: opts.patient ?? "leo", at, caregiver: "Sarah (Mom)", medication: "Infants' Motrin drops", ingredient: "ibuprofen", volume_ml: volumeMl, temperature_f: null, idempotency_key: key, sku: "infants_motrin_drops", amount_mg: volumeMl * 40 };
  const r = await pg.query<{ r: { status: string; inventory_remaining?: number } }>(`select commit_dose($1, $2::jsonb, 6, 4, 'motrin', $3) as r`, [hid, JSON.stringify(event), opts.now ?? at]);
  return r.rows[0]!.r;
}
const count = async (table: string, hid: string) => Number((await pg.query<{ n: string }>(`select count(*) as n from ${table} where household_id = $1`, [hid])).rows[0]!.n);
const remaining = async (hid: string) => Number((await pg.query<{ remaining: string }>(`select remaining from inventory where household_id = $1 and id = 'motrin'`, [hid])).rows[0]!.remaining);

describe("supabase-schema.sql: commit_dose", () => {
  it("commits ledger row, lock row and inventory decrement together, keeping sku and amount_mg", async () => {
    await household("h-ok");
    expect(await commit("h-ok", "k1", NOW)).toEqual({ status: "OK", inventory_remaining: 28.125 });
    expect(await count("dose_ledger", "h-ok")).toBe(1);
    expect(await count("dose_locks", "h-ok")).toBe(1);
    expect(await remaining("h-ok")).toBe(28.125);
    const row = (await pg.query<{ sku: string; amount_mg: string }>(`select sku, amount_mg from dose_ledger where household_id = 'h-ok'`)).rows[0]!;
    expect(row.sku).toBe("infants_motrin_drops");
    expect(Number(row.amount_mg)).toBe(75);
    const lock = (await pg.query<{ next_allowed_at: string }>(`select next_allowed_at from dose_locks where household_id = 'h-ok'`)).rows[0]!;
    expect(Number(lock.next_allowed_at)).toBe(NOW + 6 * H);
  });

  it("refuses a second dose inside the interval and writes nothing", async () => {
    await household("h-lock");
    await commit("h-lock", "k1", NOW);
    expect((await commit("h-lock", "k2", NOW + 18 * 60_000)).status).toBe("LOCKED");
    expect(await count("dose_ledger", "h-lock")).toBe(1);
    expect(await remaining("h-lock")).toBe(28.125);
  });

  it("unlocks exactly when the interval ends", async () => {
    await household("h-edge");
    await commit("h-edge", "k1", NOW);
    expect((await commit("h-edge", "k2", NOW + 6 * H - 1)).status).toBe("LOCKED");
    expect((await commit("h-edge", "k3", NOW + 6 * H)).status).toBe("OK");
  });

  it("replays an identical idempotency key without a second write", async () => {
    await household("h-idem");
    await commit("h-idem", "same", NOW);
    expect((await commit("h-idem", "same", NOW + 1000)).status).toBe("REPLAY");
    expect(await count("dose_ledger", "h-idem")).toBe(1);
  });

  it("enforces the daily maximum", async () => {
    await household("h-max");
    for (let i = 0; i < 4; i++) expect((await commit("h-max", `d${i}`, NOW + i * 6 * H)).status).toBe("OK");
    expect((await commit("h-max", "extra", NOW + 23 * H)).status).toBe("DAILY_MAX");
  });

  it("rejects a dose larger than the bottle", async () => {
    await household("h-stock", 1);
    expect((await commit("h-stock", "k1", NOW, 1.875)).status).toBe("INSUFFICIENT_STOCK");
    expect(await count("dose_ledger", "h-stock")).toBe(0);
    expect(await remaining("h-stock")).toBe(1);
  });

  it("keeps households apart: the same key and the same patient in two households do not interact", async () => {
    await household("h-a");
    await household("h-b");
    await commit("h-a", "shared", NOW);
    expect((await commit("h-b", "shared", NOW + 60_000)).status).toBe("OK");
    expect(await count("dose_ledger", "h-a")).toBe(1);
    expect(await count("dose_ledger", "h-b")).toBe(1);
  });

  it("is not executable by the anonymous or authenticated roles", async () => {
    const r = await pg.query<{ anon: boolean; auth: boolean; svc: boolean }>(
      `select has_function_privilege('anon', 'commit_dose(text,jsonb,numeric,int,text,bigint)', 'execute') as anon,
              has_function_privilege('authenticated', 'commit_dose(text,jsonb,numeric,int,text,bigint)', 'execute') as auth,
              has_function_privilege('service_role', 'commit_dose(text,jsonb,numeric,int,text,bigint)', 'execute') as svc`,
    );
    expect(r.rows[0]).toEqual({ anon: false, auth: false, svc: true });
  });

  it("has row level security on every table", async () => {
    const r = await pg.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(r.rows).toEqual([]);
  });
});

describe("supabase-schema.sql: audit_log is append-only", () => {
  it("accepts inserts, refuses UPDATE and direct DELETE, and still cascades when a household is removed", async () => {
    await household("h-audit");
    await pg.query(`insert into audit_log (household_id, id, at, tool, patient_id, input_hash, verdict, reason_codes) values ('h-audit', 'a1', $1, 'plan_medication', 'leo', 'abc', 'APPROVED', '["LABEL_BAND_18_23LB"]'::jsonb)`, [NOW]);
    expect(await count("audit_log", "h-audit")).toBe(1);
    await expect(pg.query(`update audit_log set verdict = 'BLOCKED' where household_id = 'h-audit'`)).rejects.toThrow(/append-only/);
    await expect(pg.query(`delete from audit_log where household_id = 'h-audit'`)).rejects.toThrow(/append-only/);
    expect(await count("audit_log", "h-audit")).toBe(1);
    await pg.query(`delete from households where id = 'h-audit'`);
    expect(await count("audit_log", "h-audit")).toBe(0);
  });
});

describe("supabase-schema.sql: carts and add_inventory", () => {
  const cart = (hid: string, id: string, status: string) =>
    pg.query(`insert into carts (household_id, cart_id, lines, total_usd, eta, status, created_at_ms) values ($1, $2, '[]'::jsonb, 11.48, 'Tomorrow', $3, 1)`, [hid, id, status]);

  it("accepts the four order statuses and refuses anything else", async () => {
    await household("h-cart");
    for (const [i, s] of ["STAGED", "ORDERED", "DELIVERED", "CANCELLED"].entries()) await cart("h-cart", `c${i}`, s);
    await expect(cart("h-cart", "bad", "SHIPPED")).rejects.toThrow();
  });

  it("a conditional status update moves a cart once (the compare-and-set the server relies on)", async () => {
    await household("h-cas");
    await cart("h-cas", "c1", "STAGED");
    const move = () => pg.query(`update carts set status = 'ORDERED', order_id = 'ord' where household_id = 'h-cas' and cart_id = 'c1' and status = any(array['STAGED']) returning cart_id`);
    expect((await move()).rows.length).toBe(1);
    expect((await move()).rows.length).toBe(0);
  });

  it("add_inventory adds, floors at zero, returns NULL for unknown items and stays inside one household", async () => {
    await household("h-inv-a", 10);
    await household("h-inv-b", 10);
    const add = async (h: string, item: string, d: number) => (await pg.query<{ v: string | null }>(`select add_inventory($1, $2, $3) as v`, [h, item, d])).rows[0]!.v;
    expect(Number(await add("h-inv-a", "motrin", 15))).toBe(25);
    expect(Number(await add("h-inv-a", "motrin", 0.0004))).toBe(25);
    expect(Number(await add("h-inv-a", "motrin", -1000))).toBe(0);
    expect(await add("h-inv-a", "nope", 1)).toBeNull();
    expect(await remaining("h-inv-b")).toBe(10);
    await Promise.all(Array.from({ length: 10 }, () => add("h-inv-b", "motrin", 1.5)));
    expect(await remaining("h-inv-b")).toBe(25);
  });

  it("upgrades a v1 carts table in place: old rows survive and the new statuses become legal", async () => {
    const old = new PGlite();
    await old.exec(`create role service_role; create role anon; create role authenticated; create publication supabase_realtime;`);
    await old.exec(schema);
    await old.exec(`drop table carts;`);
    await old.exec(`create table carts (household_id text not null references households(id) on delete cascade, cart_id text not null, lines jsonb not null, total_usd numeric not null, eta text not null, status text not null check (status in ('STAGED', 'ORDERED')), order_id text, created_at timestamptz not null default now(), primary key (household_id, cart_id));`);
    await old.query(`insert into households (id, name) values ('h-old', 'h-old')`);
    await old.query(`insert into carts (household_id, cart_id, lines, total_usd, eta, status, order_id) values ('h-old', 'legacy', '[]', 41.29, 'Tomorrow', 'ORDERED', 'ord_1')`);
    await old.exec(schema);
    const legacy = (await old.query<{ status: string; created_at_ms: string }>(`select status, created_at_ms from carts where cart_id = 'legacy'`)).rows[0]!;
    expect(legacy.status).toBe("ORDERED");
    expect(Number(legacy.created_at_ms)).toBe(0);
    await old.query(`update carts set status = 'DELIVERED' where cart_id = 'legacy'`);
    await old.close();
  });
});

describe("supabase-schema.sql: episodes and prescriptions", () => {
  it("accept their statuses, refuse others, and are removed with the patient (privacy delete)", async () => {
    await household("h-priv");
    await pg.query(`insert into episodes (household_id, id, patient_id, status, opened_at, data) values ('h-priv', 'e1', 'leo', 'OPEN', 1, '{}'::jsonb)`);
    await pg.query(`insert into prescriptions (household_id, id, patient_id, status, created_at_ms, data) values ('h-priv', 'r1', 'leo', 'PENDING', 1, '{}'::jsonb), ('h-priv', 'r2', 'frank', 'ACTIVE', 1, '{}'::jsonb)`);
    await expect(pg.query(`insert into episodes (household_id, id, patient_id, status, opened_at, data) values ('h-priv', 'e2', 'leo', 'PAUSED', 1, '{}'::jsonb)`)).rejects.toThrow();
    await expect(pg.query(`insert into prescriptions (household_id, id, patient_id, status, created_at_ms, data) values ('h-priv', 'r3', 'leo', 'MAYBE', 1, '{}'::jsonb)`)).rejects.toThrow();
    await commit("h-priv", "k-priv", NOW);
    await pg.query(`insert into observations (household_id, id, patient_id, type, value, unit, at, source) values ('h-priv', 'o1', 'leo', 'temperature', 101, 'F', 1, 'x')`);
    await pg.query(`delete from patients where household_id = 'h-priv' and id = 'leo'`);
    expect(await count("episodes", "h-priv")).toBe(0);
    expect(await count("dose_ledger", "h-priv")).toBe(0);
    expect(await count("dose_locks", "h-priv")).toBe(0);
    expect(await count("observations", "h-priv")).toBe(0);
    expect((await pg.query<{ id: string }>(`select id from prescriptions where household_id = 'h-priv'`)).rows.map((r) => r.id)).toEqual(["r2"]);
    expect(await count("inventory", "h-priv")).toBe(1);
  });
});
