# CareOS — Plan (Web simulator edition)

Supersedes the Vega edition. The deterministic engines, MCP surface, DynamoDB/SNS design, safety rules and the
Phase 4 Bedrock orchestrator are **unchanged**. Only the **client** changed: the React Native for Vega app was dropped
(Vega has no app-level STT/TTS/SSE and the SDK could not be installed here), and replaced by a browser simulator.

> Demo only — not a medical device.

## Why a simulator

The hackathon asks for a simulated Alexa+ surface that shows the assistant listening and answering. A browser app
demonstrates that without device hardware, and in a browser we get the things Vega lacked: Web Speech (mic), 
`speechSynthesis` (spoken replies) and `EventSource` (SSE).

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Scaffold | done |
| 1 | Deterministic engines (`open-caregiver-mcp`) | done |
| 2 | MCP server + Streamable HTTP mount | done |
| 3 | `careos-server`, DynamoDB transact writes, SNS, trace tap | done |
| 4 | Bedrock orchestrator | done: tested offline (mock model); live Bedrock smoke script written but **not run** |
| 5 | **Web simulator** (`apps/careos-web`): dual pane, conversation, live dashboard, 5 cards | done: typechecks, 19 unit tests, builds, and every flow was driven in headless Chrome against the mock model |
| 6 | Polish + demo script: five scripted flows, error states, visual QA | mostly done: flows, error states and screenshots verified, `docs/DEMO.md` written; open items in "Next steps" |
| 7 | Hardening + deploy (server on App Runner, web as static build) | after 6 |
| 8 | Open-source release + submission | after 7 |

## Target

A single **Vite + React + Tailwind** web app, dual pane, running in the browser against the unchanged `careos-server`.

```
┌──────────────────────── LEFT: Alexa+ surface ───────────┬──────────────── RIGHT: CareOS live monitor ─────────────┐
│ chat bubbles ("Alexa, …"), mic toggle, preset chips      │ profile + caregiver pickers, LIVE badge, Reset demo       │
│ Agent reasoning (Bedrock): ⚡ tool, args, MCP payload     │ Next dose due (lockout countdown)                         │
│ Alexa reply (also spoken) + rich card                    │ Caregiver activity timeline (from the dose ledger)        │
│ (syringe / lock / shield / pantry / restock carousel)    │ Caregiver handoff summary, supplies, MCP wire log         │
└──────────────────────────────────────────────────────────┴───────────────────────────────────────────────────────────┘
```

### How it talks to the server (no server changes)

| Need | Mechanism |
|---|---|
| Send an utterance | `POST /api/converse` → `{turn_id}` |
| Reply, tool trace, card | SSE `GET /api/turns/:id/stream` via `EventSource` (events: `assistant_delta`, `tool_call`, `tool_result`, `card`, `alert`, `error`, `done`) |
| Dashboard state | `GET /api/state` |
| **Right pane updates live** | The server pushes no state events. Every MCP call crosses `/mcp` and is streamed on `GET /api/trace` (SSE); a finished tool-call frame triggers a debounced refetch of `/api/state`. A 10 s poll is the fallback. |
| Reset demo | `POST /api/demo/reset` |
| Lockout override (PIN) | `POST /api/override` from the lock card; the PIN never reaches the model |
| CORS | Off on the server. Vite dev proxy forwards `/api`, `/mcp`, `/healthz` to `localhost:8787` (`CAREOS_SERVER` overrides). |

`/api/turns/:id/events?after=&wait=` (long-poll) stays on the server; the web app does not use it.

### Layout of `apps/careos-web`

- `src/api/` — hand-written contract types, `fetch` client, `followTurn` (turn SSE), `subscribeTrace` (wire SSE).
- `src/lib/` — pure, unit-tested logic: `conversation.ts` (reducer, alert copy, client-side "switch caregiver" intent), `handoff.ts`, `time.ts`; tests in `lib.test.ts`.
- `src/hooks/` — `useHousehold` (state + live refresh + wire frames), `useConversation`, `useSpeech` (Web Speech + `speechSynthesis`), `useNow`.
- `src/components/` — `AlexaPane`, `AgentTrace`, `Cards` (card router keyed by `card_type`), `DashboardPane`.

### Rules for further work

1. **Do not change the server or the MCP tool schemas** to suit the UI. If the UI needs something, derive it client-side or record it here as a request.
2. **Every number on screen comes from a payload** (card payloads, `/api/state`). The UI never computes doses, intervals or totals. Visual-only values (e.g. syringe fill width) are the one exception and are never shown as text.
3. Safety copy for blocks/lockouts is in `lib/conversation.ts` (`ALERT_COPY`); keep alerts `role="alert"`.
4. The mock model (`LLM_MODE=mock`) only understands the phrases the preset chips use. Free-form phrasing needs `LLM_MODE=bedrock`. Check `orchestrator/mock.ts` before inventing new chips.
5. `FRICTION_LOG.md` entries must be real and observed, never pre-written.

## Running it

```
pnpm install
pnpm dev:server        # LLM_MODE=mock by default; set LLM_MODE=bedrock + AWS creds in .env for the real model
pnpm dev:web           # http://localhost:5173  (Chrome for mic input)
pnpm --filter careos-web test
pnpm --filter careos-web typecheck
```

## Next steps (in order)

1. ~~Verify what is written.~~ Done: install, typecheck, tests, `vite build`, both dev servers, and a scripted click-through of all five cards plus the error state (headless Chrome over DevTools, so no extension needed).
2. ~~Remove the Vega app.~~ Done: `apps/careos-vega/` and the `!apps/careos-vega` workspace line are gone; the last committed version is at `4475c85`.
3. **Decide the open demo gaps** (see `docs/DEMO.md` "Known issues"):
   - Supplies do not update after an order (needs a server change, which rule 1 forbids, or a client-side "ordered" badge).
   - Cross-patient questions ("Can Frank take NyQuil?" with Leo active) do not name the patient on the card. This can be fixed client-side from the tool call's `patient_id`.
   - The plan's "switch caregiver to Grandma" cannot work: the seed has only Sarah (Mom) and Dad.
   - "Log 60 ml formula feed" and "What meds are pending?" have no MCP tool behind them (scope change or leave out).
4. **Live Bedrock smoke test:** `pnpm --filter careos-server smoke:bedrock` (needs AWS credentials), then one UI turn with `LLM_MODE=bedrock` for each flow in `docs/DEMO.md`.
5. **Deploy (Phase 7):** `vite build` to static hosting; server on App Runner (`infra/` is empty and there is no Dockerfile yet). Replace the dev proxy with routing of `/api` and `/mcp` to the server, or set `ALLOWED_ORIGIN`.
6. **Phase 8:** open-source release (README for `open-caregiver-mcp`, CI, CONTRIBUTING), friction log review, demo video.

## Unverified

- Web Speech recognition (Chrome/Edge only) and `speechSynthesis` voice quality: not exercised in headless Chrome.
- Any live Bedrock call, real DynamoDB on AWS (only DynamoDB Local), real SNS delivery.
- Hand-written, free-form phrasing: the mock only understands the chips.

## Retired: the Vega client

Dropped for these reasons (kept for the record and the friction log): no app-level STT/TTS on Vega (only the keyboard
mic and VoiceView), streaming `fetch`/`EventSource` undocumented, RN 0.83 package pins differ from the docs, the Vega
SDK installer is interactive, and no Vega Echo/Alexa+ target is documented. The last committed Vega client is at
commit `4475c85` (`Phase 5: Vega conversation screen over cursor long-poll`) and can be recovered from git history.
