import { describe, expect, it } from "vitest";
import { FirebaseAuthHandler } from "../src/firebase-handler";

describe.each(["/health", "/healthz"])("GET %s", (path) => {
  it("defaults missing stamp vars without requiring auth or service bindings", async () => {
    const response = await FirebaseAuthHandler.request(path, {}, {} as Env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json<{ timestamp: string }>();
    expect(body).toEqual({
      ok: true,
      service: "scry-mcp",
      env: "dev",
      commit: "dev",
      branch: null,
      builtAt: null,
      deployId: null,
      actor: null,
      status: "ok",
      server: "scry-mcp",
      version: "dev",
      timestamp: expect.any(String),
    });
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it.each(["production", "staging", "dev"] as const)(
    "reports the %s stamp and legacy fields without exposing other bindings",
    async (environment) => {
      const commit = "0123456789abcdef0123456789abcdef01234567";
      const response = await FirebaseAuthHandler.request(path, {}, {
        SCRY_ENV: environment,
        SCRY_COMMIT: commit,
        SCRY_BRANCH: "chore/deploy-stamp",
        SCRY_BUILD_TIME: "2026-09-10T12:34:56Z",
        SCRY_DEPLOY_ID: "123456789",
        SCRY_ACTOR: "test-actor",
        COOKIE_ENCRYPTION_KEY: "test-only-cookie-key",
        SCRY_SEARCH_API_KEY: "test-only-search-key",
        SENTRY_DSN: "test-only-dsn",
      } as Env);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        ok: true,
        service: "scry-mcp",
        env: environment,
        commit,
        branch: "chore/deploy-stamp",
        builtAt: "2026-09-10T12:34:56Z",
        deployId: "123456789",
        actor: "test-actor",
        status: "ok",
        server: "scry-mcp",
        version: commit,
        timestamp: expect.any(String),
      });
    },
  );
});
