import { SignJWT } from "jose";

/**
 * Signed caller assertion for the MCP → search API hop (ISSUES.md #45).
 *
 * The worker authenticates to scry-nextjs with one shared key. That key proves
 * the request came from this service; it must not also decide which user the
 * service is acting for. It used to: the uid travelled in an unsigned
 * `X-User-Id` header, so any holder of the shared key could name any uid and
 * read any private project.
 *
 * Now the worker mints a short-lived HS256 JWT over a secret shared only with
 * the search API — `{sub: firebaseUid, aud: "scry-search", iss: "scry-mcp",
 * iat, exp, jti}` — and sends it as `X-Scry-Caller`. The search API verifies
 * the signature, the audience and the age before it trusts the subject.
 *
 * This assertion is now the only identity channel. The search API dropped its
 * transition flag and no longer reads `X-User-Id`, so the worker stopped
 * sending it: an unsigned uid would be ignored upstream either way.
 */

export const CALLER_ASSERTION_HEADER = "X-Scry-Caller";
export const CALLER_ASSERTION_AUDIENCE = "scry-search";
export const CALLER_ASSERTION_ISSUER = "scry-mcp";
/**
 * Lifetime in seconds. The verifier rejects anything older than 60s, so this
 * must not exceed that; short enough that a captured assertion is useless
 * almost immediately, long enough to cover a search plus its presign batch.
 */
export const CALLER_ASSERTION_TTL_S = 60;

/**
 * Audience for the MCP → dashboard hop (`/api/agent/issues/*`, feature
 * issue-resolution). Distinct from the search audience so an assertion minted
 * for one service cannot be replayed at the other. The dashboard also reads
 * `agent_client` from the signed claims (audit label only, never a permission).
 * Signed with SCRY_AGENT_ASSERTION_SECRET (D-SEC-1), never the search secret.
 */
export const DASHBOARD_AGENT_AUDIENCE = "scry-dashboard-agent";

export interface AssertionOptions {
  /** Defaults to the search audience. */
  audience?: string;
  /** Extra signed claims (e.g. `agent_client`). Registered claims cannot be overridden. */
  claims?: Record<string, string>;
}

/**
 * Mint an assertion for `uid`. Throws when the secret or uid is missing —
 * callers must not fall back to sending nothing, because "no assertion"
 * means "anonymous" to the verifier and would silently hide private results.
 */
export async function mintCallerAssertion(
  secret: string | undefined,
  uid: string | undefined,
  now: Date = new Date(),
  options: AssertionOptions = {},
): Promise<string> {
  if (!secret) {
    throw new Error(
      options.audience === DASHBOARD_AGENT_AUDIENCE
        ? "SCRY_AGENT_ASSERTION_SECRET is not configured"
        : "SCRY_CALLER_ASSERTION_SECRET is not configured",
    );
  }
  if (!uid) throw new Error("Cannot mint a caller assertion without a user id");

  const iat = Math.floor(now.getTime() / 1000);
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.claims ?? {})) {
    if (!["sub", "aud", "iss", "iat", "exp", "jti", "nbf"].includes(k)) extra[k] = v;
  }
  return new SignJWT(extra)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(uid)
    .setAudience(options.audience ?? CALLER_ASSERTION_AUDIENCE)
    .setIssuer(CALLER_ASSERTION_ISSUER)
    .setIssuedAt(iat)
    .setExpirationTime(iat + CALLER_ASSERTION_TTL_S)
    .setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(secret));
}

/**
 * Reuse an assertion across the calls one tool invocation makes (a search
 * plus a presign per result), re-minting before it is about to expire.
 */
export class CallerAssertionCache {
  private token: string | null = null;
  private expiresAtMs = 0;
  /** Re-mint this many ms before expiry so an in-flight request never carries a stale one. */
  private static readonly REFRESH_MARGIN_MS = 15_000;
  /** What the cached token was minted for; a different uid or claim set re-mints. */
  private cacheKey = "";

  constructor(private readonly options: Omit<AssertionOptions, "claims"> = {}) {}

  async get(
    secret: string | undefined,
    uid: string | undefined,
    now: Date = new Date(),
    claims?: Record<string, string>,
  ): Promise<string> {
    const key = JSON.stringify([uid ?? "", claims ?? {}]);
    if (this.token && key === this.cacheKey && now.getTime() < this.expiresAtMs - CallerAssertionCache.REFRESH_MARGIN_MS) {
      return this.token;
    }
    this.token = await mintCallerAssertion(secret, uid, now, { audience: this.options.audience, claims });
    this.cacheKey = key;
    this.expiresAtMs = now.getTime() + CALLER_ASSERTION_TTL_S * 1000;
    return this.token;
  }
}
