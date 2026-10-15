# CareOS — Plan (Vega edition)

Supersedes the browser-simulator parts of the original implementation plan. The deterministic engines, MCP surface,
DynamoDB/SNS design and safety rules are unchanged; only the **client** and the **transport/voice assumptions** change.

> Demo only — not a medical device.

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Scaffold | done |
| 1 | Deterministic engines (`open-caregiver-mcp`) | done |
| 2 | MCP server + Streamable HTTP mount | done |
| 3 | `careos-server`, DynamoDB transact writes, SNS, trace tap | done (committed in `f5e7bc8`) |
| 3.5 | Vega retarget: CORS opt-in, `HOST`, `confirm_label`, `apps/careos-vega` shell | **this change** |
| 4 | Bedrock orchestrator (+ Vega-safe transport) | done: tested offline (mock model); live Bedrock smoke script written but not run |
| 5 | Vega client: conversation UI over long-poll, state | done in code, type-checked and unit-tested; not run on a device. Inspector screen deferred to Phase 7 (dev tool) |
| 6 | Vega cards (5) | next |
| 7 | Demo script, hardening, deploy | after 6 |
| 8 | Open-source release + submission | after 7 |

## Target platform

**React Native for Vega on Fire TV** (Vega OS), D-pad/remote first. Developed on the Vega Virtual Device, then a
physical Fire TV (e.g. Fire TV Stick 4K Select).

Not assumed: running Vega on Echo/Alexa+ hardware. The Builder Tools docs list only Fire TV devices for Vega; the
Echo Show 15 developer notes describe Fire OS. "Alexa" in this project means the Alexa voice button on the Fire TV
remote and Alexa-routed transport commands, not a custom Alexa device runtime. Revisit if Amazon publishes a Vega
Echo target.

## Vega platform constraints that change the design

| # | Constraint (source) | Consequence |
|---|---|---|
| 1 | No app-level speech-to-text. STT is only the platform keyboard's mic: focus a `TextInput`, hold the Alexa button, speak. (community.amazondeveloper.com STT threads) | No Web Speech API, no wake word, no push-to-talk. Input = `TextInput` + keyboard mic, plus D-pad quick-action buttons. |
| 2 | No app-level TTS. The only speech output is VoiceView (accessibility). (same thread; `a11y_compass_vegascript_get_started.md`) | Replies are on-screen text. Announce results with `aria-live` regions (`polite` by default, `assertive` only for lockouts/critical blocks). `announceForAccessibility` is deprecated; never `speechSynthesis`. |
| 3 | Networking docs cover `XMLHttpRequest` and `WebSocket`; streaming `fetch` / `EventSource` are not documented. (`.../react-native-vega/0.83/network`) | `/api/converse` and `/api/trace` need a non-SSE option. Decide in Phase 4: WebSocket (preferred) or cursor long-poll (`?after=<id>`). Keep SSE for non-Vega clients and tests. |
| 4 | RN 0.83 pins: `react-native-kepler ^4.0.0+rn0.83.0`, React 19.2.0, nav/screens on different majors than the docs show (FRICTION_LOG #8). `Carousel` moved to `@amazon-devices/vega-carousel` (V2 `dataAdapter` API); `kepler-ui-components` v3 deprecates its wrappers in favour of plain RN (FRICTION_LOG #9). | Pin from npm dist-tags, use `vega-carousel`, validate with `vega project doctor` once the SDK is installed. |
| 5 | D-pad focus must have *physical* indicators (border/scale), every element reachable. (`amazon-devices-vega-focus-management`) | Every card control is a `Pressable` with a bordered focus state; PIN entry is a D-pad keypad. |
| 6 | No touch on Fire TV Stick; 48dp targets; use `Dimensions`, not 1920. (best-practices) | 10-foot layout, dose numerals >= 72, no hardcoded canvas. |
| 7 | KPIs: TTFF < 1.5s cool, UI fluidity > 99%, foreground < 400 MiB. (app-performance) | Syringe animation uses native-driver transforms; lazy-load screens. |
| 8 | Vega SDK 0.24 needs `[os.version]` (min/target `"1.2"`) in `manifest.toml`. (app-manifest) | Included in the scaffold; regenerate modules with `vega project update-manifest`. |

## Revised delivery

**Phase 4 — Bedrock orchestrator (server). Done.**
- `apps/careos-server/src/orchestrator/`: `BedrockLlm` (Mantle Messages API, `effort: "low"`, `tool_choice: auto`, strict tools), `MockLlm` (offline regex intents), tool bridge/sanitizer, tool-use loop, numeric guardrail, `Orchestrator` (sessions, one turn per session).
- **Transport decision (constraint 3):** `POST /api/converse` returns `202 {turn_id}`. Events are read with a cursor long-poll, `GET /api/turns/:id/events?after=N&wait=S` (plain XHR, what Vega documents), or SSE, `GET /api/turns/:id/stream` (tests, browsers, MCP-style tools). Both read one event log, so a card is delivered as soon as its tool returns, before the reply text.
- **Safety decisions:** `override_lockout` is withheld from the model (PINs go through the device keypad to `/api/override`); every dose amount (mg/mL) in a reply must appear in a tool result from the same turn, otherwise the reply is replaced and a `GUARDRAIL_REPLACED` alert is emitted; `log_administration_event` still re-verifies server-side.
- **Deferred:** token streaming (Bedrock calls are non-streaming; replies are one or two sentences) and a WebSocket transport (only worth adding if long-poll latency is a problem on device).
- **Verified:** the five demo flows through the mock model over a real HTTP/MCP hop, both transports, 99 tests total. **Not verified:** any live Bedrock call (`pnpm --filter careos-server smoke:bedrock` needs AWS credentials), and long-poll behaviour on a real Vega device.

**Phase 5 — Vega client. Done in code; device run pending.**
- `AskScreen`: `TextInput` (keyboard mic via the Alexa button), Send, quick actions (fever dose from the profile weight, sore throat, restock, confirm), stable `aria-live` reply and assertive alert regions, a plain facts panel for the latest card, caregiver chips.
- Logic lives in pure modules with 29 vitest tests (`npm test` in `apps/careos-vega`): `conversation/reducer.ts`, `conversation/poll.ts` (cursor long-poll with idempotent retries and backoff), `conversation/cardFacts.ts` (copies numbers from payloads, never derives them), `utils/time.ts`.
- Contract check: the real reducer, poll follower and card facts were run against the real server in mock mode (dose flow shows 2 mL; the lock flow shows 328 min and names Sarah). That check was a one-off and is not committed.
- Shared household state is one provider (`HouseholdContext`), so screens do not each poll.
- **Unverified until a Vega device/VVD run:** keyboard-mic dictation into `TextInput`, `onSubmitEditing`, `aria-live` announcements in VoiceView, `vega-carousel` selection, XHR long-poll to `localhost` (cleartext policy), and the final `vega build`.
- **Deferred:** inspector screen (needs `/api/trace`, which is SSE; a long-poll variant is required first).

**Phase 6 — Vega cards (~1.5 days).** SyringeCalibrator (native-driver `scaleX`), DoubleDoseIntercept (full-screen
overlay, D-pad PIN keypad, chime via Vega audio lib), ContraindicationShield, PantryRemedy, RestockCarousel (Vega
`Carousel`, confirm button uses `confirm_label`). Card router keyed by `card_type`. Skills: ui-components,
focus-management, app-performance; a11y labels/roles/live regions per the A11Y Compass docs.

**Phase 7 — Demo, hardening, deploy.** Five scripted flows; device bring-up on the Vega Virtual Device and a
physical Fire TV (developer mode, port forwarding, `vega device install-app`); App Runner + CloudFront-less deploy
(no web client to host); Appstore Quality Central cannot test VPKG, so manual QA on device.

**Phase 8 — OSS release + submission.** Unchanged, plus the Vega friction-log entries.

## Skill coverage (Amazon Builder Tools skills)

| Skill | Use in CareOS |
|---|---|
| amazon-devices-vega-setup-sdk | Phase 5 prerequisite (SDK not yet installed on the dev machine; installer is interactive, user runs it) |
| amazon-devices-vega-developer-mode-init | Phase 7 physical-device bring-up |
| amazon-devices-vega-build-and-run | Phases 5-7: `npm run build:debug`, install, launch, Fast Refresh |
| amazon-devices-vega-app-manifest | Phase 3.5/5: `manifest.toml` incl. `[os.version]` |
| amazon-devices-vega-best-practices | All client work (no bundled React, error boundaries, `Dimensions`) |
| amazon-devices-vega-navigation | Phase 5: `@amazon-devices/react-navigation__stack` |
| amazon-devices-vega-focus-management | Phases 5-6: every control |
| amazon-devices-vega-ui-components | Phases 5-6: `Carousel` V2 (`@amazon-devices/vega-carousel`) for stock and restock; the skill itself still describes V1 |
| amazon-devices-vega-app-performance | Phase 7: KPI Visualizer, fluidity on syringe animation |
| amazon-devices-vega-caption-settings | Not needed: no app-drawn captions. Revisit only if reply text is rendered as captions |
| amazon-devices-vega-audio-description | Not applicable (no media) |
| amazon-devices-vega-webview-caption-settings | Not applicable (no WebView) |
| amazon-devices-vega-webview-audio-description | Not applicable (no WebView) |
| amazon-devices-vega-media-player | Not applicable (no playback) |
| amazon-devices-vega-matter-casting | Not applicable (no phone-to-TV casting) |
| amazon-devices-vega-rn-upgrade | Later, if RN moves past 0.83 |
| amazon-devices-vega-app-migration | Not applicable (greenfield, not a FOS port) |
| amazon-devices-scalable-ui-audit | Android TV only; the RN scaler guidance is reused as a checklist (no raw px, `useWindowDimensions`) |
| amazon-devices-android-sdk-uplevel | Not applicable (Fire OS only) |

## Open items / blockers

1. Vega SDK not installed here. The Vega app is type-checked only; no device build has been run.
2. Transport choice for streaming (WebSocket vs long-poll) needs a quick on-device spike in Phase 4/5.
3. Whether an Alexa-routed intent can deliver a free-form utterance to a custom app is unverified; assume not.
4. Echo/Alexa+ hardware as a Vega target is unverified (see Target platform).
