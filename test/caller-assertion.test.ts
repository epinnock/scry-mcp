import { describe, it, expect } from "vitest";
import { jwtVerify, decodeProtectedHeader, decodeJwt } from "jose";
import {
  mintCallerAssertion,
  CallerAssertionCache,
  CALLER_ASSERTION_AUDIENCE,
  CALLER_ASSERTION_ISSUER,
  CALLER_ASSERTION_TTL_S,
  CALLER_ASSERTION_HEADER,
  DASHBOARD_AGENT_AUDIENCE,
} from "../src/utils/caller-assertion";

/**
 * The search API decides who a request is for from this assertion and nothing
 * else (ISSUES.md #45). These tests pin the contract it verifies against:
 * HS256 over the shared secret, aud "scry-search", sub = uid, lifetime ≤ 60s.
 */
const SECRET = "test-caller-assertion-secret";
const key = new TextEncoder().encode(SECRET);

describe("mintCallerAssertion", () => {
  it("produces an HS256 JWT the search API can verify with the shared secret", async () => {
    const token = await mintCallerAssertion(SECRET, "firebase-uid-1");

    expect(decodeProtectedHeader(token).alg).toBe("HS256");
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      audience: CALLER_ASSERTION_AUDIENCE,
      issuer: CALLER_ASSERTION_ISSUER,
      maxTokenAge: "60s",
    });
    expect(payload.sub).toBe("firebase-uid-1");
    expect(typeof payload.jti).toBe("string");
  });

  it("expires within 60 seconds of issue", async () => {
    const now = new Date("2026-09-10T12:00:00Z");
    const token = await mintCallerAssertion(SECRET, "uid", now);
    const { iat, exp } = decodeJwt(token);

    expect(iat).toBe(Math.floor(now.getTime() / 1000));
    expect(exp! - iat!).toBe(CALLER_ASSERTION_TTL_S);
    expect(CALLER_ASSERTION_TTL_S).toBeLessThanOrEqual(60);
  });

  it("does not verify under a different secret", async () => {
    const token = await mintCallerAssertion(SECRET, "uid");
    await expect(
      jwtVerify(token, new TextEncoder().encode("another-secret"), { algorithms: ["HS256"] }),
    ).rejects.toThrow();
  });

  // Sending no assertion means "anonymous" to the verifier. A missing secret
  // must therefore be an error the caller sees, never a silent omission.
  it("throws when the secret is missing", async () => {
    await expect(mintCallerAssertion(undefined, "uid")).rejects.toThrow(/SCRY_CALLER_ASSERTION_SECRET/);
    await expect(mintCallerAssertion("", "uid")).rejects.toThrow(/SCRY_CALLER_ASSERTION_SECRET/);
    await expect(mintCallerAssertion(undefined, "uid", new Date(), { audience: DASHBOARD_AGENT_AUDIENCE })).rejects.toThrow(/SCRY_AGENT_ASSERTION_SECRET/);
  });

  it("throws when the uid is missing", async () => {
    await expect(mintCallerAssertion(SECRET, undefined)).rejects.toThrow(/user id/);
    await expect(mintCallerAssertion(SECRET, "")).rejects.toThrow(/user id/);
  });

  it("is sent under the header name the search API reads", () => {
    expect(CALLER_ASSERTION_HEADER).toBe("X-Scry-Caller");
  });
});

describe("CallerAssertionCache", () => {
  it("reuses an assertion while it is comfortably fresh", async () => {
    const cache = new CallerAssertionCache();
    const t0 = new Date("2026-09-10T12:00:00Z");

    const a = await cache.get(SECRET, "uid", t0);
    const b = await cache.get(SECRET, "uid", new Date(t0.getTime() + 20_000));

    expect(b).toBe(a);
  });

  it("re-mints before the assertion is about to expire", async () => {
    const cache = new CallerAssertionCache();
    const t0 = new Date("2026-09-10T12:00:00Z");

    const a = await cache.get(SECRET, "uid", t0);
    // 50s in: within exp, but inside the refresh margin.
    const b = await cache.get(SECRET, "uid", new Date(t0.getTime() + 50_000));

    expect(b).not.toBe(a);
    expect(decodeJwt(b).iat).toBe(Math.floor(t0.getTime() / 1000) + 50);
  });

  it("propagates a missing secret instead of caching a failure", async () => {
    const cache = new CallerAssertionCache();
    await expect(cache.get(undefined, "uid")).rejects.toThrow();
    // Once configured, it works.
    await expect(cache.get(SECRET, "uid")).resolves.toMatch(/^eyJ/);
  });
});

describe("dashboard-agent assertions (issue-resolution)", () => {
  it("mints for the given audience with extra claims, without letting them override registered claims", async () => {
    const token = await mintCallerAssertion(SECRET, "uid-9", new Date(), {
      audience: DASHBOARD_AGENT_AUDIENCE,
      claims: { agent_client: "claude-code", sub: "someone-else", aud: "scry-search" },
    });
    const { payload } = await jwtVerify(token, key, { audience: DASHBOARD_AGENT_AUDIENCE, issuer: CALLER_ASSERTION_ISSUER });
    expect(payload.sub).toBe("uid-9");
    expect(payload.agent_client).toBe("claude-code");
    expect(payload.aud).toBe(DASHBOARD_AGENT_AUDIENCE);
  });

  it("re-mints when the claims change and reuses the token when they do not", async () => {
    const cache = new CallerAssertionCache({ audience: DASHBOARD_AGENT_AUDIENCE });
    const now = new Date("2026-09-25T00:00:00Z");
    const a = await cache.get(SECRET, "uid", now, { agent_client: "a" });
    const a2 = await cache.get(SECRET, "uid", now, { agent_client: "a" });
    const b = await cache.get(SECRET, "uid", now, { agent_client: "b" });
    expect(a2).toBe(a);
    expect(b).not.toBe(a);
    expect(decodeJwt(b).agent_client).toBe("b");
  });
});
