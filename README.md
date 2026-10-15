# CareOS

Ambient household clinical-safety OS for Fire TV on **Vega OS** (React Native for Vega client), driven by Alexa. Deterministic dosing/safety engines exposed over MCP; Claude on Amazon Bedrock handles language only.

> Demo only — not a medical device.

- `packages/open-caregiver-mcp` — MIT, standalone deterministic engines + MCP server.
- `apps/careos-server` — Express host: MCP over Streamable HTTP, DynamoDB/SNS adapters, live trace.
- `apps/careos-vega` — React Native for Vega client (10-foot UI, D-pad first). Built with npm + the Vega SDK, outside the pnpm workspace.

See [`docs/PLAN.md`](docs/PLAN.md) for architecture, phases and the Vega platform constraints.
