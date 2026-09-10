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
 * Mint an assertion for `uid`. Throws when the secret or uid is missing —
 * callers must not fall back to sending nothing, because "no assertion"
 * means "anonymous" to the verifier and would silently hide private results.
 */
export async function mintCallerAssertion(
  secret: string | undefined,
  uid: string | undefined,
  now: Date = new Date(),
): Promise<string> {
  if (!secret) throw new Error("SCRY_CALLER_ASSERTION_SECRET is not configured");
  if (!uid) throw new Error("Cannot mint a caller assertion without a user id");

  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(uid)
    .setAudience(CALLER_ASSERTION_AUDIENCE)
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

  async get(secret: string | undefined, uid: string | undefined, now: Date = new Date()): Promise<string> {
    if (this.token && now.getTime() < this.expiresAtMs - CallerAssertionCache.REFRESH_MARGIN_MS) {
      return this.token;
    }
    this.token = await mintCallerAssertion(secret, uid, now);
    this.expiresAtMs = now.getTime() + CALLER_ASSERTION_TTL_S * 1000;
    return this.token;
  }
}
