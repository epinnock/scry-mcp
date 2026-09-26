/**
 * Feature observability-request-id: one x-scry-request-id per MCP tool call.
 * Contract: scry-management/features/observability-request-id/briefs/_request-id-contract.md.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScryMCP, type AuthProps } from "../src/mcp";
import { REQUEST_ID_HEADER, acceptOrMint, isValidRequestId, mintRequestId } from "../src/lib/request-id";
import * as Sentry from "@sentry/cloudflare";
import {
  buildRequestLine,
  confirmProjectAccess,
  currentRequestId,
  requestIdHeaders,
  runWithRequestId,
  toolErrorCode,
  withRequestIdInErrors,
  wrapToolHandler,
  type RequestLine,
} from "../src/lib/tool-request";
import { beforeBreadcrumb, sentryOptions } from "../src/lib/sentry-options";
import { scrubBreadcrumb, scrubEvent } from "../src/lib/sentry-scrub";
import { ulidToHex } from "../src/telemetry/ids";
import { CreditsClient } from "../src/credits";

declare module "cloudflare:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Workers pool environment augmentation.
  interface ProvidedEnv extends Env {}
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const UUID = "6fc0a1a8-f408-4725-b426-617a35de8d44";

// Canary values: none of these may appear in a request line or a Sentry event.
const CANARY_QUERY = "canary-secret-product-name-7f3a";
const CANARY_EMAIL = "canary.user@example.test";
const CANARY_UID = "canary-firebase-uid-91b2";
const CANARY_KEY = "sk-canaryKEY1234567890abcdef";
const CANARY_BEARER = "Bearer canary-bearer-token-xyz";
const CANARY_GRANT = "canary-grant-token-abc";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("request-id module", () => {
  it("mints 26-char Crockford ULIDs whose first 10 chars encode the time", () => {
    const a = mintRequestId(Date.UTC(2026, 8, 26));
    const b = mintRequestId(Date.UTC(2026, 8, 26));
    expect(a).toMatch(ULID);
    expect(a).not.toBe(b);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
    expect(a.startsWith("01M")).toBe(true); // a 2026 id starts 01M…
    expect(ulidToHex(a)!.slice(0, 12)).toBe(Date.UTC(2026, 8, 26).toString(16).padStart(12, "0"));
  });

  it("accepts a ULID or a lowercase UUID v4, and nothing else", () => {
    expect(isValidRequestId(mintRequestId())).toBe(true);
    expect(isValidRequestId(UUID)).toBe(true);
    for (const bad of [
      undefined, "", "<script>alert(1)</script>", "A".repeat(300), UUID.toUpperCase(),
      "01M3EQG44Y0J8F2K6ZP9RX1T7I", // I is not Crockford
      "01m3eqg44y0j8f2k6zp9rx1t7c", // lowercase ULID
      "6fc0a1a8-f408-1725-b426-617a35de8d44", // UUID v1
      `${mintRequestId()}\nx`,
    ]) {
      expect(isValidRequestId(bad)).toBe(false);
    }
  });

  it("guarantee-4 malformed inbound id replaced, never reflected", () => {
    expect(acceptOrMint(UUID)).toBe(UUID);
    const bad = "<script>x</script>";
    const out = acceptOrMint(bad);
    expect(out).toMatch(ULID);
    expect(out).not.toContain("script");
  });
});

describe("request line", () => {
  it("has only the allow-listed keys", () => {
    const line = buildRequestLine({ requestId: "01M3EQG44Y0J8F2K6ZP9RX1T7C", tool: "search_components", outcome: "error", ms: 12.4, code: "SEARCH_API_500", projectId: "4vR5abc" });
    expect(line).toEqual({ msg: "request", request_id: "01M3EQG44Y0J8F2K6ZP9RX1T7C", route: "search_components", outcome: "error", ms: 12, code: "SEARCH_API_500", project_id: "4vR5abc" });
  });

  it("drops code on success and unsafe values (spaces, emails, oversize)", () => {
    const line = buildRequestLine({ requestId: "01M3EQG44Y0J8F2K6ZP9RX1T7C", tool: "whoami", outcome: "ok", ms: 3, code: "X", projectId: `${CANARY_EMAIL} ${CANARY_QUERY}` });
    expect(Object.keys(line).sort()).toEqual(["ms", "msg", "outcome", "request_id", "route"]);
    expect(buildRequestLine({ requestId: "x", tool: "t", outcome: "ok", ms: 1, projectId: "p".repeat(129) }).project_id).toBeUndefined();
  });
});

describe("error bodies", () => {
  it("adds request_id to every JSON error block and leaves others alone", () => {
    const err = { content: [{ type: "text", text: JSON.stringify({ error: "E", message: "m", retryable: false }) }, { type: "text", text: "plain" }], isError: true };
    const out = withRequestIdInErrors(err, "RID");
    expect(JSON.parse(out.content[0].text)).toEqual({ error: "E", message: "m", retryable: false, request_id: "RID" });
    expect(out.content[1].text).toBe("plain");
    expect(toolErrorCode(out)).toBe("E");
    const ok = { content: [{ type: "text", text: JSON.stringify({ error: "not an error result" }) }] };
    expect(withRequestIdInErrors(ok, "RID")).toBe(ok);
    expect(toolErrorCode(ok)).toBeUndefined();
  });
});

describe("wrapToolHandler", () => {
  it("runs the handler inside the id's context and emits one line", async () => {
    const lines: RequestLine[] = [];
    let seen: string | undefined;
    let headers: Record<string, string> = {};
    const h = wrapToolHandler("search_components", async (_args: unknown, _extra: unknown) => {
      seen = currentRequestId();
      headers = requestIdHeaders();
      confirmProjectAccess("proj-1"); // what search / the dashboard answering 2xx does
      return { content: [{ type: "text", text: "ok" }] };
    }, { emit: l => lines.push(l) });
    await h({ query: CANARY_QUERY, project_id: "proj-1" }, {});
    expect(seen).toMatch(ULID);
    expect(headers).toEqual({ [REQUEST_ID_HEADER]: seen });
    expect(lines).toEqual([{ msg: "request", request_id: seen, route: "search_components", outcome: "ok", ms: expect.any(Number), project_id: "proj-1" }]);
    expect(currentRequestId()).toBeUndefined();
    expect(requestIdHeaders()).toEqual({});
  });

  it("low #12: project_id from caller input alone is never logged", async () => {
    const lines: RequestLine[] = [];
    const ok = wrapToolHandler("search_components", async () => ({ content: [] }), { emit: l => lines.push(l) });
    await ok({ query: "q", project_id: "someone-elses-project" }, {});
    const denied = wrapToolHandler("search_components", async () => ({
      content: [{ type: "text", text: JSON.stringify({ error: "ACCESS_DENIED", message: "no", retryable: false }) }], isError: true,
    }), { emit: l => lines.push(l) });
    await denied({ query: "q", project_id: "someone-elses-project" }, {});
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).not.toHaveProperty("project_id");
    expect(lines[1]).toMatchObject({ outcome: "error", code: "ACCESS_DENIED" });
  });

  it("confirmProjectAccess is a no-op outside a tool call and drops unsafe ids", async () => {
    expect(() => confirmProjectAccess("proj-1")).not.toThrow();
    const lines: RequestLine[] = [];
    const h = wrapToolHandler("t", async () => { confirmProjectAccess("bad id <x>"); return { content: [] }; }, { emit: l => lines.push(l) });
    await h({}, {});
    expect(lines[0]).not.toHaveProperty("project_id");
  });

  it("always mints: an inbound x-scry-request-id is ignored (trust rule)", async () => {
    const ids: Array<string | undefined> = [];
    const h = wrapToolHandler("whoami", async () => { ids.push(currentRequestId()); return { content: [] }; }, { emit: () => {} });
    await h({ requestInfo: { headers: { [REQUEST_ID_HEADER]: UUID } } });
    await h({ requestInfo: { headers: new Headers({ [REQUEST_ID_HEADER]: "01M3EQG44Y0J8F2K6ZP9RX1T7C" }) } });
    await h({ requestInfo: { headers: { [REQUEST_ID_HEADER]: "<bad>" } } });
    for (const id of ids) expect(id).toMatch(ULID);
    expect(ids).not.toContain(UUID);
    expect(ids).not.toContain("01M3EQG44Y0J8F2K6ZP9RX1T7C");
    expect(new Set(ids).size).toBe(3);
  });

  it("reports a thrown handler with request_id + tool tags and returns a structured error", async () => {
    const lines: RequestLine[] = [];
    const reports: Array<Record<string, string>> = [];
    const h = wrapToolHandler("search_by_image", async () => { throw new Error(`boom ${CANARY_KEY}`); }, {
      emit: l => lines.push(l),
      report: (_err, tags) => reports.push(tags),
    });
    const r = await h({}, {}) as { isError: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body).toMatchObject({ error: "INTERNAL_ERROR", retryable: true });
    expect(body.request_id).toMatch(ULID);
    expect(r.content[0].text).not.toContain(CANARY_KEY);
    expect(reports).toEqual([{ request_id: body.request_id, tool: "search_by_image" }]);
    expect(lines[0]).toMatchObject({ request_id: body.request_id, outcome: "error", code: "INTERNAL_ERROR" });
  });

  it("maps an abort to UPSTREAM_TIMEOUT", async () => {
    const h = wrapToolHandler("t", async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }, { emit: () => {}, report: () => {} });
    const r = await h({}) as { content: Array<{ text: string }> };
    expect(JSON.parse(r.content[0].text).error).toBe("UPSTREAM_TIMEOUT");
  });

  it("guarantee-6 sentry/log failure does not change the response", async () => {
    const answer = { content: [{ type: "text", text: "fine" }] };
    const ok = wrapToolHandler("t", async () => answer, { emit: () => { throw new Error("log down"); } });
    expect(await ok({})).toBe(answer);
    const failing = wrapToolHandler("t", async () => { throw new Error("x"); }, {
      emit: () => { throw new Error("log down"); },
      report: () => { throw new Error("sentry down"); },
    });
    const r = await failing({}) as { isError: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toBe("INTERNAL_ERROR");
  });

  it("Sentry is a no-op without a DSN: the default reporter never throws", async () => {
    const h = wrapToolHandler("t", async () => { throw new Error("x"); }, { emit: () => {} });
    const r = await h({}) as { isError: boolean };
    expect(r.isError).toBe(true);
  });

  it("runWithRequestId scopes the id", () => {
    expect(runWithRequestId("RID", () => currentRequestId())).toBe("RID");
  });
});

describe("Sentry options", () => {
  it("environment follows SCRY_ENV, PII off, bodies off, no DSN → undefined", () => {
    expect(sentryOptions({ SCRY_ENV: "staging" }).environment).toBe("staging");
    expect(sentryOptions({ SCRY_ENV: "production" }).environment).toBe("production");
    expect(sentryOptions({}).environment).toBe("unknown");
    const o = sentryOptions({ SENTRY_DSN: "", SCRY_ENV: "staging", SENTRY_RELEASE: "abc" });
    expect(o.dsn).toBeUndefined();
    expect(o.release).toBe("abc");
    expect(o.sendDefaultPii).toBe(false);
    expect(o.dataCollection).toEqual({ userInfo: false, httpBodies: [] });
    expect(o.initialScope.tags.service).toBe("scry-mcp");
  });

  it("should-fix #7: console breadcrumbs are dropped, other breadcrumbs are scrubbed", () => {
    expect(beforeBreadcrumb({ category: "console", level: "log", message: `uid ${CANARY_UID}` })).toBeNull();
    expect(beforeBreadcrumb({ category: "fetch", data: { url: `https://s.test/?k=${CANARY_KEY}` } }).data.url).not.toContain(CANARY_KEY);
    expect(sentryOptions({}).beforeBreadcrumb).toBe(beforeBreadcrumb);
  });

  it("should-fix #7: a console line inside a failing tool is not in the captured event's breadcrumbs", async () => {
    // A real SDK client with the Worker's default integrations (console
    // included) and our options; the transport records envelopes instead of
    // sending them.
    const envelopes: unknown[] = [];
    const options = {
      ...sentryOptions({ SENTRY_DSN: "https://publickey@o0.ingest.sentry.io/1", SCRY_ENV: "staging" }),
      stackParser: () => [],
      transport: () => ({
        send: async (envelope: unknown) => { envelopes.push(envelope); return {}; },
        flush: async () => true,
      }),
    };
    const client = new Sentry.CloudflareClient({ ...options, integrations: Sentry.getDefaultIntegrations(options) } as never);
    const lines: RequestLine[] = [];
    const previous = Sentry.getCurrentScope().getClient();
    Sentry.getCurrentScope().setClient(client);
    Sentry.getIsolationScope().clearBreadcrumbs();
    client.init();
    try {
      // Control: a breadcrumb added directly survives, so an empty list below is
      // the filter at work, not a client that records nothing.
      Sentry.addBreadcrumb({ category: "custom", message: "control-crumb" });
      const h = wrapToolHandler("generate_image", async () => {
        console.log(JSON.stringify({ tool: "generate_image", userId: CANARY_UID, errorText: CANARY_QUERY }));
        throw new Error("gemini failed");
      }, { emit: l => lines.push(l) });
      const r = await h({ prompt: "p" }, {}) as { isError: boolean };
      expect(r.isError).toBe(true);
      await client.flush(1000);
    } finally {
      Sentry.getCurrentScope().setClient(previous);
      await client.close(1000);
    }
    const events = envelopes.flatMap(e => (e as [unknown, Array<[{ type: string }, Record<string, unknown>]>])[1])
      .filter(([header]) => header.type === "event")
      .map(([, event]) => event as { breadcrumbs?: Array<{ category?: string; message?: string }>; tags?: Record<string, string> });
    expect(events).toHaveLength(1);
    const crumbs = events[0].breadcrumbs ?? [];
    expect(crumbs.map(c => c.message)).toContain("control-crumb");
    expect(crumbs.some(c => c.category === "console")).toBe(false);
    const text = JSON.stringify(events[0]);
    expect(text).not.toContain(CANARY_UID);
    expect(text).not.toContain(CANARY_QUERY);
    expect(events[0].tags).toMatchObject({ tool: "generate_image", request_id: lines[0].request_id });
  });

  it("guarantee-3 request line and Sentry event carry no secrets or query text", () => {
    const event = scrubEvent({
      message: `failed for ${CANARY_BEARER} key ${CANARY_KEY} https://x.test/p?q=${CANARY_QUERY}`,
      request: {
        url: `https://mcp.test/mcp?q=${CANARY_QUERY}`,
        headers: { Authorization: CANARY_BEARER, "X-Scry-Caller": "eyJa.eyJb.sig", "x-scry-grant-token": CANARY_GRANT, "cf-aig-authorization": CANARY_BEARER, "x-scry-request-id": "01M3EQG44Y0J8F2K6ZP9RX1T7C" },
        data: { text: CANARY_QUERY },
        query_string: `q=${CANARY_QUERY}`,
      },
      exception: { values: [{ value: `upstream said ${CANARY_KEY}` }] },
      extra: { note: CANARY_BEARER },
    });
    const crumb = scrubBreadcrumb({ message: `GET https://s.test/api?x=${CANARY_QUERY}`, data: { url: `https://s.test/?k=${CANARY_KEY}` } });
    const line = buildRequestLine({ requestId: "01M3EQG44Y0J8F2K6ZP9RX1T7C", tool: "search_components", outcome: "error", ms: 1, code: CANARY_EMAIL, projectId: CANARY_QUERY + " " });
    const all = JSON.stringify([event, crumb, line]);
    for (const canary of [CANARY_QUERY, CANARY_EMAIL, CANARY_KEY, "canary-bearer-token-xyz", CANARY_GRANT, "eyJa.eyJb.sig"]) {
      expect(all).not.toContain(canary);
    }
    expect(event.request.headers["x-scry-request-id"]).toBe("01M3EQG44Y0J8F2K6ZP9RX1T7C");
  });
});

// --- Through the real ScryMCP Durable Object and MCP client ---

class TestScryMCP extends ScryMCP {
  constructor(state: DurableObjectState, bindings: Env) {
    super(state, bindings);
  }
}

const props: AuthProps = { firebaseUid: CANARY_UID, email: CANARY_EMAIL, displayName: "Canary", emailVerified: true };

async function withClient(overrides: Partial<Env>, test: (client: Client) => Promise<void>) {
  const stub = env.MCP_OBJECT.get(env.MCP_OBJECT.newUniqueId());
  await runInDurableObject(stub, async (_instance, state) => {
    const agent = new TestScryMCP(state, {
      ...env,
      SCRY_ENV: "staging",
      SCRY_SEARCH_API_URL: "https://search.example.test",
      SCRY_SEARCH_API_KEY: "test-api-key",
      SCRY_CALLER_ASSERTION_SECRET: "test-caller-assertion-secret",
      GEMINI_API_KEY: "test-gemini-key",
      MCP_USAGE: undefined,
      ...overrides,
    });
    agent.props = props;
    await agent.init();
    const client = new Client({ name: "reqid-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await agent.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await test(client);
    } finally {
      await client.close();
      await agent.server.close();
    }
  });
}

type Seen = { url: string; headers: Headers };

function mockFetch(respond: (url: string) => Response): Seen[] {
  const seen: Seen[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    seen.push({ url, headers: new Headers(init?.headers) });
    return respond(url);
  });
  return seen;
}

function requestLines(spy: { mock: { calls: unknown[][] } }): RequestLine[] {
  return spy.mock.calls
    .map(c => { try { return JSON.parse(String(c[0])); } catch { return null; } })
    .filter((l): l is RequestLine => l?.msg === "request");
}

const SEARCH_OK = { results: [], pagination: { page: 1, limit: 5, total: 0 } };

describe("tool calls through ScryMCP", () => {
  it("search_components mints one id, forwards it to search and logs it in the end line", async () => {
    const seen = mockFetch(() => Response.json(SEARCH_OK));
    const log = vi.spyOn(console, "log");
    await withClient({}, async (client) => {
      const r = await client.callTool({ name: "search_components", arguments: { query: CANARY_QUERY, limit: 5, project_id: "proj-1" } });
      expect(r.isError).not.toBe(true);
    });
    const search = seen.filter(s => s.url.endsWith("/api/search"));
    expect(search).toHaveLength(1);
    const id = search[0].headers.get(REQUEST_ID_HEADER)!;
    expect(id).toMatch(ULID);
    expect(search[0].headers.get("Authorization")).toBe("Bearer test-api-key");
    const lines = requestLines(log);
    expect(lines).toEqual([{ msg: "request", request_id: id, route: "search_components", outcome: "ok", ms: expect.any(Number), project_id: "proj-1" }]);
    // guarantee-3: no uid, email or query text in the request line
    const text = JSON.stringify(lines);
    for (const canary of [CANARY_UID, CANARY_EMAIL, CANARY_QUERY]) expect(text).not.toContain(canary);
  });

  it("low #12: search_components for a project the caller cannot access logs no project_id", async () => {
    mockFetch(() => Response.json({ error: "ACCESS_DENIED", message: "no access" }, { status: 403 }));
    const log = vi.spyOn(console, "log");
    await withClient({}, async (client) => {
      const r = await client.callTool({ name: "search_components", arguments: { query: "button", project_id: "not-my-project" } });
      expect(r.isError).toBe(true);
    });
    const lines = requestLines(log);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ route: "search_components", outcome: "error", code: "ACCESS_DENIED" });
    expect(lines[0]).not.toHaveProperty("project_id");
  });

  it("low #12: issue tools log project_id only after the dashboard answered", async () => {
    const dashEnv = {
      ISSUE_TOOLS_ENABLED: "1",
      SCRY_DASHBOARD_API_URL: "https://dashboard.example.test",
      SCRY_AGENT_ASSERTION_SECRET: "agent-secret",
    };
    mockFetch(() => Response.json({ error: "not_found" }, { status: 404 }));
    let log = vi.spyOn(console, "log");
    await withClient(dashEnv, async (client) => {
      await client.callTool({ name: "list_design_issues", arguments: { project_id: "not-my-project" } });
    });
    let lines = requestLines(log);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ route: "list_design_issues", outcome: "error" });
    expect(lines[0]).not.toHaveProperty("project_id");

    vi.restoreAllMocks();
    mockFetch(() => Response.json({ issues: [], next_cursor: null }));
    log = vi.spyOn(console, "log");
    await withClient(dashEnv, async (client) => {
      await client.callTool({ name: "list_design_issues", arguments: { project_id: "proj-1" } });
    });
    lines = requestLines(log);
    expect(lines).toEqual([expect.objectContaining({ route: "list_design_issues", outcome: "ok", project_id: "proj-1" })]);
  });

  it("each tool call gets its own id", async () => {
    const seen = mockFetch(() => Response.json(SEARCH_OK));
    await withClient({}, async (client) => {
      await client.callTool({ name: "search_components", arguments: { query: "a" } });
      await client.callTool({ name: "search_components", arguments: { query: "b" } });
    });
    const ids = seen.filter(s => s.url.endsWith("/api/search")).map(s => s.headers.get(REQUEST_ID_HEADER));
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("a search error's JSON carries the same request_id that was forwarded", async () => {
    const seen = mockFetch(() => new Response("upstream broke", { status: 500 }));
    const log = vi.spyOn(console, "log");
    let body: Record<string, unknown> = {};
    await withClient({}, async (client) => {
      const r = await client.callTool({ name: "search_components", arguments: { query: "button" } });
      expect(r.isError).toBe(true);
      body = JSON.parse((r.content as Array<{ text: string }>)[0].text);
    });
    const id = seen.find(s => s.url.endsWith("/api/search"))!.headers.get(REQUEST_ID_HEADER);
    expect(body).toMatchObject({ error: "SEARCH_API_500", retryable: true, request_id: id });
    expect(requestLines(log)).toEqual([expect.objectContaining({ request_id: id, outcome: "error", code: "SEARCH_API_500" })]);
  });

  it("a network failure to search becomes a structured error with request_id", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));
    await withClient({}, async (client) => {
      const r = await client.callTool({ name: "search_components", arguments: { query: "button" } });
      expect(r.isError).toBe(true);
      const body = JSON.parse((r.content as Array<{ text: string }>)[0].text);
      expect(body).toMatchObject({ error: "INTERNAL_ERROR", retryable: true });
      expect(body.request_id).toMatch(ULID);
    });
  });

  it("issue tools forward the id to the dashboard", async () => {
    const seen = mockFetch(() => Response.json({ issues: [], next_cursor: null }));
    await withClient({
      ISSUE_TOOLS_ENABLED: "1",
      SCRY_DASHBOARD_API_URL: "https://dashboard.example.test",
      SCRY_AGENT_ASSERTION_SECRET: "agent-secret",
    }, async (client) => {
      await client.callTool({ name: "list_design_issues", arguments: { project_id: "proj-1" } });
    });
    const dash = seen.filter(s => s.url.startsWith("https://dashboard.example.test/api/agent/issues"));
    expect(dash).toHaveLength(1);
    expect(dash[0].headers.get(REQUEST_ID_HEADER)).toMatch(ULID);
  });

  it("generate_image uses the request id as its gateway run and forwards it to search", async () => {
    const seen = mockFetch((url) => {
      if (url.includes(":generateContent")) {
        return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { data: "aW1hZ2U=", mimeType: "image/png" } }] } }] });
      }
      if (url.endsWith("/api/credits/reserve")) return Response.json({ held: true, amount: 40, would_block: false, balance: { available: 100, resets_at: "2030-01-01" } });
      if (url.endsWith("/api/credits/settle")) return Response.json({ balance: { available: 60, resets_at: "2030-01-01" } });
      if (url.endsWith("/api/image/upload")) return Response.json({ success: true });
      if (url.endsWith("/api/image/presign")) return Response.json({ url: "https://images.example.test/i.png", expires_at: "2030-01-01T00:00:00Z" });
      if (url.includes("firestore") || url.includes("oauth2")) return Response.json({});
      return new Response("unexpected", { status: 500 });
    });
    await withClient({ LLM_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/acct/scry-stage", CF_AIG_TOKEN: "t" }, async (client) => {
      const r = await client.callTool({ name: "generate_image", arguments: { prompt: "A blue button" } });
      expect(r.isError).not.toBe(true);
    });
    const gemini = seen.find(s => s.url.includes(":generateContent"))!;
    const run = JSON.parse(gemini.headers.get("cf-aig-metadata")!).run;
    expect(run).toMatch(ULID);
    // Google is not a Scry hop: the header is not sent there.
    expect(gemini.headers.get(REQUEST_ID_HEADER)).toBeNull();
    for (const s of seen.filter(s => s.url.startsWith("https://search.example.test"))) {
      expect(s.headers.get(REQUEST_ID_HEADER)).toBe(run);
    }
  });
});

describe("credits ledger hop", () => {
  it("forwards the tool call's id to the diff-service credits API", async () => {
    const seen = mockFetch(() => Response.json({ ok: true, hold: { amount: 40 }, balance: { available: 100, resets_at: "2030-01-01" } }));
    const client = new CreditsClient({ CREDITS_API_URL: "https://credits.example.test", CREDITS_API_TOKEN: "tok" } as never);
    await runWithRequestId("01M3EQG44Y0J8F2K6ZP9RX1T7C", () => client.reserve({ walletId: "w", task: "t", refId: "r", actorUid: "u" }));
    expect(seen[0].headers.get(REQUEST_ID_HEADER)).toBe("01M3EQG44Y0J8F2K6ZP9RX1T7C");
    await client.reserve({ walletId: "w", task: "t", refId: "r", actorUid: "u" });
    expect(seen[1].headers.get(REQUEST_ID_HEADER)).toBeNull();
  });
});
