# CareOS: what works and how to test it in depth

How to read this file:

- ✅ **Observed**: I ran the real `CareService` (in-memory storage, seed data, fixed clock) and recorded the output. Expect the same status and reason codes.
- 📖 **From code**: read from the source, not run end to end. Verify it yourself and tell me if it differs.
- 🔌 **Needs live services**: needs Gemini, Supabase or the browser. Not exercised from this session.

Seed data, used by every scenario below unless stated otherwise (`packages/open-caregiver-mcp/src/storage/seed.ts`):

| Who / what | Details |
|---|---|
| **Leo** (infant) | 9 months, 19 lb, weighed 2 days ago, no prescriptions, no conditions |
| **Frank** (elder) | 78 years, takes Eliquis, metformin, lisinopril, atorvastatin; has type-2 diabetes and hypertension |
| Caregivers | Sarah (Mom), Dad |
| Infant's Motrin drops | **3.5 mL** left, low threshold 4 mL (already low at boot) |
| Infant Tylenol | 60 mL, threshold 10 |
| Test strips | 6, threshold 10 (already low at boot) |
| Pantry | ginger 1, lemons 3, honey 1, chamomile tea 10 |
| Remembered advice | Frank: "naproxen for gout flare" from Dr. Rao, 67 days ago |

---

## 0. Before you test: fix the Supabase database (required)

Your live database is behind `scripts/supabase-schema.sql`. I probed it read-only:

| Check | Result |
|---|---|
| `carts.created_at_ms` (and 6 sibling columns) | ❌ missing → `listCarts failed: column carts.created_at_ms does not exist` |
| `episodes` table | ❌ missing → breaks `plan_medication` (`homeDosingHold`) and every triage |
| `prescriptions` table | ❌ missing → breaks photo prescriptions |
| households, patients, caregivers, inventory, dose_ledger, dose_locks, observations, advice_memory, audit_log, careos_alerts | ✅ present |

**Fix:** open the Supabase SQL editor, paste all of `scripts/supabase-schema.sql`, run it. It is re-runnable and keeps your data (it only adds the missing columns and tables). Do **not** run `supabase-reset-v2.sql`. Then restart the server.

The server now checks all of this at boot (`SupabaseRoot.assertSchema`) and refuses to start with a list of what is missing, instead of failing on the first request.

---

## 1. Setup and sanity checks

```bash
pnpm --filter careos-server dev        # API + MCP on :8787
pnpm --filter careos-web dev           # UI on :5173
```

| # | Test | Expected |
|---|---|---|
| 1.1 | Boot with the old schema | 📖 Server exits with `Supabase schema is out of date:` and one line per problem |
| 1.2 | Boot after running the schema | Banner shows `storage=supabase llm=gemini`, then `orchestrator ready: <tool names>` |
| 1.3 | `GET /healthz` | 📖 `200` |
| 1.4 | `GET /api/state` | Both patients, caregivers, inventory |
| 1.5 | `GET /api/inspect` | Data inspector shows backend `supabase` |
| 1.6 | `POST /api/demo/reset` | Everything returns to the seed above (audit log is never wiped) |
| 1.7 | Stop the server for 10 s, restart, keep the page open | Shop/trace streams show a disconnected state, then reconnect on their own. A chat turn now survives short drops: it retries up to 5 times before showing "Lost connection" |
| 1.8 | Watch the server log for 60 s with nothing happening | No `[shop] tick failed` lines. A repeating failure is logged once, not every second |

---

## 2. Medication planning (`plan_medication`)

Verdicts: `APPROVED`, `BLOCKED`, `ALTERNATE_SUGGESTED`, `NEEDS_CLINICIAN`, `NEEDS_INFO`. Doses come only from the FDA label registry. The model never invents a number.

### 2a. Leo (infant, 19 lb, 9 months)

| # | Say / call | Expected (✅ observed) |
|---|---|---|
| 2.1 | "Leo has a fever, how much Motrin?" | `NEEDS_INFO`, `missing: elsewhere`, code `NO_RECORD_IS_NOT_NO_DOSE`: "Has Leo had any ibuprofen today… even if it wasn't logged here?" |
| 2.2 | Answer "no, none today" | `APPROVED`, **1.875 mL** Infants' Motrin, band `LABEL_BAND_18_23LB`, `MG_PER_KG_OK`, `INTERVAL_CLEAR` |
| 2.3 | (same) | Also carries `AGE_WEIGHT_MISMATCH`: the 18–23 lb row on the label is for 12–23 months and Leo is 9. Weight governs. Check the card shows this flag |
| 2.4 | "Leo can have Advil?" | Resolves to the household's Infants' Motrin → same `APPROVED` 1.875 mL (ingredient-based, not brand-based) |
| 2.5 | "Leo, Tylenol" | `NEEDS_CLINICIAN`, `LABEL_ASK_DOCTOR_WEIGHT`: the infant Tylenol label says ask a doctor under 24 lb |
| 2.6 | Motrin with bottle strength "100 mg / 5 mL" (Children's) | `NEEDS_CLINICIAN`: strength picks Children's Motrin, whose label says ask a doctor under 24 lb. Tests wrong-bottle detection |
| 2.7 | "Leo, aspirin" | `BLOCKED`, `SR-ASPIRIN-UNDER-12` (Reye's syndrome wording) |
| 2.8 | "Leo, NyQuil" | `BLOCKED`, `SR-COLD-COMBO-UNDER-4` |
| 2.9 | "Leo, Zarbex" (unknown product) | `NEEDS_CLINICIAN`, `UNKNOWN_PRODUCT`: "I can't verify Zarbex, so I won't give a dose" |
| 2.10 | Weight "60 lb" | `NEEDS_INFO`, `WEIGHT_IMPLAUSIBLE_FOR_AGE` (typical range ~4.5–14 kg) |
| 2.11 | Weight "20" with no unit | `NEEDS_INFO`, `WEIGHT_UNIT_MISSING`: "20 pounds or 20 kilograms?" |
| 2.12 | Weight "10 lb" | `NEEDS_CLINICIAN`, `LABEL_ASK_DOCTOR_WEIGHT` (under the 12 lb chart floor) |
| 2.13 | Bottle expiry "2020-01" | `BLOCKED`, `BOTTLE_EXPIRED` ("expired in January 2020") |
| 2.14 | "Gave Motrin elsewhere 30 minutes ago" | `BLOCKED`, `DOUBLE_DOSE_LOCKED`: next dose allowed in 5 h 30 min |
| 2.15 | Answer "I'm not sure" to the elsewhere question | 📖 Asked again (same as 2.1); unknown is never treated as "none" |
| 2.16 | Weight older than 14 days (30 days for ages 12 months and up) | 📖 `NEEDS_INFO` "weigh Leo again" (seed weight is only 2 days old; change it via the Supabase table to test) |
| 2.17 | "the baby" / "him" / blank patient | `NEEDS_INFO`, `PATIENT_AMBIGUOUS`: "Who is this for: Leo or Frank?" |

### 2b. Frank (elder, on Eliquis, lisinopril, hypertension)

| # | Say / call | Expected (✅ observed) |
|---|---|---|
| 2.20 | "Can Frank take Advil?" | `ALTERNATE_SUGGESTED`: `SR-NSAID-ANTICOAGULANT` (critical), plus `SR-NSAID-ACE-INHIBITOR` and `SR-NSAID-HYPERTENSION`. Suggests acetaminophen, "check with Frank's clinician first" |
| 2.21 | "Frank, aspirin" | `ALTERNATE_SUGGESTED`: adds `SR-ANTIPLATELET-ANTICOAGULANT` |
| 2.22 | "Frank, Tylenol Extra Strength" | `APPROVED`, 2 caplets, `ACETAMINOPHEN_CEILING_OK` |
| 2.23 | "Can Frank take NyQuil?" | `BLOCKED`, `SR-DECONGESTANT-HYPERTENSION` (phenylephrine). NyQuil's hidden acetaminophen is also counted |
| 2.24 | "What did the doctor say about Frank's gout?" | `MEMORY_CONFLICT`: "Dr. Rao's August advice was naproxen, but Frank now takes eliquis, so it's no longer safe. Please call Dr. Rao" (old advice is replayed through today's rules) |
| 2.25 | Frank then Tylenol again within 6 h, or over 6 caplets/24 h | 📖 `DOUBLE_DOSE_LOCKED` / `DAILY_MAX` / `ACETAMINOPHEN_DAILY_CEILING` |

### 2c. Safety rule coverage (📖 all in `data/safetyRules.ts`, each can be triggered by editing a patient's conditions or prescriptions)

`SR-NSAID-ANTICOAGULANT`, `SR-ANTIPLATELET-ANTICOAGULANT`, `SR-NSAID-ANTIPLATELET`, `SR-NSAID-CORTICOSTEROID`, `SR-NSAID-DIURETIC`, `SR-NSAID-ACE-INHIBITOR`, `SR-NSAID-KIDNEY-DISEASE`, `SR-NSAID-HEART-DISEASE`, `SR-NSAID-HYPERTENSION`, `SR-NSAID-STOMACH-ULCER`, `SR-IBUPROFEN-UNDER-6-MONTHS`, `SR-ASPIRIN-UNDER-12`, `SR-COLD-COMBO-UNDER-4`, `SR-COLD-COMBO-4-TO-12`, `SR-DECONGESTANT-HYPERTENSION`, `SR-ACETAMINOPHEN-WARFARIN`, `SR-POTASSIUM-ACE-INHIBITOR`.

Products with label doses: Infants' Motrin drops, Children's Motrin, Infants' Tylenol, Tylenol Extra Strength 500, NyQuil Severe.

---

## 3. Logging a dose, and what it does to stock and the cart

This is the flow you asked about. Two-step by design: read-back first, then a token.

| # | Step | Expected (✅ observed, fresh seed with a 15 mL bottle unless noted) |
|---|---|---|
| 3.1 | `plan_medication` Leo/Motrin, none today | `APPROVED` 1.875 mL |
| 3.2 | "I gave Leo Motrin" | `NEEDS_CONFIRMATION`, `READ_BACK_REQUIRED`: "Logging 1.875 milliliters of Infants' Motrin for Leo, given by Sarah just now. Is that correct?" Nothing is written yet |
| 3.3 | "Yes" (same call + `confirmation_token`) | `LOGGED`, `DOSE_LOGGED`, `LOCK_STARTED`: "next Infants' Motrin allowed after <now+6h>". Bottle **15 → 13.125 mL** |
| 3.4 | Repeat 3.3 with the same token | `IDEMPOTENT_REPLAY`: "That dose was already logged". Bottle stays **13.125** (no double decrement) |
| 3.5 | Ask to plan another dose right away | `BLOCKED`, `DOUBLE_DOSE_LOCKED`: "allowed in 6 hours" |
| 3.6 | Dad tries to log one anyway (no plan) | `REJECTED_LOCKED`. Confirm re-runs every safety check, so the lock holds across caregivers |
| 3.7 | Other caregiver gets an alert | 📖 `DOSE_LOGGED` alert "Sarah gave … Next allowed after …" (Supabase `careos_alerts` table, or console/SNS). Held until morning inside quiet hours |
| 3.8 | **Seed bottle (3.5 mL), log one dose** | `LOGGED` with follow-up "Infant's Motrin Concentrated Drops is running low. Want me to add it to a restock order?". Bottle **3.5 → 1.625 mL**, `low_stock: true`, `suggested_restock_items: ["Infant's Motrin Concentrated Drops"]` |
| 3.9 | Open the Shop tab right after 3.8 | `suggestions` lists Motrin (and test strips, which are low from boot). UI gets `inventory.changed` and `inventory.low` events live, so the gauge moves without a refresh |
| 3.10 | Log with `amount` smaller than the plan | 📖 Logs the smaller amount; stock decrements by that |
| 3.11 | Log with `given_minutes_ago` (up to 12 h) | 📖 Back-dated; lock computed from the real time |
| 3.12 | Log a dose when the bottle holds less than the dose | 📖 Refused with `INSUFFICIENT_STOCK` (the commit is atomic: no ledger row, no decrement) |
| 3.13 | Two caregivers confirm at the same instant | 📖 Exactly one succeeds. On Supabase this is the `commit_dose` SQL function with an advisory lock |
| 3.14 | Daily maximum (Motrin 4 doses, Tylenol 5) | 📖 `DAILY_MAX_REACHED` |

### 3.15 The restock loop (cart → order → delivery → stock goes back up)

| # | Step | Expected |
|---|---|---|
| a | "Restock Motrin" (or press the suggestion) | ✅ `STAGED`, 1 item, **$11.48**, "arriving tomorrow by 8:00 am". Cart is shared by the household |
| b | Stage ginger and "diapers" in one request | ✅ Ginger is added ($4.82 → total $16.30); "diapers" is reported in `unavailable_items`, never guessed. A cart with only unknown items returns `NOTHING_STAGED` (📖) |
| c | Stage Motrin again while it is already on an order | 📖 Flagged in `already_on_order`, "already on its way" |
| d | Confirm the order | 📖 `ORDER_PLACED`, `simulated: true`; cart becomes an order. Confirming twice returns `already_ordered`, not a second order |
| e | Watch the order | 📖 PLACED → PACKED (8 s) → SHIPPED (20 s) → OUT_FOR_DELIVERY (38 s) → DELIVERED (60 s). Compressed by `SHOP_DEMO_SECONDS` |
| f | Delivery | 📖 Claimed once (ORDERED → DELIVERED), then stock added once: Motrin **+15 mL**, Tylenol +60 mL, test strips +50, ginger +1, chamomile +20. Motrin 1.625 → **16.625 mL**; the low-stock banner clears and the suggestion disappears |
| g | Cancel while PLACED or PACKED | 📖 `CANCELLED`, "Nothing will be charged" |
| h | Cancel after SHIPPED | 📖 `CANNOT_CANCEL`: "already shipped… return it when it arrives" |
| i | Clear an open cart | 📖 "I've cleared the cart" |
| j | "Where's my order?" | 📖 `ORDER_STATUS` with the stage label and ETA; "NO_ORDER" if none |
| k | Demo buttons | 📖 `POST /api/demo/shop/dad_orders` (a second caregiver orders Tylenol, appears live), `low_stock`, `fast_forward` (deliver everything now), `reset_orders` |
| l | Restart the server mid-order | 📖 Ticker re-attaches to the household on boot; the order still delivers. Delivery restocks once even if two ticks race |

Known limit, by design: nothing is auto-ordered. A dose only produces a *suggestion*; a person stages and confirms.

---

## 4. Health logging (`log_observation`)

| # | Input | Expected |
|---|---|---|
| 4.1 | Leo temperature 101.4 | ✅ `LOGGED`, "101.4 degrees Fahrenheit" |
| 4.2 | Temperature 400 | ✅ `NEEDS_INFO`, `TEMPERATURE_IMPLAUSIBLE` |
| 4.3 | Weight 20 lb | ✅ `LOGGED`, `WEIGHT_RECORDED` (becomes the weight used for dosing) |
| 4.4 | Frank glucose 140 mg/dL | ✅ `LOGGED` |
| 4.5 | Weight/glucose with no unit | 📖 Asks for the unit |
| 4.6 | `minutes_ago` | 📖 Back-dates the reading |
| 4.7 | Wet diapers count | 📖 Logged; 0 in 8 h feeds the dehydration check |

---

## 5. Triage and emergencies (`triage_symptoms`, `emergency_assist`)

Urgency levels: `CALL_EMERGENCY` > `GO_TO_ER_NOW` > `CALL_DOCTOR_TODAY` > `HOME_CARE_OK_WITH_WATCH`. Never says "everything is fine".

| # | Input | Expected (✅ observed) |
|---|---|---|
| 5.1 | Leo, `vomited_after_dose` | `CALL_DOCTOR_TODAY`, `RF-DOSE-VOMITED`: "Don't give another dose"; opens an episode |
| 5.2 | Leo, `difficulty_breathing` | `CALL_EMERGENCY`, `RF-ANY-BREATHING`: "Call 9 1 1 now… CareOS can't place the call for you" |
| 5.3 | No signs reported | `HOME_CARE_OK_WITH_WATCH` with the warning-sign checklist, and the "I can't diagnose" wording |
| 5.4 | `no_warning_signs: true` | Same, `TRIAGE_NO_RED_FLAGS_REPORTED` |
| 5.5 | Frank, `head_strike` | `GO_TO_ER_NOW`, `RF-HEAD-ANTICOAGULANT` (blood thinner) |
| 5.6 | Frank, `face_drooping` | `CALL_EMERGENCY`, `RF-STROKE-FAST` |
| 5.7 | Leo temp 104.5°F | `CALL_DOCTOR_TODAY`, `RF-CHILD-TEMP-104` |
| 5.8 | Leo fever 2 days | `CALL_DOCTOR_TODAY`, `RF-FEVER-DAYS-UNDER-2Y` |
| 5.9 | **Dose after triage** (Leo, ask for Motrin) | `NEEDS_CLINICIAN`, `EPISODE_NO_HOME_DOSING`: "I'm not giving a dose for Leo right now". Home dosing stays held for 12 hours |
| 5.10 | Emergency assist | `CALL_EMERGENCY`, `EMERGENCY_ASSIST`; shows the number (US 911, IN 112/108), nearby hospitals labelled **SAMPLE DATA**, and a call-taker summary; alerts other caregivers. Never places a call |
| 5.11 | Infant under 3 months with ≥100.4°F | 📖 `GO_TO_ER_NOW`, `RF-INFANT-FEVER-U3M`, no home dosing (Leo is 9 months; needs a new patient to test) |
| 5.12 | Other red flags | 📖 Seizure, non-fading rash, stiff neck, unresponsive, blue/gray colour → `CALL_EMERGENCY`; chest pain / severe breathlessness; lip or throat swelling or wheezing (anaphylaxis); drowsy or repeated vomiting → `CALL_DOCTOR_TODAY`; dehydration signs (no wet diaper 8 h, no tears, sunken soft spot) |
| 5.13 | Locale | 📖 `CAREOS_LOCALE=IN` switches to 112 / ambulance 108 |

### Handover to a nurse or doctor (`export_care_summary`)

| # | Input | Expected |
|---|---|---|
| 5.20 | `kind: sbar` | ✅ `SBAR_READY`: "This is about Leo, 9 months old, 20 pounds. Concern… Last temperature… Last medicine… Allergies: none reported." Same text as on screen |
| 5.21 | `kind: dossier` | ✅ `SUMMARY_READY`: 48 h summary ("2 temperature readings and 1 dose") as a PDF, also at `GET /api/patients/:id/dossier.pdf` |

---

## 6. Photos (uploads)

🔌 Needs `GEMINI_API_KEY` and `VISION` not set to `off`. Not exercised from this session. Without a key, both flows return `UNAVAILABLE / VISION_NOT_CONFIGURED` ("You can type it instead") ✅ observed.

### Upload rules (`POST /api/uploads`, 📖 from `uploads.ts`)

| # | Test | Expected |
|---|---|---|
| 6.1 | Upload a PNG, JPEG, WebP or GIF | `up_…` id returned |
| 6.2 | Upload a `.pdf` or a text file renamed `.png` | `not_an_image`. The type is read from the file's first bytes, never the header |
| 6.3 | Empty file / over 8 MB | `empty` / `too_large` |
| 6.4 | 11th upload within 10 minutes | `too_many` (10 per household) |
| 6.5 | Use an upload id twice | Second read: "I can't find that photo. Please add it again." Each photo is read **once**, then deleted |
| 6.6 | Wait 10 minutes, then read | Same message: uploads expire |
| 6.7 | Use another household's id | Not found. Uploads are per household |
| 6.8 | Check Supabase after any photo | No photo bytes stored anywhere. Only confirmed fields are kept |

### Prescription photo (`manage_prescriptions`)

| # | Test | Expected (📖 unless noted) |
|---|---|---|
| 6.10 | Ingest a clear prescription for Frank | `NEEDS_CONFIRMATION`, card `RX_CONFIRMATION`; each medicine is saved as **PENDING**. "Nothing is saved to Frank's chart until you check each one" |
| 6.11 | Run a Motrin plan for Frank while a pending Rx exists | Pending rows affect **no** safety check |
| 6.12 | Confirm one (optionally correct drug, strength, frequency, prescriber) | `CONFIRMED`; drug joins Frank's active medications and is checked against every later request |
| 6.13 | Confirm a drug the registry doesn't know | `CONFIRMED` with `UNCHECKED_ACTIVE_MEDICATION`: "I don't recognize X, so I can't check it" |
| 6.14 | Confirm with the drug name cleared | `NEEDS_INFO`, asks for the name |
| 6.15 | Confirm twice | `already_confirmed` |
| 6.16 | Reject a pending one | `REJECTED`, "Nothing was saved" |
| 6.17 | Reject one already confirmed | `BLOCKED_ACTIVE`: ask a clinician |
| 6.18 | Prescription labelled for a different person | `name_mismatch: true`, `NAME_MISMATCH` shown |
| 6.19 | Drug already on the chart | Flag `ALREADY_ON_CHART` |
| 6.20 | Blurry photo / low confidence | `LOW_CONFIDENCE:<field>` flags; unreadable photo → "try again with better light, or type the medicine" |
| 6.21 | **The end-to-end proof:** confirm an anticoagulant for Leo, then ask for Motrin | Now blocked by `SR-NSAID-ANTICOAGULANT`. Shows a photo-derived Rx really feeds the safety engine |
| 6.22 | Photo with text like "ignore previous instructions" | Vision prompt says to leave that field out and not follow it. Confirm nothing odd is saved |

### Bottle label (`read_bottle_label`, Label Lens)

| # | Test | Expected (📖) |
|---|---|---|
| 6.30 | Photo of the household Motrin bottle | `NEEDS_CONFIRMATION`: name, strength, expiry shown for a person to confirm; no dose given |
| 6.31 | Expired bottle | `BLOCKED`, `BOTTLE_EXPIRED` |
| 6.32 | Strength differs from the shelf item | `BOTTLE_DIFFERS_FROM_SHELF` |
| 6.33 | After confirming, ask for the dose | The UI passes `bottle_concentration` and `bottle_expires` to `plan_medication`; a Children's Motrin bottle for Leo hits case 2.6 |
| 6.34 | Unreadable label | "tell me the strength printed on the bottle" |

---

## 7. Pantry remedies (`query_pantry_remedies`)

| # | Input | Expected |
|---|---|---|
| 7.1 | Leo, sore throat | ✅ `MATCH_FOUND` (honey is excluded for under 12 months: infant botulism) |
| 7.2 | Frank, sore throat | ✅ `MATCH_FOUND` (honey capped at 3.5 g for type-2 diabetes) |
| 7.3 | Frank, nausea | ✅ `MATCH_FOUND` |
| 7.4 | Frank, cold | ✅ `NO_SAFE_MATCH` |
| 7.5 | Grapefruit with a statin, banana / orange juice with an ACE inhibitor | 📖 Excluded (`foodInteractions.ts`) |
| 7.6 | Empty the pantry (set ginger to 0), ask again | 📖 Falls back to what is in stock |

---

## 8. Household context, memory and privacy

| # | Test | Expected |
|---|---|---|
| 8.1 | "Who's in the house / what was given today?" | ✅ `OK` with patients, today's doses, active locks, `low_supplies` |
| 8.2 | Recall by topic ("gout") | ✅ See 2.24 |
| 8.3 | "Delete Leo's data" | 📖 First call: says what would be deleted and returns a token. Nothing deleted |
| 8.4 | Confirm with the token | 📖 Leo and all child rows (doses, episodes, prescriptions, observations) are removed. The audit log stays |
| 8.5 | Audit log | 📖 One row per safety decision; hash of the input, not the input. Updating it fails; deleting it fails |
| 8.6 | Multi-household | 📖 With `CAREOS_TOKENS`, a token only sees its own household; trace stream shows only your own MCP traffic |
| 8.7 | Open mode | 📖 With no tokens the server refuses to listen on anything but loopback |

---

## 9. Conversation, voice and the UI 🔌

| # | Test | Expected |
|---|---|---|
| 9.1 | Presets in the chat bar | "Leo has a fever and weighs 19 lbs. How much Motrin?", "I gave Leo Motrin", "Can Frank take NyQuil?", "Restock Motrin", "Leo threw up the dose", "Help me call the nurse line", "Switch caregiver shift to Dad" |
| 9.2 | Dose wording | The model must read `speech` verbatim and add no numbers of its own. Try to coax a different dose out of it |
| 9.3 | Two messages at once | Second gets `409 turn_in_progress` |
| 9.4 | Message over 16 KB | `413 too_large` |
| 9.5 | Kill the server during a turn | 📖 Stream retries; if the server is back within a few attempts the turn resumes from the last event, otherwise "Lost connection to the CareOS server." |
| 9.6 | Mock mode (`LLM_MODE=mock`) | Runs the whole flow with no Gemini key; useful to separate model problems from data problems |
| 9.7 | Switch caregiver, act, switch back | Alerts and "by Dad" attributions follow the active caregiver |
| 9.8 | Quiet hours (`QUIET_HOURS=22:00-07:00`) | Ordinary alerts held until morning; lockouts, critical blocks and emergencies always go through |

---

## 10. Failure and edge cases worth poking

- Run the app against Supabase **before** applying the schema: it should refuse to start with the exact missing items (1.1).
- Revoke or break `SUPABASE_KEY`: boot check fails fast with the PostgREST message.
- Block network to Supabase mid-session: requests return an error, the server stays up, the shop ticker logs the failure once.
- Remove `GEMINI_API_KEY` but keep `LLM_MODE=gemini`: orchestrator fails at boot, `/api/converse` returns `503 orchestrator_unavailable`, everything under `/api/shop`, `/api/state` etc. still works.
- Run the server tests: `pnpm --filter careos-server test` (174 pass, 1 skipped live-Supabase contract). To run the live contract against your database after migrating: `SUPABASE_CONTRACT=1 pnpm --filter careos-server test supabase`.

---

## 11. Known gaps (honest list)

- Not run from here: the browser UI, Gemini calls, photo reads, live Supabase writes (blocked on the schema in section 0), SNS.
- Hospitals are **sample data** until Amazon Location is connected.
- Orders are simulated; nothing is purchased and nothing is auto-ordered.
- Safety rules are a curated starter set, not a full interaction database. Doses are only available for the five products in section 2c.
- Vega TV client: no speech-to-text, text-to-speech or SSE on Vega, so it uses the cursor long-poll (`GET /api/turns/:id/events?after=N&wait=25`). The `followTurn` reconnect change applies to the web app only.
