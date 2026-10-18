-- CareOS Supabase Schema & Realtime Notifications Setup
-- Run this script in the Supabase SQL Editor (https://supabase.com/dashboard/project/_/sql)

-- 1. Patients
create table if not exists patients (
  id text primary key,
  name text not null,
  kind text not null check (kind in ('infant', 'elder')),
  dob_ms bigint not null,
  weight_lbs numeric,
  active_rx jsonb not null default '[]'::jsonb,
  conditions jsonb not null default '[]'::jsonb,
  allergies jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- 2. Caregivers
create table if not exists caregivers (
  id text primary key,
  name text not null,
  phone text,
  updated_at timestamptz not null default now()
);

-- 3. Inventory
create table if not exists inventory (
  id text primary key,
  name text not null,
  ingredient text,
  unit text not null check (unit in ('mL', 'count', 'pantry')),
  remaining numeric not null,
  low_threshold numeric not null,
  updated_at timestamptz not null default now()
);

-- 4. Dose Ledger (Atomic Dose Administration History)
create table if not exists dose_ledger (
  event_id text primary key,
  patient_id text not null references patients(id) on delete cascade,
  at bigint not null,
  caregiver text not null,
  medication text not null,
  ingredient text not null,
  volume_ml numeric,
  temperature_f numeric,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists idx_dose_ledger_patient on dose_ledger(patient_id, at desc);

-- 5. Carts (Amazon Cart Staging & Confirmation)
create table if not exists carts (
  cart_id text primary key,
  lines jsonb not null,
  total_usd numeric not null,
  eta text not null,
  status text not null check (status in ('STAGED', 'ORDERED')),
  order_id text,
  created_at timestamptz not null default now()
);

-- 6. Lockout Overrides
create table if not exists overrides (
  patient_id text not null,
  ingredient text not null,
  expires_at bigint not null,
  primary key (patient_id, ingredient)
);

-- 7. Realtime Caregiver Alerts (Replaces AWS SNS delivery)
create table if not exists careos_alerts (
  id bigint generated always as identity primary key,
  kind text not null,
  message text not null,
  created_at timestamptz not null default now()
);

-- Enable Supabase Realtime broadcast on careos_alerts
alter publication supabase_realtime add table careos_alerts;
