import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { runStorageContract } from "open-caregiver-mcp/testing";
import { loadConfig } from "../src/config.js";
import { SupabaseRoot } from "../src/adapters/supabaseStorage.js";

// Opt-in: talks to the real Supabase project in .env. Apply scripts/supabase-schema.sql first, then run
//   SUPABASE_CONTRACT=1 pnpm --filter careos-server test supabase
// Every test uses a throwaway household id starting with "t-"; they are deleted afterwards (cascades),
// and nothing outside those households is read or written.
const enabled = process.env.SUPABASE_CONTRACT === "1";

if (!enabled) {
  describe("storage contract: supabase", () => {
    it.skip("set SUPABASE_CONTRACT=1 to run against the configured Supabase project", () => {});
  });
} else {
  const cfg = loadConfig({ ...process.env, STORAGE: "supabase" });
  const client: SupabaseClient = createClient(cfg.supabaseUrl!, cfg.supabaseKey!, { auth: { persistSession: false } });

  afterAll(async () => {
    const { error } = await client.from("households").delete().like("id", "t-%");
    if (error) console.error("supabase contract cleanup failed:", error.message);
  });

  runStorageContract({ describe, it, expect }, "supabase", () => new SupabaseRoot(client), { timeoutMs: 120_000 });
}
