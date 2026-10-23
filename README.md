# CareOS

> Demo only. Not a medical device. Nothing here is medical advice.

## What this is and why I built it

CareOS is a shared care log for households where more than one person looks after someone who is sick: an infant with a fever, or an elderly parent on a blood thinner. The thing that actually hurts people in that setup is the double dose. Mom gives Motrin at 1:47, Dad walks in at 2:05, nobody wrote it down, and the baby gets a second dose.

So CareOS sits behind a voice assistant and does one job: before anyone gives anything, it checks the chart, the bottle, the other caregiver, and the clock. The language model never produces a dose. It parses what you said and picks a tool. The numbers come from code that reads the FDA label.

It is an MCP server (`packages/open-caregiver-mcp`), a small Express host that wraps it with auth, storage and a tool-calling loop (`apps/careos-server`), and a React app that pretends to be an Echo Show 15 (`apps/careos-web`).

## Demo and hackathon

- Demo video: <!-- TODO: Pratham to confirm --> VIDEO_LINK_HERE
- Hackathon: Build, Ship, Shape Amazon Developer Hackathon, Alexa+ track.
- Mini challenges: <!-- TODO: Pratham to confirm which mini challenges this entry is for -->

## Quick start (no keys)

You need Node 22 or newer and pnpm. I ran this on Node 26.3.0 and pnpm 11.5.1, from a fresh copy of the repo with no `.env`.

```bash
pnpm install
STORAGE=memory LLM_MODE=mock pnpm dev:server    # terminal 1
pnpm dev:web                                    # terminal 2
```

The server prints one line and then lists the tools it found over its own MCP connection:

```
careos-server 127.0.0.1:8787  storage=memory  alerts=console  llm=mock  vision=off  quiet=off  locale=US  mcp=/mcp (stateless, auth=open)
orchestrator ready: get_household_context, log_observation, plan_medication, ...
```

Check it:

```bash
curl -s localhost:8787/healthz
# {"ok":true,"name":"careos-server","version":"0.1.0","mcp":{"endpoint":"/mcp","transport":"streamable-http","spec":"2025-11-25","stateless":true},"auth":"open-loopback"}
```

The web app is on <http://localhost:5173>. If that port is taken, Vite quietly moves to 5174, so read its output. Use Chrome if you want the mic. Vite proxies `/api`, `/mcp` and `/healthz` to the server on 8787.

Two gotchas. The server loads a `.env` from the repo root if one exists, and a `CAREOS_TOKENS` line in it switches on bearer auth. The command-line `STORAGE` and `LLM_MODE` win over `.env`, but tokens do not go away. And with `LLM_MODE=mock` the model only understands the preset phrases in `apps/careos-server/src/orchestrator/mock.ts` (the web app has buttons for them). Free typing needs a Gemini key.

## Full setup

```bash
cp .env.example .env
```

Then fill in what you need.

### Supabase

1. Create a new Supabase project.
2. Paste `scripts/supabase-schema.sql` into the SQL editor and run it. It is written to be re-run safely.
3. Put the project URL and the service-role key in `.env` as `SUPABASE_URL` and `SUPABASE_KEY`, and set `STORAGE=supabase`.

There is also `scripts/supabase-reset-v2.sql`. It drops the old v1 tables and everything in them, so don't run it. If you have a project with the old v1 tables, make a fresh project instead, because the server will not boot on the v1 schema. (The comment in `.env.example` still says to run the reset first.)

The service-role key stays on the server. Row level security is on with no policies, so the public anon key can read and write nothing.

### Gemini

Get a key from Google AI Studio, set `GEMINI_API_KEY`, and set `LLM_MODE=gemini`. The server refuses to start in Gemini mode without the key. The same key turns on photo reading (prescriptions and bottle labels) unless you set `VISION=off`. The default model is `gemini-2.5-flash`.

### Run

```bash
pnpm dev:server
pnpm dev:web
```

### Environment variables

| Name | Required | What it does |
|---|---|---|
| `LLM_MODE` | no, default `mock` | `mock`, `gemini` or `bedrock` |
| `GEMINI_API_KEY` | yes if `LLM_MODE=gemini` | Gemini calls and photo reading |
| `GEMINI_MODEL_ID` | no, default `gemini-2.5-flash` | Model used by the tool loop |
| `BEDROCK_MODEL_ID` | no, default `us.amazon.nova-pro-v1:0` | Only for `LLM_MODE=bedrock` |
| `STORAGE` | no, default `memory` | `memory`, `supabase` or `dynamo` |
| `SUPABASE_URL`, `SUPABASE_KEY` | yes if `STORAGE=supabase` | Project URL and service-role key |
| `DDB_TABLE`, `DDB_ENDPOINT` | no | DynamoDB table (default `careos`) and an optional local endpoint |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | only for Bedrock, DynamoDB, SNS | AWS credentials. Region defaults to `us-east-1` |
| `SNS_TOPIC_ARN` | no | Without it, caregiver alerts are printed to the server console |
| `CAREOS_TOKENS` | no | Bearer auth: `token=household:caregiver,...`, tokens 16+ characters. Unset means open mode |
| `CAREOS_WEB_TOKEN` | only with `CAREOS_TOKENS` | One of those tokens; the Vite proxy adds it so it never reaches the browser |
| `PORT`, `HOST` | no, defaults `8787`, `127.0.0.1` | In open mode the server refuses to start unless `HOST` is loopback |
| `ALLOWED_ORIGIN` | no | CORS is off by default; the Vite proxy makes browser calls same-origin |
| `VISION` | no | `off` disables photo reading |
| `QUIET_HOURS`, `CAREOS_TIMEZONE` | no | e.g. `22:00-07:00`; ordinary alerts wait, lockouts and emergencies do not |
| `CAREOS_LOCALE` | no, default `US` | `US` (911) or `IN` (112, ambulance 108) |
| `HOUSEHOLD_LAT`, `HOUSEHOLD_LNG` | no | Origin for the nearby-hospitals list |
| `SHOP_DEMO_SECONDS` | no, default 60 | How long a simulated order takes to arrive (clamped 5 to 3600) |
| `CAREOS_SERVER` | no | Read by the Vite proxy if the server is not on `127.0.0.1:8787` |

Generate a token with `openssl rand -hex 24`. Keys go in `.env`, which is gitignored.

## Talking to it as an MCP server

- Endpoint: `POST /mcp`
- Transport: Streamable HTTP, stateless. No `Mcp-Session-Id` is issued. `GET` and `DELETE` on `/mcp` return 405.
- MCP spec version: `2025-11-25` (the constant in `apps/careos-server/src/app.ts`)
- Auth: `Authorization: Bearer <token>`, one token per household and caregiver. Open mode (no tokens, loopback only) treats everyone as the `demo` household.
- Header gotcha: `accept` must list both `application/json` and `text/event-stream`. Replies come back as a single SSE `data:` line.

```bash
curl -s -X POST localhost:8787/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

MCP Inspector. I ran the command-line mode of Inspector 2.12.0 against the server and it listed the tools and called one:

```bash
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8787/mcp --transport http --method tools/list
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8787/mcp --transport http \
  --method tools/call --tool-name get_household_context --tool-arg patient_id=leo
```

For the browser UI, run `npx @modelcontextprotocol/inspector`, pick Streamable HTTP and enter `http://127.0.0.1:8787/mcp`. I did not drive the browser UI. With bearer auth on, add an `Authorization: Bearer ...` header (`--header` on the CLI). The web app also has its own MCP Inspector drawer that shows every JSON-RPC frame with a copy-as-curl button.

There are 15 tools (confirmed with `tools/list`):

- `get_household_context`: who is in the house, active locks, low supplies, remembered doctor advice (re-checked against today's chart).
- `log_observation`: temperature, weight, glucose, wet diapers, with unit and plausibility checks. It asks rather than guessing a unit.
- `plan_medication`: the only source of doses. Returns APPROVED, BLOCKED, ALTERNATE_SUGGESTED, NEEDS_CLINICIAN or NEEDS_INFO with reason codes and sources.
- `confirm_dose_given`: read-back first, then logs the dose, starts the lock and updates the bottle.
- `triage_symptoms`: sign-based red-flag check that returns an urgency level and can hold home dosing.
- `emergency_assist`: the number to dial, nearby hospitals, a script for the call-taker, and an alert to other caregivers. It never places a call.
- `export_care_summary`: a short SBAR script for the nurse line, or a PDF of temperatures, doses and the episode timeline.
- `manage_prescriptions`: ingest, list, confirm or reject prescriptions read from a photo.
- `read_bottle_label`: reads strength and expiry from a bottle photo for a person to confirm.
- `forget_patient`: deletes a person and their records, in two steps.
- `query_pantry_remedies`: mild-symptom suggestions from what is in the house, filtered by the person's medicines and conditions.
- `stage_amazon_cart`, `confirm_amazon_order`, `cancel_amazon_order`, `track_amazon_order`: the simulated shopping flow.

It also exposes resources: `careos://patients/leo`, `careos://patients/frank`, `careos://household/inventory`, and the templates `careos://patients/{id}/ledger` and `careos://patients/{id}/dossier.pdf`.

## How the safety side works

Again: this is a hackathon demo, not medical advice, and the data is not verified for real use.

Doses come from a label registry, `packages/open-caregiver-mcp/src/data/labelRegistry.ts`. Each row is transcribed from an FDA label and carries the label's set id and version, so a verdict can cite where the number came from. There are exactly five products:

- Infants' Motrin Concentrated Drops (ibuprofen 50 mg / 1.25 mL)
- Children's Motrin Oral Suspension (ibuprofen 100 mg / 5 mL)
- Infants' Tylenol Oral Suspension (acetaminophen 160 mg / 5 mL)
- Tylenol Extra Strength caplets (acetaminophen 500 mg)
- NyQuil Severe caplets

The model never produces a number. If a product is not in the registry, there is no dose. Replies pass through a Numeric Guard (`apps/careos-server/src/orchestrator/guardrail.ts`): any quantity in free text has to match something a tool returned, with the same kind of unit. A mg value does not back an mL value. If the guard trips, the draft is dropped and the tool's own `speech` field is spoken instead.

Logging a dose is a read-back. The first `confirm_dose_given` call only repeats the entry and returns a signed token. The dose is written after the caregiver says yes and the token comes back.

Dose locks span caregivers. A logged dose locks that ingredient for that person for the label's minimum interval (6 hours for Infants' Motrin), whoever logged it. The commit is atomic: a `commit_dose` function with an advisory lock on Supabase, a `TransactWriteItems` transaction on DynamoDB. There is no override tool, argument or route, and a test fails if one shows up.

Checks run in order: exact product and concentration, active prescriptions and ingredients (ingredients, not brand names), conditions and age, then time, count and daily limit. There are 17 cited rules in `data/safetyRules.ts`. A missing record is treated as unknown, not as "no dose given": the first answer for Leo is a question about whether he had ibuprofen elsewhere.

Triage (`data/redFlagRules.ts`) uses 18 red-flag rules over 20 signs, from 8 sources (AAP, NHS, CDC and a Washington State head-injury guideline). It does not go by temperature alone. Levels, highest first:

- `CALL_EMERGENCY`
- `GO_TO_ER_NOW`
- `CALL_DOCTOR_TODAY`
- `HOME_CARE_OK_WITH_WATCH`

It never says everything is fine, and some rules turn home dosing off. One threshold (no wet diaper for 8 hours) is from my spec and is not on the AAP page the rule cites. A clinician has to settle it.

## Demo walkthrough

Seed data (`packages/open-caregiver-mcp/src/storage/seed.ts`): Leo, about 9 months, 19 lb, no prescriptions. Frank, 78, on Eliquis, metformin, lisinopril and atorvastatin, with type 2 diabetes and hypertension. Two caregivers, Sarah (Mom) and Dad. In the mock model, the word "dad" in a sentence means Frank.

I ran these through `/api/converse` against the mock model. The web app has a button for each.

1. "Leo has a fever and weighs 19 lbs. How much Motrin?" Reply: has Leo had any ibuprofen today, even if it was not logged here? No dose yet.
2. "No, nothing else today." Reply: 1.875 mL of Infants' Motrin, spoken twice (as a number and in words).
3. "I gave Leo Motrin." Reply: a read-back, "Logging 1.875 milliliters of Infants' Motrin for Leo, given by Sarah just now. Is that correct?" Nothing is saved.
4. "Yes, log it." It logs and states when the next dose is allowed.
5. Switch to Dad and say "I gave Leo Motrin." Reply: "Stop. Sarah gave Infants' Motrin ..." and the dose is refused. To see it with a realistic gap, reset first:

```bash
curl -X POST localhost:8787/api/demo/reset -H 'content-type: application/json' \
  -d '{"sarah_dosed_minutes_ago":18}'
```

As Dad: "Stop. Sarah gave Infants' Motrin 18 minutes ago, so the next dose is allowed in 5 hours and 42 minutes."

6. "Can Frank take Advil?" Blocked, because Frank takes Eliquis and NSAIDs raise bleeding risk with blood thinners.
7. "What did the doctor say last time about Frank's gout?" The seed holds old advice from Dr. Rao to take naproxen. The reply says it is no longer safe now that Frank is on Eliquis.
8. "Dad fell and hit his head." Urgency `GO_TO_ER_NOW`: a head strike on a blood thinner.

`docs/DEMO.md` has more flows, such as photo reads, the nurse-line summary and the Orders screen at `#/shop`. I did not re-run those for this README.

## Alexa+ note

What I mean by an Alexa+-ready MCP server: a remote MCP server on Streamable HTTP, stateless so any instance can answer any request, that expects a bearer token in the `Authorization` header. That is my reading of how Alexa+ links an account and calls tools. <!-- TODO: Pratham to confirm this matches the Alexa+ MCP requirements you were given --> The tools also carry descriptions that tell the model what to read aloud (`speech`, `read_verbatim`). `docs/MCP.md` sketches how Alexa+'s OAuth token would map to a household and caregiver.

What I actually built and tested: the server above, over plain HTTP from `curl`, the MCP Inspector CLI, my own MCP client, and the test suite.

What I did not do: I have not connected this to Alexa+ or any Echo device. OAuth account linking is not implemented. Auth is a static token table (`TokenAuth.authenticate` in `apps/careos-server/src/auth.ts`), which is the one place real token checking would go. <!-- TODO: Pratham to confirm how, or whether, this was tried against real Alexa+ -->

The web app stands in for the device. It draws an Echo Show 15 screen (1920x1080, scaled to fit) with cards, a voice orb and drawers for the MCP trace and the data. `POST /api/converse` runs a Gemini tool loop that plays the part of Alexa+. It is my substitute, not Alexa's behaviour, and real Alexa+ will phrase and call things its own way. Browser speech needs Chrome and a microphone, and no automated test covers it.

## Tests

```bash
pnpm -r test
```

On the fresh copy, exit code 0:

| Package | Files | Tests |
|---|---|---|
| `packages/open-caregiver-mcp` | 10 | 288 passed |
| `apps/careos-server` | 10 passed, 1 skipped | 175 passed, 1 skipped |
| `apps/careos-web` | 5 | 56 passed |

That is 519 passed and 1 skipped. The skipped test is the live Supabase contract test (`test/supabase.test.ts`), which only runs with `SUPABASE_CONTRACT=1` and real credentials. I have not run the 50-way race against a live Supabase project. The Supabase SQL itself is executed in tests with PGlite, an in-process Postgres. The DynamoDB tests ran in this pass, but I did not check whether they used a real DynamoDB Local.

## What I built during the hackathon window, and what was already there

The git history has 9 commits, from 2026-10-15 22:39 to 2026-10-18 09:01 (+0530). The first commit ("Scaffold CareOS monorepo and deterministic safety engines") has nothing before it, so the history shows no earlier work. <!-- TODO: Pratham to confirm the hackathon start date and whether any code or ideas predate it -->

Rough timeline from the log:

- Oct 15: monorepo, deterministic engines, the MCP server with Streamable HTTP, the Express host with DynamoDB and SNS adapters.
- Oct 16: Bedrock orchestrator, a React Native for Vega client, then the Vega client deleted again in the "basic structure done" commit that evening.
- Oct 18: Gemini and Supabase added.

A lot of the current code is not committed yet. At the time of writing, the label registry (retrieved 2026-10-19), bearer auth, tenants, triage, photo reading, the simulated Amazon shop and the Supabase RPC schema are modified or untracked in the working tree, so `git log` understates the work. I will commit before submitting. <!-- TODO: Pratham to confirm everything is committed before submission -->

`FRICTION_LOG.md` has the problems I hit along the way, including a DynamoDB transaction race that only a concurrency test caught.

## Known limits

- Hospitals are sample data (labelled that way on screen). Amazon Location is not connected, and the "send directions to phone" button is disabled.
- Amazon orders are simulated. The delivery clock is compressed to about a minute (`SHOP_DEMO_SECONDS`).
- The rule sets are curated starter sets: 17 safety rules and 18 red-flag rules. This is not an interaction database or a triage tool.
- Five products only. Anything else gets no dose.
- Dose tables are transcribed from openFDA label data. A person should re-check every row against DailyMed.
- Without a Gemini key there are no photo reads. Photo reading was only tried on synthetic documents, so glare and handwriting are untested.
- Alerts go to the server console unless `SNS_TOPIC_ARN` is set, and I have not run SNS delivery live. Bedrock is wired up but I have not run it.
- Locale `IN` is configured but barely exercised.
- Vega: I started a React Native for Vega client for Fire TV and later removed it from the tree. Vega has no app-level speech-to-text or text-to-speech, and I never installed the Vega SDK, so that client was only type-checked, never built or run on a device. The current client is the web simulator.
- Syringe tick marks are not modelled. The card says to use the syringe from the box.

## License and credits

MIT. The repo root `LICENSE` reads "CareOS contributors", and `packages/open-caregiver-mcp` has its own MIT license. <!-- TODO: Pratham to confirm the copyright holder name -->

Dose and safety data come from FDA labels via openFDA and DailyMed, and red-flag sources are the AAP and NHS pages listed in `redFlagRules.ts`. Built with the MCP TypeScript SDK, Express, React, Vite, Tailwind, Gemini, Supabase, and PGlite for the SQL tests.
