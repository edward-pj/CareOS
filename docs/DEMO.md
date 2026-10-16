# CareOS demo script

Run: `pnpm dev:server` (mock model) and `pnpm dev:web`, open http://localhost:5173 in Chrome (mic needs Chrome/Edge).
Press **Reset demo** between runs. Everything below was driven through the real UI in headless Chrome against the
mock model; the numbers come from the deterministic MCP tools. With `LLM_MODE=bedrock` the wording changes but the
cards and numbers must not.

| # | Click / say | Expect on the left | Expect on the right |
|---|---|---|---|
| 1 | Chip **"Leo has a fever and weighs 19 lbs. How much Motrin?"** | Reply "Give 2 mL (80 mg) of Infant Motrin Drops…"; trace `calculate_pediatric_dose` APPROVED; **Dose** card with a 2 mL numeral | Next dose due stays **Clear to dose** (a calculation logs nothing) |
| 2 | Chip **"Switch caregiver shift to Dad"**, then **"I gave Leo 2 mL of Motrin"** after Reset demo with Sarah dosed 32 min ago (`POST /api/demo/reset {"sarah_dosed_minutes_ago":32}`) | "Stop. Sarah (Mom) gave Infant Motrin Drops 32 minutes ago. Wait 328 more minutes."; red alert; **Double-dose lock** card (328 min) with PIN + Override | Next dose due turns red with the lock end time; handoff summary reads "Handoff for Leo from Dad" |
| 2b | Enter PIN `4242` (demo default, `CAREOS_OVERRIDE_PIN`) on the lock card, then repeat the dose | Wrong PIN → denied (3 wrong tries lock the caregiver out for 5 min); right PIN → dose is logged | Timeline gets a row; lock updates |
| 3 | Chip **"Can Frank take NyQuil?"** | Reply "Blocked. Decongestants can raise blood pressure."; red alert; **Not safe to give** card | Unchanged (the question was about Frank; see known issues) |
| 4 | Chip **"Leo has a sore throat"** | **Chamomile Calming Tea** card; no honey (Leo is under 12 months) | Unchanged |
| 5 | Chip **"Restock Motrin"**, then the card's **Confirm restock order** | Cart with total $11.48 and ETA, then "Order placed (simulated)." | Wire log shows `stage_amazon_cart`, `confirm_amazon_order` |
| 6 | Chip **"I gave Leo 2 mL of Motrin"** (clean state) | "Logged… The bottle is running low with 1.5 mL left." | Timeline row, red lock countdown (6 h), supplies show 1.5 mL · low |
| 7 | Stop the server mid-demo | Chat says "Cannot reach the CareOS server…" | Badge "reconnecting", amber banner, **Status unknown** replaces any dose status |

## Known issues (observed, not fixed)

- **Supplies do not change after an order is placed.** `confirm_amazon_order` is simulated and does not refill
  stock. Showing a refilled row would need a server change (or a client-side "ordered" badge).
- **Cross-patient questions are easy to misread.** Asking about Frank while Leo is the active profile shows Frank's
  answer, but the card does not name Frank and the right pane still shows Leo.
- The mock model only understands the phrases the preset chips use (`orchestrator/mock.ts`).
- There is no "Grandma" caregiver in the seed (only Sarah (Mom) and Dad); the shift chip names whoever else exists.
