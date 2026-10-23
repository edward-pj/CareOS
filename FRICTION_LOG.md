# Friction log

Build, Ship, Shape: Amazon Developer Hackathon. Alexa+ track, AWS Builder and Open Source challenges.

These are the places where I got stuck while building CareOS. Some of it is my fault and some of it is not, and I've tried to say which is which.

---

## 1. Amazon Bedrock would not run a model on my new account

**Task.** I wanted a Bedrock model to power the conversation layer of the MCP app, because I wanted to use AWS for the AWS Builder challenge. I started with Anthropic models in the Bedrock playground, then tried Amazon Nova.

**What I did.** Account was a few weeks old. The models in the playground didn't respond for me. I created IAM policies for Bedrock and attached them. I emailed AWS support and didn't get a reply. I changed regions to see if it was regional, and it still failed. Then I ran this from the CLI:

aws bedrock-runtime converse --region us-east-1 --model-id us.amazon.nova-lite-v1:0 --messages ‘[{“role”:”user”,”content”:[{“text”:”hi”}]}]’


**What I expected.** A normal reply, or an error that says what to fix: a missing permission, a quota, or an account check.

**What happened.**

An error occurred (ValidationException) when calling the Converse operation: Operation not allowed


That message doesn't say which of the things I'd already changed was wrong, or whether it's an account-level block. I couldn't tell from it what to do next.

**Workaround.** I kept Gemini as the LLM for the conversation layer and added a mock mode, so the project runs with no model at all. The safety engine is deterministic, so it still works in mock mode.

**Time lost.** TODO: Pratham to fill in hours.

**Severity.** Blocker for the AWS Builder challenge. Not a blocker for the Alexa+ track.

**Suggestion for the Amazon team.** When Bedrock returns "Operation not allowed", say why. Tell me if the account needs verification, if a quota is zero, or if a model needs a use-case form, and link the page to fix it. A console check that lists these would have saved me most of the time.

---

## 2. Vega dev setup failed, so I fell back to the normal dev path

**Task.** I wanted to run the TV client on a Vega device for the Alexa+ demo.

**What I did.** Followed the setup steps and tried to get a Vega build running.

**What I expected.** A working dev loop, like a phone or simulator build.

**What happened.** I ran into dependency issues I couldn't work out. TODO: Pratham to paste the exact error text and the step where it failed.

**Workaround.** I switched to the standard development mode and kept the Vega client out of the demo. The Vega client also has limits I found in the docs: no speech-to-text, no text-to-speech and no server-sent events, so the client uses a cursor-based long poll instead.

**Severity.** Medium. It didn't block the submission, but it cut out a platform I wanted to show.

**Suggestion for the Amazon team.** Publish a known-good Vega setup with pinned versions, and list the dependency combinations that have been tested. A short "if this fails, run this" section would help a lot.

---

## 3. Gap I found while building: one-off answers aren't enough

**Task.** The first version of CareOS covered two cases, an infant and an elderly parent. Once I had that working, it felt like a narrow tool. I wanted it to handle the whole household.

**What I did.** I added more of the workflow: a cart that restocks from low-stock signals, a read of past context and prescriptions, and an idea for ordering the whole restock automatically from that context.

**What I expected.** The platform would make it easy to connect the parts, like inventory, memory and ordering, so an agent could run the whole loop.

**What happened.** I had to build each part by hand, and I didn't get automatic ordering. The app deliberately doesn't auto-order. A person still has to stage and confirm each cart. That was a safety decision, but it means the "agent does everything" version isn't built yet.

**Severity.** Low for the current submission. High for the product.

**Suggestion for the Amazon team.** Give agents a standard way to ask for approval before a purchase, like an MCP elicitation step that a voice assistant can answer. That would let the agent act on its own without skipping the human.

---

## Feature requests

- **Standard approval step for purchases (Critical).** Agents need a way to ask a person to confirm an action, with the answer returned to the agent. Without it, the choice is between no automation and unsafe automation. This is why CareOS keeps a human confirmation step.
- **Medication and product data access (Important).** A clean, licensed source for product labels and strengths would let apps like this check doses without hand-curated tables. My current table covers five products only.
- **Better Bedrock account diagnostics (Important).** Specific reasons for "Operation not allowed" would cut out most of the debugging.
- **Vega setup docs with pinned versions (Nice-to-have).** Working dependency combinations would save new developers time.

---

## Would I build with this again?

Partly yes. The MCP protocol and Alexa+ fit what I wanted. Building the MCP server was straightforward, and the tool model made the safety checks easy to test. I would not build with Bedrock again until I can get model access working on a fresh account, because I could not get a single reply from it. My real reason is that a platform that can't tell you why it's blocked costs you more than one that's a bit slower.