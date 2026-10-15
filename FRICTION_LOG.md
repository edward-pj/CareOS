# Friction Log

Real entries only, added as they happen during the build.

## Entry template
- **Task attempted:**
- **Steps taken:**
- **Expected:**
- **Actual:**
- **Severity:**
- **Workaround:**
- **Suggestion:**

## Entries
1. **Local DynamoDB** — no Docker on the dev machine, so docker-compose DynamoDB Local is unavailable. (Severity: Low. Workaround: MemoryAdapter for dev/tests; revisit.)
2. **MCP Streamable HTTP: tracing JSON-RPC frames** — Task: show every JSON-RPC message live in the inspector drawer. Expected: a transport-level hook or event. Actual: `StreamableHTTPServerTransport` exposes none; `onmessage` is only assigned inside `server.connect()`, so the tap must wrap `onmessage` *after* connect and monkey-patch `send`. Severity: Low. Workaround: `tap()` in `packages/open-caregiver-mcp/src/http.ts`. Suggestion: add an official `onFrame`/middleware option to the transport.
3. **MCP SDK session lifecycle** — Task: serve many clients from one endpoint. Actual: no built-in session map; the caller must detect `initialize`, create a transport per session, track `Mcp-Session-Id`, and clean up on close (and answer 400 vs 404 correctly). Severity: Medium (easy to get subtly wrong). Workaround: `createMcpHttpHandler`. Suggestion: ship this helper in the SDK.
4. **pnpm 11 build-script gate** — Task: `pnpm install` then `pnpm test`. Actual: esbuild's postinstall is blocked, and every later `pnpm run` aborts on the dependency-status check until `allowBuilds` is set in `pnpm-workspace.yaml` (the old `onlyBuiltDependencies` key was not honoured). Severity: Low. Workaround: `allowBuilds: { esbuild: true }`.
