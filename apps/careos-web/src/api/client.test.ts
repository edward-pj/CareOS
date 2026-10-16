import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, isGatewayFailure, UNREACHABLE } from "./client";

const respond = (status: number, body: string) => vi.stubGlobal("fetch", async () => new Response(body, { status }));
afterEach(() => vi.unstubAllGlobals());

describe("isGatewayFailure", () => {
  it.each([
    [500, "", true], // Vite dev proxy with the upstream down
    [502, "Bad Gateway", true],
    [503, "<html>unavailable</html>", true],
    [500, '{"error":"internal_error"}', false], // a real server error is JSON
    [404, "", false],
    [409, '{"error":"turn_in_progress"}', false],
  ])("%i %j -> %s", (status, body, want) => expect(isGatewayFailure(status, body)).toBe(want));
});

describe("api request errors", () => {
  it("reports an unreachable server when fetch itself fails", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("network"); });
    await expect(api.getState()).rejects.toMatchObject({ message: UNREACHABLE });
  });

  it("reports an unreachable server when a gateway answers 500 with no JSON", async () => {
    respond(500, "");
    await expect(api.getState()).rejects.toMatchObject({ message: UNREACHABLE, status: 500 });
  });

  it("keeps status-specific errors for real server responses", async () => {
    respond(409, '{"error":"turn_in_progress"}');
    const err = await api.converse({ session_id: "s", active_profile: "leo", caregiver: "c", transcript: "t" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.message).toBe("POST /api/converse failed (409)");
  });
});
