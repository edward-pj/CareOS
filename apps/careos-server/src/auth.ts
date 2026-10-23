import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/** Who a request is acting as. Every storage access is scoped by `householdId`. */
export interface AuthContext {
  householdId: string;
  caregiverId: string;
}

export const OPEN_CONTEXT: AuthContext = { householdId: "demo", caregiverId: "sarah" };
const MIN_TOKEN_LENGTH = 16;

const digest = (token: string) => createHash("sha256").update(token).digest();

interface Entry { hash: Buffer; ctx: AuthContext }

/**
 * Bearer-token authentication (PRD §8.1): each token maps to one household and one caregiver.
 *
 * Tokens are never stored or compared in the clear: we keep a SHA-256 digest and compare it in constant time.
 * This is the hackathon-grade stand-in for the OAuth 2.1 / account-linking flow Alexa+ uses: a linked account
 * yields an access token, and the resource server maps it to a household exactly as `authenticate` does here.
 *
 * "open" mode (no tokens configured) resolves every request to the demo household. It exists for local
 * development only; index.ts refuses to start in open mode on a non-loopback interface.
 */
export class TokenAuth {
  readonly mode: "bearer" | "open";
  private entries: Entry[] = [];

  private constructor(mode: "bearer" | "open") {
    this.mode = mode;
  }

  static open(): TokenAuth {
    return new TokenAuth("open");
  }

  /**
   * Parses `token=household:caregiver` pairs separated by commas, e.g.
   *   CAREOS_TOKENS=s3cr3t-token-for-sarah-001=demo:sarah,another-long-secret-for-dad=demo:dad
   */
  static fromSpec(spec: string): TokenAuth {
    const auth = new TokenAuth("bearer");
    for (const raw of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
      const eq = raw.lastIndexOf("="); // household/caregiver ids never contain "=", but a base64 token may end in "="
      const [householdId, caregiverId, ...extra] = (eq < 0 ? "" : raw.slice(eq + 1)).split(":");
      const token = eq < 0 ? "" : raw.slice(0, eq);
      if (!token || !householdId || !caregiverId || extra.length) {
        throw new Error('CAREOS_TOKENS entries must look like "token=household:caregiver"');
      }
      if (token.length < MIN_TOKEN_LENGTH) throw new Error(`CAREOS_TOKENS: a token is shorter than ${MIN_TOKEN_LENGTH} characters`);
      auth.add(token, { householdId, caregiverId });
    }
    if (auth.entries.length === 0) throw new Error("CAREOS_TOKENS is set but contains no tokens");
    return auth;
  }

  /** Distinct households that have a token: these are the tenants to seed at boot. */
  households(): string[] {
    return [...new Set(this.entries.map((e) => e.ctx.householdId))];
  }

  /** Registers a token (also used to mint the server's own internal token). */
  add(token: string, ctx: AuthContext): void {
    this.entries.push({ hash: digest(token), ctx });
  }

  /** A fresh random token that resolves to `ctx`; for in-process callers such as the orchestrator bootstrap. */
  mint(ctx: AuthContext): string {
    const token = randomBytes(24).toString("base64url");
    this.add(token, ctx);
    return token;
  }

  /** Resolves an `Authorization` header to a context, or undefined when it is missing or wrong. */
  authenticate(header: string | undefined): AuthContext | undefined {
    if (this.mode === "open") return OPEN_CONTEXT;
    const token = bearerToken(header);
    if (!token) return undefined;
    const given = digest(token);
    let found: AuthContext | undefined;
    // Check every entry (no early exit) so timing does not reveal which token matched.
    for (const e of this.entries) if (timingSafeEqual(e.hash, given)) found = e.ctx;
    return found;
  }
}

export function bearerToken(header: string | undefined): string | undefined {
  const m = /^Bearer +(\S+)$/i.exec(header ?? "");
  return m?.[1];
}

/** Rejects unauthenticated requests with 401 and a Bearer challenge; otherwise exposes res.locals.auth. */
export function requireAuth(auth: TokenAuth) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = auth.authenticate(req.headers.authorization);
    if (!ctx) {
      res.status(401).set("www-authenticate", 'Bearer realm="careos", error="invalid_token"').json({ error: "unauthorized" });
      return;
    }
    // res.locals is untyped in Express; app.ts reads these through typed accessors.
    res.locals.auth = ctx satisfies AuthContext;
    res.locals.bearer = bearerToken(req.headers.authorization); // kept only so the orchestrator can act as the same caller
    next();
  };
}

/** True for hosts that only accept connections from this machine. */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
