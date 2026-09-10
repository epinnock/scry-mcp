import { describe, it, expect } from "vitest";

declare const process: { env: Record<string, string | undefined> };
const BASE_URL = process.env.MCP_TEST_URL ?? "http://127.0.0.1:8787";

interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

interface RegisterResponse {
  client_id: string;
}

describe("E2E: MCP Server endpoints", () => {
  it("GET / returns a response (not 500)", async () => {
    const res = await fetch(BASE_URL);
    expect(res.status).toBeLessThan(500);
  });

  it.each(["/health", "/healthz"])("GET %s returns a public deploy stamp", async (path) => {
    const res = await fetch(`${BASE_URL}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      ok: true,
      service: "scry-mcp",
      commit: expect.any(String),
      version: expect.any(String),
      ...(process.env.MCP_TEST_ENV && { env: process.env.MCP_TEST_ENV }),
      ...(process.env.MCP_TEST_COMMIT && { commit: process.env.MCP_TEST_COMMIT }),
    });
  });

  it("GET /mcp without auth returns 401", async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("GET /.well-known/oauth-authorization-server returns valid metadata", async () => {
    const res = await fetch(`${BASE_URL}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as OAuthMetadata;
    expect(body).toHaveProperty("authorization_endpoint");
    expect(body).toHaveProperty("token_endpoint");
    expect(body).toHaveProperty("registration_endpoint");
    expect(body.authorization_endpoint).toContain("/authorize");
    expect(body.token_endpoint).toContain("/token");
    expect(new URL(body.authorization_endpoint).origin).toBe(new URL(BASE_URL).origin);
    expect(new URL(body.token_endpoint).origin).toBe(new URL(BASE_URL).origin);
    expect(new URL(body.registration_endpoint).origin).toBe(new URL(BASE_URL).origin);
  });

  it("POST /register allows dynamic client registration", async () => {
    const res = await fetch(`${BASE_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1:33333/callback"],
        client_name: "e2e-test-client",
        token_endpoint_auth_method: "none",
      }),
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as RegisterResponse;
    expect(body).toHaveProperty("client_id");
    expect(typeof body.client_id).toBe("string");
  });

  it("GET /authorize without valid OAuth params returns error", async () => {
    const res = await fetch(`${BASE_URL}/authorize`);
    // OAuthProvider returns 500 when required params are missing
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("GET /authorize with valid client_id returns HTML login page", async () => {
    // First register a client
    const regRes = await fetch(`${BASE_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1:33333/callback"],
        client_name: "e2e-login-test",
        token_endpoint_auth_method: "none",
      }),
    });
    const { client_id } = (await regRes.json()) as RegisterResponse;

    const authUrl = new URL(`${BASE_URL}/authorize`);
    authUrl.searchParams.set("client_id", client_id);
    authUrl.searchParams.set("redirect_uri", "http://127.0.0.1:33333/callback");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("code_challenge", "test-challenge");
    authUrl.searchParams.set("code_challenge_method", "S256");

    const res = await fetch(authUrl.toString(), { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("firebase.initializeApp");
    expect(html).toContain("Sign in to Scry");
  });
});
