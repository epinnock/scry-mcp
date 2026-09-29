/**
 * log-standardization (builder C, mcp): the request line and diagnostics are schema v1 (shared scry-log),
 * the canary corpus never appears in any emitted line, the request id in the body/forwarded header equals the
 * logged one, and a broken sink never fails a tool call. Guarantees are named `guarantee-N`.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScryMCP, type AuthProps } from "../src/mcp";
import { REQUEST_ID_HEADER } from "../src/lib/request-id";
import { wrapToolHandler } from "../src/lib/tool-request";
import { withClientNote } from "../src/lib/client-note";
import { validateLine, type LogLine, type Sink } from "../src/lib/scry-log";
import { clientOf, errCodeOf, getLogger, hashUid, msgWords, setLogSinkForTest } from "../src/lib/log";
import canary from "./fixtures/scry-log-canary.json";

declare module "cloudflare:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Workers pool environment augmentation.
  interface ProvidedEnv extends Env {}
}

const UID = "canary-firebase-uid-91b2";
const EMAIL = canary.values.email;
const props: AuthProps = { firebaseUid: UID, email: EMAIL, displayName: "Canary", emailVerified: true };

class TestScryMCP extends ScryMCP {
  constructor(state: DurableObjectState, bindings: Env) {
    super(state, bindings);
  }
}

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
    const client = new Client({ name: "log-test", version: "1.0.0" });
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

function captureConsole() {
  const out: string[] = [];
  for (const m of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      out.push(a.map(x => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(" "));
    });
  }
  return out;
}
const jsonLines = (out: string[]) => out.filter(l => l.startsWith("{")).map(l => JSON.parse(l) as Record<string, unknown>);

function collectingSink(): Sink & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  return { lines, write: l => { lines.push(l); }, flush: async () => {} };
}

afterEach(() => {
  setLogSinkForTest(null);
  vi.restoreAllMocks();
});

/** The request line hashes the uid off the request path, so lines land a few ticks after the tool returns. */
const settle = () => new Promise(r => setTimeout(r, 25));

const SEARCH_OK = { results: [], pagination: { page: 1, limit: 5, total: 0 } };

describe("schema v1 golden lines", () => {
  it("ok, denied and upstream-500 tool calls emit lines that validate against schema v1", async () => {
    const out = captureConsole();
    let respond: () => Response = () => Response.json(SEARCH_OK);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => respond());
    await withClient({}, async client => {
      await client.callTool({ name: "search_components", arguments: { query: "button", project_id: "proj-1" } });
      respond = () => Response.json({ error: "ACCESS_DENIED", message: "no" }, { status: 403 });
      await client.callTool({ name: "search_components", arguments: { query: "button", project_id: "other" } });
      respond = () => new Response("broke", { status: 500 });
      await client.callTool({ name: "search_components", arguments: { query: "button" } });
    });
    await settle();
    const lines = jsonLines(out).filter(l => l.msg === "request");
    expect(lines.map(l => l.status)).toEqual([200, 403, 500]);
    expect(lines.map(l => l.level)).toEqual(["info", "warn", "error"]);
    expect(lines.map(l => l.err_code)).toEqual([undefined, "access_denied", "search_api_500"]);
    for (const l of jsonLines(out)) {
      const v = validateLine(l);
      expect(v.errors).toEqual([]);
      expect(l.service).toBe("mcp");
    }
  });

  it("uid_hash is the first 12 hex of sha256(uid + salt), never the uid", async () => {
    const out = captureConsole();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(SEARCH_OK));
    await withClient({ SCRY_LOG_SALT: "test-salt" } as Partial<Env>, async client => {
      await client.callTool({ name: "search_components", arguments: { query: "x" } });
    });
    const [line] = jsonLines(out).filter(l => l.msg === "request");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${UID}test-salt`));
    const expected = Array.from(new Uint8Array(digest).slice(0, 6), b => b.toString(16).padStart(2, "0")).join("");
    expect(line.uid_hash).toBe(expected);
    expect(await hashUid(UID, "test-salt")).toBe(expected);
    expect(await hashUid(undefined, "s")).toBeUndefined();
    expect(out.join("\n")).not.toContain(UID);
  });
});

describe("mcp.ts diagnostics (was :198-206 raw uid, :422 Gemini error text)", () => {
  it("guarantee-1 a Gemini failure whose body quotes the prompt logs a fixed err_code only, with uid_hash not uid", async () => {
    const out = captureConsole();
    const secretPrompt = `${canary.values.query_url} ${canary.values.email} ${canary.values.sk_key}`;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ error: { message: `Blocked prompt: ${secretPrompt}` } }), { status: 400 }),
    );
    await withClient({ SCRY_LOG_SALT: "test-salt" } as Partial<Env>, async client => {
      const r = await client.callTool({ name: "generate_image", arguments: { prompt: "a blue button" } });
      expect(r.isError).toBe(true);
    });
    await new Promise(r => setTimeout(r, 20)); // diagnostics hash the uid asynchronously
    const all = out.join("\n");
    for (const m of canary.markers) expect(all).not.toContain(m);
    expect(all).not.toContain(UID);
    expect(all).not.toContain("Blocked prompt");
    const lines = jsonLines(out);
    for (const l of lines) expect(validateLine(l).ok).toBe(true);
    const diag = lines.find(l => l.msg === "generate Image Via Gemini");
    expect(diag).toMatchObject({ level: "warn", status: 400, err_code: "generate_image_via_gemini_failed" });
    expect(diag!.uid_hash).toMatch(/^[0-9a-f]{12}$/);
    const req = lines.find(l => l.msg === "request" && l.route === "generate_image");
    expect(req).toMatchObject({ level: "error", err_code: "gemini_api_error" });
  });
});

describe("guarantee-1 canary corpus never reaches a log line", () => {
  it("canary in tool arguments, project id, client header and thrown-error text", async () => {
    const sink = collectingSink();
    setLogSinkForTest(sink);
    const out = captureConsole();
    const values = Object.values(canary.values);
    const boom = wrapToolHandler(
      "search_components",
      async () => { throw new Error(`upstream ${values.join(" ")}`); },
      { logger: getLogger({ SCRY_ENV: "staging" }), identify: () => ({ uid: EMAIL, salt: "s" }), report: () => {} },
    );
    for (const v of values) {
      await boom({ query: v, project_id: v }, { requestInfo: { headers: new Headers({ "x-scry-client": v, [REQUEST_ID_HEADER]: v }) } });
    }
    await settle();
    const text = JSON.stringify(sink.lines) + out.join("\n");
    expect(sink.lines).toHaveLength(values.length);
    for (const m of canary.markers) expect(text).not.toContain(m);
    for (const l of sink.lines) expect(validateLine(l).ok).toBe(true);
  });

  it("logs a well-formed x-scry-client, drops others", async () => {
    const sink = collectingSink();
    setLogSinkForTest(sink);
    const h = wrapToolHandler("whoami", async () => ({ content: [] }), { logger: getLogger({ SCRY_ENV: "staging" }) });
    await h({}, { requestInfo: { headers: new Headers({ "x-scry-client": "scry-link/0.9.0" }) } });
    await h({}, { requestInfo: { headers: { "x-scry-client": "<b>x</b>" } } });
    await h({}, { requestInfo: { headers: { "x-scry-client": "scry-cli/1.2.3" } } });
    await h({});
    await settle();
    expect(sink.lines.map(l => l.client)).toEqual(["scry-link/0.9.0", undefined, "scry-cli/1.2.3", undefined]);
    expect(clientOf(`a/${"9".repeat(200)}`)).toBeUndefined();
  });

  it("helpers are total", () => {
    expect(errCodeOf("SEARCH_API_500")).toBe("search_api_500");
    expect(errCodeOf(canary.values.email)).toMatch(/^[a-z][a-z0-9_.]{0,47}$/);
    expect(errCodeOf(undefined)).toBe("tool_error");
    expect(msgWords("generateImageViaGemini")).toBe("generate Image Via Gemini");
    expect(msgWords("issues:list")).toBe("issues:list");
    expect(msgWords("x".repeat(30))).toBe("diagnostic");
  });
});

describe("guarantee-3 request id in the error body and forwarded header equals the logged request_id", () => {
  it("2xx, 4xx and 5xx", async () => {
    const out = captureConsole();
    const forwarded: string[] = [];
    let respond: () => Response = () => Response.json(SEARCH_OK);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_i, init) => {
      forwarded.push(new Headers(init?.headers).get(REQUEST_ID_HEADER) ?? "");
      return respond();
    });
    const bodies: Array<Record<string, unknown> | null> = [];
    await withClient({}, async client => {
      for (const r of [
        () => Response.json(SEARCH_OK),
        () => Response.json({ error: "ACCESS_DENIED", message: "no" }, { status: 403 }),
        () => new Response("broke", { status: 500 }),
      ]) {
        respond = r;
        const res = await client.callTool({ name: "search_components", arguments: { query: "q" } });
        bodies.push(res.isError ? JSON.parse((res.content as Array<{ text: string }>)[0].text) : null);
      }
    });
    const lines = jsonLines(out).filter(l => l.msg === "request");
    expect(lines).toHaveLength(3);
    expect(lines.map(l => l.request_id)).toEqual(forwarded.filter(Boolean).slice(0, 3));
    expect(bodies[0]).toBeNull();
    expect(bodies[1]!.request_id).toBe(lines[1].request_id);
    expect(bodies[2]!.request_id).toBe(lines[2].request_id);
  });
});

describe("guarantee-4 a broken or slow sink never fails a tool call", () => {
  it("a throwing sink with a never-resolving flush leaves the tool result unchanged", async () => {
    setLogSinkForTest({ write() { throw new Error("sink down"); }, flush: () => new Promise<void>(() => {}) });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(SEARCH_OK));
    await withClient({}, async client => {
      const ok = await client.callTool({ name: "search_components", arguments: { query: "q" } });
      expect(ok.isError).not.toBe(true);
    });
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("broke", { status: 500 }));
    await withClient({}, async client => {
      const res = await client.callTool({ name: "search_components", arguments: { query: "q" } });
      expect(res.isError).toBe(true);
      expect(JSON.parse((res.content as Array<{ text: string }>)[0].text)).toMatchObject({ error: "SEARCH_API_500", retryable: true });
    });
  });

  it("the wrapper returns the handler's answer even when hashing and the logger both fail", async () => {
    const answer = { content: [{ type: "text", text: "fine" }] };
    const h = wrapToolHandler("t", async () => answer, {
      logger: { info() { throw new Error("x"); }, warn() { throw new Error("x"); }, error() { throw new Error("x"); }, debug() {}, request() { throw new Error("x"); }, flush: async () => {} },
      identify: () => { throw new Error("identify down"); },
    });
    expect(await h({}, {})).toEqual(answer);
  });
});

describe("x-scry-client over the real agents transports (not injected by hand)", () => {
  const rpc = (id: number | undefined, method: string, params: unknown) => JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params });

  it("SSE: the header on the POST /sse/message Request reaches the request line", async () => {
    const sink = collectingSink();
    setLogSinkForTest(sink);
    captureConsole();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(SEARCH_OK));
    const stub = env.MCP_OBJECT.get(env.MCP_OBJECT.newUniqueId()) as unknown as DurableObjectStub<ScryMCP>;
    await runInDurableObject(stub, async (instance: ScryMCP) => {
      await instance._init(props);
      const upgraded = await instance.fetch(new Request("https://mcp.test/sse", { headers: { Upgrade: "websocket", "x-partykit-room": "sse-client-test" } }));
      const ws = upgraded.webSocket!;
      ws.accept();
      const replies: Array<{ id?: number }> = [];
      ws.addEventListener("message", ev => replies.push(JSON.parse(String(ev.data))));
      const post = (body: string, client?: string) =>
        instance.onSSEMcpMessage("sse-client-test", new Request("https://mcp.test/sse/message?sessionId=sse-client-test", {
          method: "POST",
          headers: { "content-type": "application/json", ...(client ? { "x-scry-client": client } : {}) },
          body,
        }));
      expect(await post(rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } }), "scry-link/0.9.0")).toBeNull();
      await post(rpc(undefined, "notifications/initialized", {}), "scry-link/0.9.0");
      await post(rpc(2, "tools/call", { name: "search_components", arguments: { query: "button" } }), "scry-link/0.9.0");
      for (let i = 0; i < 100 && !replies.some(r => r.id === 2); i++) await new Promise(r => setTimeout(r, 20));
      expect(replies.some(r => r.id === 2)).toBe(true);
      ws.close();
    });
    await settle();
    const lines = sink.lines.filter(l => l.msg === "request" && l.route === "search_components");
    expect(lines).toHaveLength(1);
    expect(lines[0].client).toBe("scry-link/0.9.0");
  });

  it("streamable HTTP: the Worker handler passes the header to the session's object before delegating", async () => {
    const sink = collectingSink();
    setLogSinkForTest(sink);
    captureConsole();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(SEARCH_OK));
    const sessionId = "ab".repeat(32);
    let delegated = 0;
    const handler = withClientNote({ fetch: async (_r: Request, _e: Env, _c: ExecutionContext) => { delegated++; return new Response("ok"); } });
    const res = await handler.fetch(
      new Request("https://mcp.test/mcp", { method: "POST", headers: { "mcp-session-id": sessionId, "x-scry-client": "scry-cli/1.2.3" } }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(await res.text()).toBe("ok");
    expect(delegated).toBe(1);
    // A malformed header or session id is ignored and still delegates.
    await handler.fetch(new Request("https://mcp.test/mcp", { headers: { "mcp-session-id": "nope", "x-scry-client": "<b>" } }), env, {} as ExecutionContext);
    expect(delegated).toBe(2);

    const stub = env.MCP_OBJECT.get(env.MCP_OBJECT.idFromName(`streamable-http:${sessionId}`)) as unknown as DurableObjectStub<ScryMCP>;
    await runInDurableObject(stub, async (instance: ScryMCP, state) => {
      instance.props = props;
      await instance.init();
      const client = new Client({ name: "log-test", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await instance.server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.callTool({ name: "search_components", arguments: { query: "button" } });
      await client.close();
      void state;
    });
    await settle();
    const line = sink.lines.find(l => l.msg === "request" && l.route === "search_components");
    expect(line?.client).toBe("scry-cli/1.2.3");
  });
});

describe("uid_hash salt (M2)", () => {
  it("is omitted in staging and production without SCRY_LOG_SALT, never a public salt", async () => {
    expect(await hashUid(UID, undefined, "staging")).toBeUndefined();
    expect(await hashUid(UID, "", "production")).toBeUndefined();
    expect(await hashUid(UID, undefined, "development")).toMatch(/^[0-9a-f]{12}$/);
    expect(await hashUid(UID, undefined)).toMatch(/^[0-9a-f]{12}$/); // no env = development
    expect(await hashUid(UID, "s3cret", "production")).toMatch(/^[0-9a-f]{12}$/);
    const publicSalt = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${UID}scry-log-v1`))).slice(0, 6), b => b.toString(16).padStart(2, "0")).join("");
    expect(await hashUid(UID, undefined, "staging")).not.toBe(publicSalt);
  });

  it("a staging tool call without a salt writes a request line with no uid_hash", async () => {
    const sink = collectingSink();
    setLogSinkForTest(sink);
    const h = wrapToolHandler("whoami", async () => ({ content: [] }), {
      logger: getLogger({ SCRY_ENV: "staging" }),
      identify: () => ({ uid: UID, salt: undefined, env: "staging" }),
    });
    await h({});
    await settle();
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0].uid_hash).toBeUndefined();
  });
});

describe("status mapping and the request path (M4, M6)", () => {
  it("INSUFFICIENT_CREDITS is 402, RATE_LIMITED 429, ACCESS_DENIED 403, unknown 400", async () => {
    const sink = collectingSink();
    setLogSinkForTest(sink);
    for (const code of ["INSUFFICIENT_CREDITS", "RATE_LIMITED", "ACCESS_DENIED", "SAFETY_FILTERED"]) {
      const h = wrapToolHandler("t", async () => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: code }) }] }), { logger: getLogger({ SCRY_ENV: "staging" }) });
      await h({});
    }
    await settle();
    expect(sink.lines.map(l => l.status)).toEqual([402, 429, 403, 400]);
    expect(sink.lines.map(l => l.err_code)).toEqual(["insufficient_credits", "rate_limited", "access_denied", "safety_filtered"]);
  });

  it("the tool answer returns before the uid is hashed and logged (off the request path)", async () => {
    const sink = collectingSink();
    setLogSinkForTest(sink);
    const h = wrapToolHandler("t", async () => ({ content: [] }), {
      logger: getLogger({ SCRY_ENV: "staging" }),
      identify: () => ({ uid: UID, salt: "s" }),
    });
    await h({});
    expect(sink.lines).toHaveLength(0);
    await settle();
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0].uid_hash).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("firebase-verify never logs unverified token claims (M3)", () => {
  it("aud, iss and kid from an unsigned token never reach the console", async () => {
    const out = captureConsole();
    const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const now = Math.floor(Date.now() / 1000);
    const base = { exp: now + 600, iat: now, auth_time: now, sub: "u1" };
    const tok = (payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "KIDCANARY_5510" }) =>
      `${b64(header)}.${b64({ ...base, ...payload })}.c2ln`;
    const { verifyFirebaseIdToken } = await import("../src/utils/firebase-verify");
    expect(await verifyFirebaseIdToken(tok({ aud: "AUDCANARY_5510", iss: "x" }), "proj")).toBeNull();
    expect(await verifyFirebaseIdToken(tok({ aud: "proj", iss: "ISSCANARY_5510" }), "proj")).toBeNull();
    expect(await verifyFirebaseIdToken("not.a.jwt-CANARY_5510", "proj")).toBeNull();
    const text = out.join("\n");
    for (const m of ["AUDCANARY_5510", "ISSCANARY_5510", "KIDCANARY_5510", "CANARY_5510"]) expect(text).not.toContain(m);
    expect(text).toContain("aud mismatch");
    expect(text).toContain("iss mismatch");
  });
});
