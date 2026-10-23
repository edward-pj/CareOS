# CareOS demo script

Run locally (no keys needed): `STORAGE=memory LLM_MODE=mock pnpm dev:server` and `pnpm dev:web`, then open <http://localhost:5173> in Chrome (for the mic).
With `LLM_MODE=gemini` the same flows run on Gemini; the mock model only understands the preset phrases below.

The screen is an Echo Show 15 simulator (1920x1080, scaled to fit): card on the left, voice / "what Alexa heard" / active episode /
Safety Ledger on the right, and a collapsible **MCP Inspector** drawer along the bottom.

Every number below comes from a tool, never from the model. Dose figures come from the product's own FDA label chart.
Flows 1 to 6 were driven through the real UI in headless Chrome (over the DevTools protocol) against the mock model.

| # | Do this | You hear / see | Proves |
|---|---|---|---|
| 1 | Tap **"Leo has a fever and weighs 19 lbs. How much Motrin?"** | A question card: "Has Leo had any ibuprofen today, like Motrin or Advil, even if it wasn't logged here?" (amber "One quick question"). No dose yet. | S3: no record is not no dose |
| 1b | Tap **No, nothing else today** | **Verified dose** card: **FILL TO 1.875 mL**, Infants' Motrin 50 mg / 1.25 mL, 19 lb (8.62 kg), 75 mg = 8.7 mg/kg, next dose after (now + 6 h), the label's set id and version. Spoken: "…1.875 milliliters… one point eight seven five milliliters." | Label-first dosing (v1 said 2.0 mL), mg/kg cross-check, S9 sources |
| 2 | Tap **I gave Leo Motrin** | **Is this correct?** read-back card with Yes / No. Nothing is saved yet (ledger empty, bottle unchanged). | Read-back before logging |
| 2b | Tap **Yes, log it** | "Logged. The next Infants' Motrin for Leo is allowed after …". A ledger row appears; the idle card turns red with the lock time; low-bottle follow-up. | Atomic dose + lock + supply |
| 3 | Reset (gear > **Reset demo data**), then `curl -X POST localhost:8787/api/demo/reset -H 'content-type: application/json' -d '{"sarah_dosed_minutes_ago":18}'`. Switch **Speaking** to **Dad**, tap **I gave Leo Motrin** | Full-screen red **ADMINISTRATION LOCKED**: live countdown, "Sarah (Mom) gave Infants' Motrin (1.875 mL) at 1:47 PM, 18 minutes ago", "This cannot be overridden by anyone." Spoken: "Stop. Sarah gave Infants' Motrin 18 minutes ago, so the next dose is allowed in 5 hours and 42 minutes." | Double-dose intercept; no override exists (H7) |
| 4 | Switch to **Frank**, tap **Can Frank take Advil?** | **NOT SAFE TO GIVE**: Advil vs Eliquis, "NSAIDs raise bleeding risk with blood thinners", and a green panel "Acetaminophen: Tylenol Extra Strength, no more than 6 caplets in 24 hours (3000 mg). Check with Frank's clinician first." Chips show `SR-NSAID-ANTICOAGULANT` and the label sources. | Contraindication Shield; alternative re-verified for him |
| 5 | Tap **What did the doctor say last time about Frank's gout?** | **OLD ADVICE, NO LONGER SAFE**: "Naproxen" struck through (Dr. Rao, August) beside "Frank takes Eliquis". The old advice is not repeated. | Memory Conflict Guard |
| 6 | Open **MCP INSPECTOR** | Banner "Streamable HTTP · spec 2025-11-25 · stateless", every JSON-RPC frame, **Copy as curl** on each request. | Real, stateless MCP |
| 6b | **Data Inspector** tab | Read-only ledger, locks, remembered advice, the append-only audit trail (tool, verdict, reason codes, input hash) and the storage backend. | The data is real |
| 7 | **Numeric Guard** tab | Empty until the model drafts a number no tool returned; then the draft, the offending amount and the spoken replacement appear (`numeric_guard.blocked`). Covered by `converse.test.ts` against a live MCP hop. | S1 |
| 8 | **Emergency** button (any time, even with the server stopped) | Red card: Call 911, poison help, five generic first-aid steps (no doses). "CareOS prepares the call; you place it." | S8 offline-safe |
| 9 | Settings: **High contrast**, **Reduced motion**, **Screenless mode** | Pure black and white UI; no animation; or only the words a speaker would say. | Design / accessibility |

### Phase 7 flows (all driven through the real UI in headless Chrome; photo reads used the live Gemini vision API on synthetic documents)

| # | Do this | You hear / see | Proves |
|---|---|---|---|
| 10 | Type **Dad fell and hit his head** | Red **Needs to be seen right away** card: call 911 (a `tel:` link, "CareOS prepares the call; you place it"), three nearby hospitals labelled **sample data**, why (the rule and its source link), and "what to tell the call-taker". Other caregivers are alerted. | E3: a head strike matters because Frank takes Eliquis; sign-based triage |
| 11 | Type **his face is drooping and his speech is slurred** (Frank) | "This could be an emergency. Call 9 1 1 now." | E4 |
| 12 | Type **Is it serious? Check Leo for warning signs** | **Warning-sign check**: tap the signs that apply (or "None of these"). The tap is sent as an ordinary sentence. | Red-Flag Checklist |
| 13 | Type **Leo threw up the dose of medicine**, then ask for Motrin again | "Don't give another dose" and a nurse-line brief; the next dose request is refused: "I'm not giving a dose for Leo right now." | C10: no re-dose |
| 14 | Type **help me call the nurse line** | **Nurse-line brief**: Situation, Background, Assessment, Request, in large type, from the chart. "Export Leo's 48 hour summary" gives the PDF. | SBAR, PDF dossier |
| 15 | Tap the camera, choose **Prescription for Frank**, pick a photo | Side-by-side: the photo and the fields read (Gemini). Low-confidence fields are marked; nothing is on the chart until you press **Confirm**. | E8, S6 |
| 16 | Tap the camera, choose **Medicine bottle label** | **Is this the bottle?** The strength and expiry it claims, and whether it differs from the bottle on the chart. An expired bottle stops the conversation. | C6, expired bottle |
| 17 | **Orders** button (or `#/shop` in a second window) | Cart, orders, supplies and activity. Say **Restock Motrin**, then **Confirm the order**: it appears live in the other window; **Demo controls** simulate another caregiver ordering, a low bottle, or fast-forward delivery (the bottle refills). | Simulated Amazon storefront, live updates |
| 18 | Type **delete Leo's data**, then **yes** | The first call says what would go and changes nothing. | H9 |

The server keeps quiet hours (`QUIET_HOURS`) for ordinary alerts; lockouts, critical blocks and emergencies always go through (H10).

Also try: `Leo weighs 19, how much Motrin, he hasn't had any other` (asks pounds or kilograms), `Leo's temperature is 103.1`, `Frank has a sore throat` (honey capped for diabetes), `Restock Motrin` then `Confirm the order` (simulated cart).

## Known limits (honest)

- Web Speech (mic) and `speechSynthesis` need Chrome and a real microphone; they are not exercised by the automated tests.
- The mock model only understands the preset phrases. Free-form phrasing needs `LLM_MODE=gemini`.
- Hospitals are labelled sample data (Amazon Location is not connected), "send directions to phone" is a disabled button, and SNS delivery is not live. Amazon ordering is simulated; its delivery clock is compressed to about a minute.
- Photo reading was exercised on synthetic documents only. Real photos (glare, handwriting) are untested.
- Device syringe tick marks are not shown because the labels do not state them; the card says "use the syringe from the box".
- The safety rules are a curated, cited starter set (17 rules, plus built-in allergy and duplicate-ingredient checks), not a full interaction database. It is far short of the 40 to 60 the PRD hopes for; each one cites a real label section. Demo only, not a medical device.
