/**
 * log-standardization F32/G3: every response of the real fetch entry carries `x-scry-request-id`, the id is
 * minted at the edge (inbound ignored), the edge writes one schema-v1 line with the same id, and a tool call
 * triggered by the request logs under that same id. Nothing here may change a status, a body or a header.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ScryMCP, type AuthProps } from "../src/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { REQUEST_ID_HEADER } from "../src/lib/request-id";
import { edgeRoute, withEdgeRequestId } from "../src/lib/edge-request";
import { setLogSinkForTest } from "../src/lib/log";
import { validateLine, type LogLine, type Sink } from "../src/lib/scry-log";
import canary from "./fixtures/scry-log-canary.json";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function collectingSink(): Sink & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  return { lines, write: l => { lines.push(l); }, flush: async () => {} };
}

function ctx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
}

const e = { ...env, SCRY_ENV: "staging" } as Env;
const call = (path: string, init?: RequestInit) => worker.fetch!(new Request(`https://mcp.test${path}`, init) as never, e, ctx());

afterEach(() => {
  setLogSinkForTest(null);
  vi.restoreAllMocks();
});

async function probe(path: string, init?: RequestInit) {
  const sink = collectingSink();
  setLogSinkForTest(sink);
  const res = await call(path, init);
  const id = res.headers.get(REQUEST_ID_HEADER);
  const lines = sink.lines.filter(l => l.msg === "request");
  return { res, id, lines, sink };
}

describe("edge request id on every response of the fetch entry", () => {
  it.each([
    ["healthz 200", "/healthz", undefined, 200, "/healthz"],
    ["health 200", "/health", undefined, 200, "/health"],
    ["unknown path 404", "/nope/where", undefined, 404, "unmatched"],
    ["/mcp without a token 401", "/mcp", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }, 401, "/mcp"],
    ["/sse without a token 401", "/sse", undefined, 401, "/sse"],
    ["well-known route", "/.well-known/oauth-authorization-server", undefined, 200, "/well-known/*"],
  ] as const)("%s carries the id and logs the same id", async (_n, path, init, status, route) => {
    const { res, id, lines } = await probe(path, init as RequestInit | undefined);
    expect(res.status).toBe(status);
    expect(id).toMatch(ULID);
    expect(lines).toHaveLength(1);
    expect(lines[0].request_id).toBe(id);
    expect(lines[0].route).toBe(route);
    expect(lines[0].status).toBe(status);
    expect(lines[0].service).toBe("mcp");
    expect(lines[0].ms).toBeGreaterThanOrEqual(0);
    expect(validateLine(lines[0] as unknown as Record<string, unknown>).errors).toEqual([]);
  });

  it("OPTIONS preflight and a redirect-shaped OAuth route carry the id", async () => {
    const opt = await probe("/mcp", { method: "OPTIONS", headers: { origin: "https://claude.ai", "access-control-request-method": "POST" } });
    expect(opt.id).toMatch(ULID);
    expect(opt.lines[0]?.request_id).toBe(opt.id);
    const auth = await probe("/authorize?client_id=x&redirect_uri=https%3A%2F%2Fa.test%2Fcb&response_type=code");
    expect(auth.id).toMatch(ULID);
    expect(auth.lines[0]?.request_id).toBe(auth.id);
    expect(auth.lines[0]?.route).toBe("/authorize");
  });

  it("mints a fresh id for every request and ignores an inbound one (never echoed)", async () => {
    const inbound = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const a = await probe("/healthz", { headers: { [REQUEST_ID_HEADER]: inbound } });
    const b = await probe("/healthz", { headers: { [REQUEST_ID_HEADER]: canary.values.email } });
    expect(a.id).not.toBe(inbound);
    expect(a.id).not.toBe(b.id);
    expect(JSON.stringify(b.lines)).not.toContain(canary.values.email);
    expect(b.res.headers.get(REQUEST_ID_HEADER)).not.toContain("@");
  });

  it("does not change the /healthz body or headers besides adding the id", async () => {
    const res = await call("/healthz");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ ok: true, service: "scry-mcp" });
  });

  it("logs the client from x-scry-client only when well formed", async () => {
    const ok = await probe("/healthz", { headers: { "x-scry-client": "scry-link/0.9.0" } });
    expect(ok.lines[0].client).toBe("scry-link/0.9.0");
    const bad = await probe("/healthz", { headers: { "x-scry-client": canary.values.email } });
    expect(bad.lines[0].client).toBeUndefined();
  });

  it("canary values in path, query, headers and body never reach a line or a response", async () => {
    const sink = collectingSink();
    setLogSinkForTest(sink);
    const q = `/nope/${canary.values.sk_key}?q=${encodeURIComponent(canary.values.query_url)}&e=${encodeURIComponent(canary.values.email)}`;
    const res = await call(q, { method: "POST", body: canary.values.email, headers: { authorization: `Bearer ${canary.values.sk_key}`, cookie: canary.values.email } });
    const all = JSON.stringify(sink.lines) + (await res.text()) + JSON.stringify([...res.headers]);
    for (const m of canary.markers) expect(all).not.toContain(m);
    expect(sink.lines[0].route).toBe("unmatched");
  });
});

describe("streaming and failure behaviour", () => {
  const handlerOf = (fetch: (r: Request) => Response | Promise<Response>) => withEdgeRequestId({ fetch } as never) as unknown as {
    fetch(r: Request, env: unknown, c: ExecutionContext): Promise<Response>;
  };

  it("an SSE response keeps its body stream and status; only the header is added", async () => {
    const sink = collectingSink();
    setLogSinkForTest(sink);
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(c) { c.enqueue(enc.encode("event: endpoint\ndata: /sse/message\n\n")); },
    });
    const h = handlerOf(() => new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } }));
    const res = await h.fetch(new Request("https://mcp.test/sse"), e, ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(ULID);
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("event: endpoint\ndata: /sse/message\n\n");
    expect(sink.lines[0].request_id).toBe(res.headers.get(REQUEST_ID_HEADER));
    expect(sink.lines[0].route).toBe("/sse");
  });

  it("an immutable response (Response.redirect) still gets the id, status and location preserved", async () => {
    const h = handlerOf(() => Response.redirect("https://a.test/x", 302));
    const res = await h.fetch(new Request("https://mcp.test/authorize"), e, ctx());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://a.test/x");
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(ULID);
  });

  it("the downstream handler sees the minted id, not the inbound one", async () => {
    let seen = "";
    const h = handlerOf(r => { seen = r.headers.get(REQUEST_ID_HEADER) ?? ""; return new Response("ok"); });
    const res = await h.fetch(new Request("https://mcp.test/mcp", { headers: { [REQUEST_ID_HEADER]: "attacker-chosen" } }), e, ctx());
    expect(seen).toBe(res.headers.get(REQUEST_ID_HEADER));
    expect(seen).toMatch(ULID);
  });

  it("a throwing sink neither fails nor changes the response (G4)", async () => {
    setLogSinkForTest({ write() { throw new Error("sink down"); }, flush: () => Promise.reject(new Error("x")) });
    const res = await call("/healthz");
    expect(res.status).toBe(200);
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(ULID);
  });

  it("a throwing handler still throws (behaviour preserved) and is logged as 500", async () => {
    const sink = collectingSink();
    setLogSinkForTest(sink);
    const h = handlerOf(() => { throw new Error("boom"); });
    await expect(h.fetch(new Request("https://mcp.test/mcp"), e, ctx())).rejects.toThrow("boom");
    expect(sink.lines[0].status).toBe(500);
    expect(sink.lines[0].level).toBe("error");
  });

  it("edgeRoute maps only the fixed table, never a raw path", () => {
    expect(edgeRoute("/mcp/")).toBe("/mcp");
    expect(edgeRoute("/sse/message")).toBe("/sse/message");
    expect(edgeRoute("/whatever/abc123")).toBe("unmatched");
  });
});

describe("the tool call's line carries the edge id", () => {
  class TestScryMCP extends ScryMCP {
    constructor(state: DurableObjectState, bindings: Env) { super(state, bindings); }
  }
  const props: AuthProps = { firebaseUid: "u-edge", email: "e@example.test", displayName: "E", emailVerified: true };

  async function callWith(prepare: (agent: TestScryMCP) => Promise<void>) {
    const sink = collectingSink();
    setLogSinkForTest(sink);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ results: [], pagination: { page: 1, limit: 5, total: 0 } }));
    const stub = env.MCP_OBJECT.get(env.MCP_OBJECT.newUniqueId());
    await runInDurableObject(stub, async (_i, state) => {
      const agent = new TestScryMCP(state, { ...env, SCRY_ENV: "staging", SCRY_SEARCH_API_URL: "https://search.example.test", SCRY_SEARCH_API_KEY: "k", SCRY_CALLER_ASSERTION_SECRET: "s", MCP_USAGE: undefined } as Env);
      agent.props = props;
      await agent.init();
      const client = new Client({ name: "edge-test", version: "1.0.0" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await agent.server.connect(st);
      await client.connect(ct);
      await prepare(agent);
      await client.callTool({ name: "search_components", arguments: { query: "button" } });
      await client.callTool({ name: "search_components", arguments: { query: "button" } });
      await client.close();
      await agent.server.close();
    });
    await new Promise(r => setTimeout(r, 25));
    return sink.lines.filter(l => l.msg === "request");
  }

  it("streamable HTTP: the id noted by the edge is used once, the next call mints its own", async () => {
    const edgeId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const lines = await callWith(a => a.noteClient("scry-link/1.0.0", edgeId));
    expect(lines).toHaveLength(2);
    expect(lines[0].request_id).toBe(edgeId);
    expect(lines[1].request_id).toMatch(ULID);
    expect(lines[1].request_id).not.toBe(edgeId);
  });

  it("SSE: the id on the forwarded request is used; a malformed one is ignored", async () => {
    const edgeId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
    const good = await callWith(async a => { a.noteClient(null, undefined); (a as unknown as { noteRequestId(v: string): void }).noteRequestId(edgeId); });
    expect(good[0].request_id).toBe(edgeId);
    const bad = await callWith(async a => { (a as unknown as { noteRequestId(v: string): void }).noteRequestId("not-a-ulid"); });
    expect(bad[0].request_id).toMatch(ULID);
    expect(bad[0].request_id).not.toBe("not-a-ulid");
  });
});
