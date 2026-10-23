-- CareOS: ONE-TIME destructive reset of the v1 (single-household) tables.
--
-- WARNING: this DROPS patients, caregivers, inventory, dose_ledger, carts, overrides and careos_alerts
-- together with every row in them. They only held demo seed data. Run this once, then run
-- scripts/supabase-schema.sql (safe to re-run). Do NOT run this against a database with real data.
--
-- Run in the Supabase SQL Editor: https://supabase.com/dashboard/project/_/sql

drop table if exists dose_ledger cascade;
drop table if exists dose_locks cascade;
drop table if exists overrides cascade;      -- the PIN override was removed (PRD H7)
drop table if exists carts cascade;
drop table if exists inventory cascade;
drop table if exists caregivers cascade;
drop table if exists patients cascade;
drop table if exists careos_alerts cascade;  -- leaves the supabase_realtime publication automatically
drop function if exists commit_dose(text, jsonb, numeric, int, text, bigint);
