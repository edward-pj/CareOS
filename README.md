# CareOS

Ambient household clinical-safety OS, shown through a browser **Alexa+ simulator**. Deterministic dosing/safety engines are exposed over MCP; Amazon Nova on Amazon Bedrock handles language only (it parses the request and picks a tool).

> Demo only — not a medical device.

- `packages/open-caregiver-mcp` — MIT, standalone deterministic engines + MCP server.
- `apps/careos-server` — Express host: MCP over Streamable HTTP, DynamoDB/SNS adapters, Bedrock orchestrator, live trace.
- `apps/careos-web` — Vite + React + Tailwind dual-pane simulator: Alexa+ surface (left) and live CareOS monitor (right).

```
pnpm install
pnpm dev:server   # mock model by default; LLM_MODE=bedrock for the real one
pnpm dev:web      # http://localhost:5173 (use Chrome for mic input)
```

See [`docs/PLAN.md`](docs/PLAN.md) for architecture, status and next steps.
