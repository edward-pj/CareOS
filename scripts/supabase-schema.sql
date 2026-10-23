-- CareOS Supabase schema (multi-household). Safe to re-run: everything is `if not exists` / `or replace`.
--
-- First time on a database that still has the v1 tables: run scripts/supabase-reset-v2.sql ONCE, then this.
-- Run in the Supabase SQL Editor: https://supabase.com/dashboard/project/_/sql
--
-- Tenancy: every row carries household_id and every primary key starts with it, so one household can never
-- read or overwrite another's rows. The server connects with the service-role (secret) key, which bypasses
-- RLS; RLS is enabled with NO policies so the public/anon key can read and write nothing (PHI-safe by default).

-- 0. Households (tenancy root)
create table if not exists households (
  id text primary key,
  name text not null default '',
  timezone text not null default 'America/Los_Angeles',
  locale text not null default 'US' check (locale in ('US', 'IN')),
  created_at timestamptz not null default now()
);

-- 1. Patients
create table if not exists patients (
  household_id text not null references households(id) on delete cascade,
  id text not null,
  name text not null,
  kind text not null check (kind in ('infant', 'elder')),
  dob_ms bigint not null,
  weight_lbs numeric,
  active_rx jsonb not null default '[]'::jsonb,
  conditions jsonb not null default '[]'::jsonb,
  allergies jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (household_id, id)
);

alter table patients add column if not exists weight_at bigint;

-- 2. Caregivers
create table if not exists caregivers (
  household_id text not null references households(id) on delete cascade,
  id text not null,
  name text not null,
  phone text,
  updated_at timestamptz not null default now(),
  primary key (household_id, id)
);

-- 3. Inventory
create table if not exists inventory (
  household_id text not null references households(id) on delete cascade,
  id text not null,
  name text not null,
  ingredient text,
  unit text not null check (unit in ('mL', 'count', 'pantry')),
  remaining numeric not null,
  low_threshold numeric not null,
  updated_at timestamptz not null default now(),
  primary key (household_id, id)
);

alter table inventory add column if not exists sku text;

-- 4. Dose ledger (append-only history; idempotency is unique per household)
create table if not exists dose_ledger (
  household_id text not null,
  event_id text not null,
  patient_id text not null,
  at bigint not null,
  caregiver text not null,
  medication text not null,
  ingredient text not null,
  volume_ml numeric,
  temperature_f numeric,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  primary key (household_id, event_id),
  unique (household_id, idempotency_key),
  foreign key (household_id, patient_id) references patients(household_id, id) on delete cascade
);

alter table dose_ledger add column if not exists sku text;
alter table dose_ledger add column if not exists amount_mg numeric;

create index if not exists idx_dose_ledger_patient on dose_ledger(household_id, patient_id, ingredient, at desc);

-- 5. Dose locks: one row per patient + active ingredient (PRD §4.5). Written by commit_dose in the same
--    transaction as the ledger row; the ledger stays the source of truth for the decision itself.
create table if not exists dose_locks (
  household_id text not null,
  patient_id text not null,
  ingredient text not null,
  next_allowed_at bigint not null,
  last_dose_id text not null,
  updated_at timestamptz not null default now(),
  primary key (household_id, patient_id, ingredient),
  foreign key (household_id, patient_id) references patients(household_id, id) on delete cascade
);

-- 6. Carts (simulated Amazon storefront): one shared cart, then orders that move through fulfilment.
-- Status moves STAGED -> ORDERED -> DELIVERED, or to CANCELLED. The server changes it with a compare-and-set
-- (UPDATE ... WHERE status IN (...)), so two caregivers ordering at once place one order.
create table if not exists carts (
  household_id text not null references households(id) on delete cascade,
  cart_id text not null,
  lines jsonb not null,
  total_usd numeric not null,
  eta text not null,
  status text not null,
  order_id text,
  created_at timestamptz not null default now(),
  primary key (household_id, cart_id)
);
alter table carts add column if not exists created_at_ms bigint not null default 0;
alter table carts add column if not exists created_by text;
alter table carts add column if not exists ordered_at_ms bigint;
alter table carts add column if not exists ordered_by text;
alter table carts add column if not exists cancelled_at_ms bigint;
alter table carts add column if not exists delivered_at_ms bigint;
alter table carts add column if not exists source text;
-- v1 only allowed STAGED / ORDERED; widen it (re-runnable).
alter table carts drop constraint if exists carts_status_check;
alter table carts add constraint carts_status_check check (status in ('STAGED', 'ORDERED', 'DELIVERED', 'CANCELLED'));

-- 7. Realtime caregiver alerts (in-app fallback while SNS is unavailable)
create table if not exists careos_alerts (
  id bigint generated always as identity primary key,
  household_id text not null references households(id) on delete cascade,
  kind text not null,
  message text not null,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'careos_alerts') then
    alter publication supabase_realtime add table careos_alerts;
  end if;
end $$;

-- 7b. Observations (weight, temperature, ...). Dosing relies on the latest WEIGHT observation and its date.
create table if not exists observations (
  household_id text not null references households(id) on delete cascade,
  id text not null,
  patient_id text not null,
  type text not null check (type in ('temperature', 'weight', 'glucose', 'blood_pressure', 'wet_diapers')),
  value numeric not null,
  unit text not null,
  at bigint not null,
  source text not null,
  primary key (household_id, id),
  foreign key (household_id, patient_id) references patients(household_id, id) on delete cascade
);
create index if not exists idx_observations_patient on observations(household_id, patient_id, type, at desc);

-- 7c. Remembered advice, re-checked against today's chart every time it is recalled (Memory Conflict Guard).
create table if not exists advice_memory (
  household_id text not null references households(id) on delete cascade,
  id text not null,
  patient_id text not null,
  topic text not null,
  advice text not null,
  drug text not null,
  given_by text not null,
  at bigint not null,
  primary key (household_id, id),
  foreign key (household_id, patient_id) references patients(household_id, id) on delete cascade
);

-- 7d. Audit log: one row per safety decision. Append-only: UPDATE is always refused, and DELETE is refused except
--     when the whole household is removed (cascade).
create table if not exists audit_log (
  household_id text not null references households(id) on delete cascade,
  id text not null,
  at bigint not null,
  tool text not null,
  patient_id text,
  caregiver text,
  input_hash text not null,
  verdict text not null,
  reason_codes jsonb not null default '[]'::jsonb,
  primary key (household_id, id)
);
create index if not exists idx_audit_log_recent on audit_log(household_id, at desc);

create or replace function audit_log_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'audit_log is append-only';
  end if;
  -- A cascade from households fires this trigger at depth 2; a direct DELETE fires it at depth 1.
  if tg_op = 'DELETE' and pg_trigger_depth() < 2 then
    raise exception 'audit_log is append-only';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists audit_log_append_only_guard on audit_log;
create trigger audit_log_append_only_guard before update or delete on audit_log
  for each row execute function audit_log_append_only();

-- 7e. Illness episodes and prescriptions. Both hang off a patient, so deleting the patient (privacy, H9) removes them.
-- `data` holds the full record; the key columns exist for lookups and for the status check.
create table if not exists episodes (
  household_id text not null references households(id) on delete cascade,
  id text not null,
  patient_id text not null,
  status text not null check (status in ('OPEN', 'CLOSED')),
  opened_at bigint not null,
  data jsonb not null,
  primary key (household_id, id),
  foreign key (household_id, patient_id) references patients(household_id, id) on delete cascade
);

create table if not exists prescriptions (
  household_id text not null references households(id) on delete cascade,
  id text not null,
  patient_id text not null,
  -- PENDING rows came from a photo and are never read by a safety check until a person confirms them.
  status text not null check (status in ('PENDING', 'ACTIVE')),
  created_at_ms bigint not null,
  data jsonb not null,
  primary key (household_id, id),
  foreign key (household_id, patient_id) references patients(household_id, id) on delete cascade
);

-- 8. RLS on, no policies: only the service-role key can touch PHI.
alter table households enable row level security;
alter table patients enable row level security;
alter table caregivers enable row level security;
alter table inventory enable row level security;
alter table dose_ledger enable row level security;
alter table dose_locks enable row level security;
alter table carts enable row level security;
alter table careos_alerts enable row level security;
alter table observations enable row level security;
alter table advice_memory enable row level security;
alter table audit_log enable row level security;
alter table episodes enable row level security;
alter table prescriptions enable row level security;

-- 9. Atomic dose commit (PRD §4.5).
--
-- ONE transaction: idempotency check, interval/daily-max check, stock check, ledger insert, inventory
-- decrement and lock upsert either all happen or none do. A per-(household, patient, ingredient) advisory
-- lock serialises concurrent callers, so two caregivers can never both pass the interval check (this also
-- covers the first-ever dose, where there is no lock row to SELECT ... FOR UPDATE).
--
-- Returns {"status": "OK" | "REPLAY" | "LOCKED" | "DAILY_MAX" | "INSUFFICIENT_STOCK", "inventory_remaining": n}.
-- The decision mirrors checkInterval() in packages/open-caregiver-mcp/src/engines/intervalLock.ts; the shared
-- storage contract test (50 parallel commits, idempotency, daily max, isolation) runs against both.
create or replace function commit_dose(
  p_household text,
  p_event jsonb,
  p_min_interval_hours numeric,
  p_max_doses int,
  p_inventory_item text,
  p_now bigint
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_patient text := p_event->>'patient_id';
  v_ingredient text := p_event->>'ingredient';
  v_key text := p_event->>'idempotency_key';
  v_at bigint := (p_event->>'at')::bigint;
  v_vol numeric := coalesce((p_event->>'volume_ml')::numeric, 0);
  v_count int;
  v_last bigint;
  v_inv inventory%rowtype;
  v_remaining numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_household || '|' || v_patient || '|' || v_ingredient, 0));

  begin
    if exists (select 1 from dose_ledger where household_id = p_household and idempotency_key = v_key) then
      return jsonb_build_object('status', 'REPLAY');
    end if;

    select count(*) into v_count
      from dose_ledger
     where household_id = p_household and patient_id = v_patient and ingredient = v_ingredient
       and at > p_now - 86400000;
    if v_count >= p_max_doses then
      return jsonb_build_object('status', 'DAILY_MAX');
    end if;

    select max(at) into v_last
      from dose_ledger
     where household_id = p_household and patient_id = v_patient and ingredient = v_ingredient;
    if v_last is not null and p_now < v_last + (p_min_interval_hours * 3600000)::bigint then
      return jsonb_build_object('status', 'LOCKED');
    end if;

    if p_inventory_item is not null then
      select * into v_inv from inventory
       where household_id = p_household and id = p_inventory_item
       for update;
      if found and v_inv.unit = 'mL' then
        if v_inv.remaining < v_vol then
          return jsonb_build_object('status', 'INSUFFICIENT_STOCK');
        end if;
        v_remaining := round(v_inv.remaining - v_vol, 3); -- label doses go to 3 decimals (1.875 mL)
        if v_vol > 0 then
          update inventory set remaining = v_remaining, updated_at = now()
           where household_id = p_household and id = p_inventory_item;
        end if;
      elsif found then
        v_remaining := v_inv.remaining;
      end if;
    end if;

    insert into dose_ledger (household_id, event_id, patient_id, at, caregiver, medication, ingredient, volume_ml, temperature_f, idempotency_key, sku, amount_mg)
    values (
      p_household, p_event->>'event_id', v_patient, v_at, p_event->>'caregiver', p_event->>'medication', v_ingredient,
      nullif(p_event->>'volume_ml', '')::numeric, nullif(p_event->>'temperature_f', '')::numeric, v_key,
      nullif(p_event->>'sku', ''), nullif(p_event->>'amount_mg', '')::numeric
    );

    insert into dose_locks (household_id, patient_id, ingredient, next_allowed_at, last_dose_id)
    values (p_household, v_patient, v_ingredient, v_at + (p_min_interval_hours * 3600000)::bigint, p_event->>'event_id')
    on conflict (household_id, patient_id, ingredient)
    do update set next_allowed_at = excluded.next_allowed_at, last_dose_id = excluded.last_dose_id, updated_at = now();

    return jsonb_build_object('status', 'OK', 'inventory_remaining', v_remaining);
  exception when unique_violation then
    -- Same idempotency key raced in through a different patient/ingredient lock: treat as a replay.
    return jsonb_build_object('status', 'REPLAY');
  end;
end;
$$;

-- Only the server's service-role key may commit doses.
revoke all on function commit_dose(text, jsonb, numeric, int, text, bigint) from public, anon, authenticated;
grant execute on function commit_dose(text, jsonb, numeric, int, text, bigint) to service_role;

-- 10. Atomic inventory change (a delivery adds stock; floors at zero). Returns the new quantity, or NULL for an unknown item.
create or replace function add_inventory(p_household text, p_item text, p_delta numeric)
returns numeric
language sql
as $$
  update inventory
     set remaining = greatest(0, round(remaining + p_delta, 3)), updated_at = now()
   where household_id = p_household and id = p_item
  returning remaining;
$$;

revoke all on function add_inventory(text, text, numeric) from public, anon, authenticated;
grant execute on function add_inventory(text, text, numeric) to service_role;

-- 11. Make PostgREST pick up new tables and columns immediately (otherwise the API can keep answering from its old schema cache).
notify pgrst, 'reload schema';
