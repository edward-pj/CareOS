# CareOS: architecture and status (PRD v2)

> Demo only. Not a medical device.

Authoritative product spec: the PRD v2 (tiers P0/P1/P2). This file records what is built, how it fits together and what is next.

## Architecture

```
Echo Show 15 simulator (React, 1920x1080)      "Alexa+ stand-in" orchestrator            CareOS MCP server (stateless)
 cards · voice orb · MCP/Data/Guard drawers ──▶ Gemini (or Bedrock / mock) tool loop ──▶ POST /mcp  (Streamable HTTP, bearer auth)
        ▲  SSE: turn events + wire trace             │ Numeric Guard on every free-text reply         │
        │                                            └── real MCP client, one per caller token         ▼
        └──────────────── /api/* (same bearer auth) ◀──────────────────────────────  open-caregiver-mcp
                                                                                       label registry · dose engine · safety rules
                                                                                       plan_medication · confirm_dose_given · ...
                                                                                              │
                                                                       StorageRoot.forHousehold(id)  (isolation by construction)
                                                                       memory │ Supabase (Postgres RPC) │ DynamoDB
```

Principles (each has tests): **S1** tools own the numbers; **S2** fail closed; **S3** no record is not no dose; **S4** ingredients, not brands; **S5** label dose and mg/kg must agree; **S6** untrusted input needs a human confirm; **S7** never default to a person; **S9** every verdict cites a source; **H7** nothing can bypass a check.

## Status

| PRD phase | State |
|---|---|
| 0 Foundation: household-scoped storage, atomic `commit_dose` (Supabase SQL, DynamoDB transaction), shared storage contract tests, PIN override removed | done |
| 1 Stateless, bearer-authenticated `/mcp`; per-household tenants, turns and traces | done |
| 2 Safety engine v2: FDA-sourced label registry, label-first dosing with mg/kg cross-check, 17 cited rules, layered `plan_medication`, verdicts with reason codes and sources | done |
| 3 `confirm_dose_given` (signed read-back, idempotent, backdating), double-dose intercept, Memory Conflict Guard, audit trail | done |
| 4 Orchestrator: verbatim speech, unit-aware Numeric Guard (`numeric_guard.blocked`), fail-closed errors | done |
| 5 Echo Show simulator: new cards, MCP / Data / Numeric Guard inspectors, emergency card, accessibility toggles | done, verified in headless Chrome |
| 6 P0 test suite (golden scenarios keyed to PRD ids, 50-way race, isolation, guard) | done |
| 7 P1: triage + emergency flows (cited red-flag rules as data, locale, fixture hospitals), prescription photos (Gemini vision, PENDING until confirmed), Label Lens, SBAR + PDF export, quiet hours, privacy delete, bottle expiry, alternating-medicine note, illness episodes; plus the simulated Amazon storefront (cart, orders, live Orders screen) | done, verified in headless Chrome incl. live Gemini vision on synthetic images |
| 8 Deploy, open-source release (README, CI), submission | **not started** |

## Not built or not verified

- P2 features (see the PRD). Hospitals (Amazon Location), SNS delivery and Bedrock are behind interfaces and not live: nearby hospitals are labelled sample data.
- Red-flag rules are a small set of 20 cited starter rules, not a clinical triage tool. One threshold (no wet diaper for 8 hours) is the PRD's and is not stated by the AAP page it cites; a clinician should confirm it. Locale `IN` is configured but not exercised beyond tests.
- "Send directions to phone" is a disabled button: it needs a live place-search service and a way to text the user.
- Prescription and label reading was run live on synthetic documents only. Real photos (glare, angles, handwriting) are untested.
- Supabase: the SQL is executed in tests (PGlite) and the contract test exists, but the 50-way race against a real Supabase project (`SUPABASE_CONTRACT=1`) has not been run, because the project in `.env` did not have the new schema applied when checked.
- Web Speech (mic) and `speechSynthesis` are not exercised by automated tests.
- Dose tables are transcribed from openFDA label data. A human should re-check each row on DailyMed.
- Syringe tick marks are not modelled: labels do not state them.

## Working rules

1. Every number on screen comes from a tool payload. The UI never computes doses, intervals or totals. Visual-only values (the syringe fill) are never shown as text.
2. Adding a rule: a row in `data/safetyRules.ts` with a source read from a real label, plus a test. Adding a product: a row in `data/labelRegistry.ts` transcribed from the label, with its set id and version.
3. Safety copy for alerts is in `apps/careos-web/src/lib/conversation.ts`; keep alerts `role="alert"`.
4. The mock model only understands the preset phrases (`orchestrator/mock.ts`). Free-form phrasing needs `LLM_MODE=gemini`.
5. `FRICTION_LOG.md` entries must be real and observed, never pre-written.
6. Nothing may bypass a check: no override tool, argument or route. A test fails if one appears.

## Layout

- `packages/open-caregiver-mcp/src`: `data/` (registry, safety rules, drug classes, `redFlagRules`, locale), `engines/` (label dose, safety matrix, `planMedication`, interval lock, triage, SBAR + dossier, PDF writer), `providers/` (hospital search, vision), `shop.ts`, `escalation.ts`, `prescriptions.ts`, `quietHours.ts`, `service.ts`, `server.ts` (tools, resources), `http.ts` (stateless transport), `storage/`, `testing/storageContract.ts`.
- `apps/careos-server/src`: `app.ts`, `auth.ts`, `tenants.ts`, `adapters/` (Supabase, DynamoDB, SNS), `orchestrator/` (loop, guardrail, Gemini, Bedrock, mock).
- `apps/careos-web/src`: `components/` (Cards, Header, Rail, Drawer, ...), `lib/` (pure logic, tested), `hooks/`.
- `scripts/`: `supabase-schema.sql` (re-runnable), `supabase-reset-v2.sql` (one-time, destructive), DynamoDB Local helpers.
