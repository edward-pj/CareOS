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
5. **DynamoDB transactions: no usable local emulator in the npm ecosystem** — Task: test the conditional-write race guarantee offline. Steps: no Docker on the dev machine; tried `dynalite` (pure JS). Actual: `dynalite@4` has no `TransactWriteItems` (its `actions/` lacks it), so the exact feature the AWS challenge hinges on cannot be tested with it. Workaround: official DynamoDB Local jar (Java), downloaded and SHA-256 verified by `scripts/setup-dynamodb-local.sh`. Severity: Medium. Suggestion: publish DynamoDB Local on npm / Homebrew with a one-command start.
6. **A stale-snapshot race hiding in a "correct" transaction** — Task: guarantee two caregivers can't both log a dose. Actual: a version-checked `TransactWriteItems` still let 2 of 10 concurrent writers succeed because I read the ledger and the lock item in parallel; a commit landing between the two reads passed the version check against a stale ledger. Found by the 10-way concurrency test, not by review. Workaround: read the lock *before* the ledger (anything committed later bumps the version; anything earlier is visible in the ledger read). Severity: High (it's the core safety property). Suggestion: DynamoDB could offer snapshot/transactional reads spanning a Query and a Get, or document this ordering rule next to the optimistic-locking guidance.
7. **vitest + a `source` export condition** — Task: let tests import a workspace package from `src/`. Actual: a global `resolve.conditions: ["source"]` also matched `eventsource-parser`'s `source` condition and tried to load raw `.ts` from `node_modules` ("Stripping types is currently unsupported for files under node_modules"). Workaround: scoped `resolve.alias` for just our package plus tsconfig `paths`. Severity: Low.
