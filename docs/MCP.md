# CareOS MCP endpoint

Streamable HTTP, MCP spec **2025-11-25**, **stateless**, bearer-authenticated. One endpoint: `POST /mcp`.

| | |
|---|---|
| Transport | Streamable HTTP, single `/mcp` endpoint (no `/sse`, no `/messages`) |
| State | None between requests: no `Mcp-Session-Id` is ever issued or required. Any instance can answer any request. |
| `GET /mcp`, `DELETE /mcp` | `405` with `Allow: POST` (no server-initiated stream, nothing to terminate) |
| Auth | `Authorization: Bearer <token>`. The token maps to one household and one caregiver; every read and write is scoped to that household. |
| Health | `GET /healthz` (public): name, version, spec, transport, `stateless`, auth mode |

## Try it with curl

```bash
export CAREOS_URL=http://127.0.0.1:8787      # or the public URL
export CAREOS_TOKEN=<one of the tokens in CAREOS_TOKENS>

# 1. Who am I talking to?
curl -s $CAREOS_URL/healthz

# 2. List the tools (a bare request: no initialize, no session)
curl -s -X POST $CAREOS_URL/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer $CAREOS_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 3. Ask for a verified dose check
curl -s -X POST $CAREOS_URL/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer $CAREOS_TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"verify_medication_safety","arguments":{"patient_id":"frank","proposed_medication":"Advil","administration_intent":false}}}'
```

The `accept` header must list both `application/json` and `text/event-stream` (a Streamable HTTP requirement).
Replies arrive as a single SSE `data:` line; strip the `data: ` prefix to get the JSON-RPC response.

Without a valid token the server answers `401` with `WWW-Authenticate: Bearer realm="careos"`.

## Configuring tokens

```bash
# .env
CAREOS_TOKENS=<token-for-sarah>=demo:sarah,<token-for-dad>=demo:dad,<other-token>=other-family:maya
```

- Format: `token=household:caregiver`, comma-separated; tokens must be at least 16 characters (`openssl rand -hex 24`).
- Only a SHA-256 digest of each token is held in memory and compared in constant time.
- With no `CAREOS_TOKENS` the server runs in **open mode** (everything is the `demo` household) and **refuses to start unless `HOST` is loopback**.
- Each household listed is seeded with demo data on first start if it is empty.

## From OAuth account linking to this token

Alexa+ links a customer account with OAuth 2.1 and sends the resulting access token as `Authorization: Bearer ...`
on every MCP request. `TokenAuth.authenticate` in `apps/careos-server/src/auth.ts` is that resource-server step:
it turns a bearer credential into `{ householdId, caregiverId }`. Swapping the static token table for token
introspection or JWT verification changes only that one method; storage scoping, tool code and the inspector are
unchanged.

## Connecting a browser or another client

- The web simulator talks to `/api/*` through the Vite dev proxy. With bearer auth on, set `CAREOS_WEB_TOKEN` to one of
  the tokens; the proxy adds the header server-side and it never reaches the browser bundle.
- MCP clients that cannot set headers cannot use this server; that is deliberate.
