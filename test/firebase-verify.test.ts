import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  verifyFirebaseIdToken,
  _resetKeyCache,
} from "../src/utils/firebase-verify";
import {
  createTestToken,
  getTestPublicCryptoKey,
  TEST_PROJECT_ID,
  TEST_KID,
} from "./fixtures/tokens";

// Mock importX509 from jose — our test keys are SPKI, not real X.509 certs
vi.mock("jose", async () => {
  const actual = await vi.importActual<typeof import("jose")>("jose");
  return {
    ...actual,
    importX509: async () => {
      // Return the test public CryptoKey regardless of PEM input
      return getTestPublicCryptoKey();
    },
  };
});

function mockGoogleKeys(keys: Record<string, string>) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(keys), {
      headers: { "Cache-Control": "max-age=3600" },
    })
  );
}

describe("verifyFirebaseIdToken", () => {
  beforeEach(() => _resetKeyCache());
  afterEach(() => {
    vi.restoreAllMocks();
    _resetKeyCache();
  });

  it("returns payload for a valid token", async () => {
    mockGoogleKeys({ [TEST_KID]: "fake-pem-mocked" });

    const token = await createTestToken({ uid: "user-1", email: "alice@test.com" });
    const result = await verifyFirebaseIdToken(token, TEST_PROJECT_ID);

    expect(result).not.toBeNull();
    expect(result!.uid).toBe("user-1");
    expect(result!.email).toBe("alice@test.com");
  });

  it("rejects an expired token", async () => {
    mockGoogleKeys({ [TEST_KID]: "fake-pem-mocked" });

    const token = await createTestToken({ expiresIn: "-1h" });
    const result = await verifyFirebaseIdToken(token, TEST_PROJECT_ID);
    expect(result).toBeNull();
  });

  it("rejects a token with wrong audience (project ID)", async () => {
    mockGoogleKeys({ [TEST_KID]: "fake-pem-mocked" });

    const token = await createTestToken({ projectId: "wrong-project" });
    const result = await verifyFirebaseIdToken(token, TEST_PROJECT_ID);
    expect(result).toBeNull();
  });

  it("rejects a token with wrong issuer", async () => {
    mockGoogleKeys({ [TEST_KID]: "fake-pem-mocked" });

    const token = await createTestToken({ projectId: "other-project" });
    const result = await verifyFirebaseIdToken(token, "other-project-2");
    expect(result).toBeNull();
  });

  it("rejects a token with unknown key ID", async () => {
    mockGoogleKeys({ "different-kid": "fake-pem-mocked" });

    const token = await createTestToken();
    const result = await verifyFirebaseIdToken(token, TEST_PROJECT_ID);
    expect(result).toBeNull();
  });

  it("rejects a token with tampered payload", async () => {
    mockGoogleKeys({ [TEST_KID]: "fake-pem-mocked" });

    const token = await createTestToken();
    const parts = token.split(".");
    const payload = JSON.parse(atob(parts[1]));
    payload.email = "hacker@evil.com";
    parts[1] = btoa(JSON.stringify(payload));

    const result = await verifyFirebaseIdToken(parts.join("."), TEST_PROJECT_ID);
    expect(result).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    expect(await verifyFirebaseIdToken("", TEST_PROJECT_ID)).toBeNull();
    expect(await verifyFirebaseIdToken("a.b", TEST_PROJECT_ID)).toBeNull();
    expect(await verifyFirebaseIdToken("not-a-jwt", TEST_PROJECT_ID)).toBeNull();
  });

  it("rejects a token with empty sub", async () => {
    mockGoogleKeys({ [TEST_KID]: "fake-pem-mocked" });

    const token = await createTestToken({ uid: "" });
    const result = await verifyFirebaseIdToken(token, TEST_PROJECT_ID);
    expect(result).toBeNull();
  });

  it("caches Google public keys across calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ [TEST_KID]: "fake-pem-mocked" }), {
        headers: { "Cache-Control": "max-age=3600" },
      })
    );

    const token = await createTestToken();
    await verifyFirebaseIdToken(token, TEST_PROJECT_ID);
    await verifyFirebaseIdToken(token, TEST_PROJECT_ID);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
