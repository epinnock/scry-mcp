/**
 * log-standardization F32/G3: every response of the real fetch entry carries `x-scry-request-id`, the id is
 * minted at the edge (inbound ignored), the edge writes one schema-v1 line with the same id, and a tool call
 * triggered by the request logs under that same id. Nothing here may change a status, a body or a header.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { ScryMCP as ScryMCPAgent, type AuthProps } from "../src/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { REQUEST_ID_HEADER } from "../src/lib/request-id";
import { carryInMessage, edgeRoute, withEdgeRequestId } from "../src/lib/edge-request";
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

describe("the tool call's line carries ITS OWN edge id (real Durable Object, id carried in the message)", () => {
  const props: AuthProps = { firebaseUid: "u-edge", email: "e@example.test", displayName: "E", emailVerified: true };
  const JSON_H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const rpc = (id: number | undefined, method: string, params: unknown) => ({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params });
  const settle = () => new Promise(r => setTimeout(r, 40));
  const tail = (sink: { lines: LogLine[] }) => sink.lines.filter(l => l.msg === "request" && (l.route === "whoami" || l.route === "search_components"));

  /** Counts every call the Worker makes on a Durable Object stub (RPC or fetch). */
  function countingEnv() {
    const calls: string[] = [];
    const ns = env.MCP_OBJECT;
    const wrapped = new Proxy(ns, {
      get(t, prop) {
        if (prop !== "get") return Reflect.get(t, prop, t).bind?.(t) ?? Reflect.get(t, prop, t);
        return (id: DurableObjectId) => {
          const stub = t.get(id) as unknown as Record<string, unknown>;
          return new Proxy(stub, {
            get(st, m) {
              const v = Reflect.get(st, m, st);
              if (typeof m === "symbol" || m === "then" || typeof v !== "function") return v;
              return (...a: unknown[]) => { calls.push(m); return (st as Record<string, (...x: unknown[]) => unknown>)[m](...a); };
            },
          });
        };
      },
    });
    return { calls, e: { ...e, MCP_OBJECT: wrapped } as unknown as Env };
  }

  /** First SSE message of a response, then the stream is dropped (the agents transport keeps it open ~10 s after the reply). */
  async function reply(res: Response): Promise<string> {
    if (!res.body) return "";
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = "";
    for (let i = 0; i < 2000; i++) {
      const { value, done } = await reader.read();
      if (value) text += dec.decode(value);
      if (done || /data: .*\n\n/s.test(text)) break;
    }
    void reader.cancel().catch(() => {});
    return text;
  }

  function streamable(withEdge: boolean, e2: Env) {
    const inner = ScryMCPAgent.serve("/mcp") as unknown as ExportedHandler<Env>;
    const h = withEdge ? withEdgeRequestId(inner) : inner;
    const c = { waitUntil() {}, passThroughOnException() {}, props } as unknown as ExecutionContext;
    return (body: unknown, headers: Record<string, string> = {}) =>
      h.fetch!(new Request("https://mcp.test/mcp", { method: "POST", headers: { ...JSON_H, ...headers }, body: JSON.stringify(body) }) as never, e2, c);
  }

  async function openSession(post: ReturnType<typeof streamable>) {
    const init = await post(rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } }), { "x-scry-client": "scry-link/1.0.0" });
    const sid = init.headers.get("mcp-session-id")!;
    await reply(init);
    await post(rpc(undefined, "notifications/initialized", {}), { "mcp-session-id": sid });
    return sid;
  }

  it("streamable HTTP: two concurrent tools/call on one session each log their own edge id (50 rounds)", async () => {
    const sink = collectingSink();
    setLogSinkForTest(sink);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ results: [], pagination: { page: 1, limit: 5, total: 0 } }));
    const post = streamable(true, e);
    const sid = await openSession(post);
    for (let round = 0; round < 50; round++) {
      sink.lines.length = 0;
      const hs = { "mcp-session-id": sid, "x-scry-client": "scry-link/1.0.0" };
      const swap = round % 2 === 1;
      const a = () => post(rpc(100 + round * 2, "tools/call", { name: "whoami", arguments: {} }), hs);
      const b = () => post(rpc(101 + round * 2, "tools/call", { name: "whoami", arguments: {} }), { ...hs, "x-scry-request-id": "01ARZ3NDEKTSV4RRFFQ69G5FZZ" });
      const [ra, rb] = await Promise.all(swap ? [b(), a()].reverse() : [a(), b()]);
      const [ta, tb] = await Promise.all([reply(ra), reply(rb)]);
      expect(ta).toContain(`"id":${100 + round * 2}`);
      expect(tb).toContain(`"id":${101 + round * 2}`);
      await settle();
      const idA = ra.headers.get(REQUEST_ID_HEADER)!;
      const idB = rb.headers.get(REQUEST_ID_HEADER)!;
      expect(idA).not.toBe(idB);
      const tools = tail(sink);
      // Both calls are the same tool, so compare as sets: a swapped or reused id makes the set differ.
      expect(tools.map(l => l.request_id).sort()).toEqual([idA, idB].sort());
      expect(tools.map(l => l.client)).toEqual(["scry-link/1.0.0", "scry-link/1.0.0"]);
      expect(tools.some(l => l.request_id === "01ARZ3NDEKTSV4RRFFQ69G5FZZ")).toBe(false);
    }
  }, 590000);

  it("streamable HTTP: a tools/list never leaks its id into the next tools/call, and a call with no carried id mints a new one", async () => {
    const sink = collectingSink();
    setLogSinkForTest(sink);
    const post = streamable(true, e);
    const sid = await openSession(post);
    const hs = { "mcp-session-id": sid };
    const list = await post(rpc(50, "tools/list", {}), hs);
    const idList = list.headers.get(REQUEST_ID_HEADER)!;
    expect(await reply(list)).toContain("whoami");
    sink.lines.length = 0;
    const call = await post(rpc(51, "tools/call", { name: "whoami", arguments: {} }), hs);
    const idCall = call.headers.get(REQUEST_ID_HEADER)!;
    expect(await reply(call)).toContain('"id":51');
    await settle();
    const tools = tail(sink);
    expect(idCall).not.toBe(idList);
    expect(tools.map(l => l.request_id)).toEqual([idCall]);
    // Bypass the edge (nothing carried in the message): the tool mints its own id, never a stale one.
    sink.lines.length = 0;
    const bare = await streamable(false, e)(rpc(52, "tools/call", { name: "whoami", arguments: {} }), hs);
    expect(await reply(bare)).toContain('"id":52');
    await settle();
    const bareIds = tail(sink).map(l => l.request_id);
    expect(bareIds).toHaveLength(1);
    expect(bareIds[0]).toMatch(ULID);
    expect([idList, idCall]).not.toContain(bareIds[0]);
  }, 300000);

  it("SSE /sse/message: overlapping tools/call on one session each log their own id, and a tools/list never leaks (50 rounds)", async () => {
    const sink = collectingSink();
    setLogSinkForTest(sink);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => { await new Promise(r => setTimeout(r, 15)); return Response.json({ results: [], pagination: { page: 1, limit: 5, total: 0 } }); });
    const stub = env.MCP_OBJECT.get(env.MCP_OBJECT.newUniqueId()) as unknown as DurableObjectStub<ScryMCPAgent>;
    await runInDurableObject(stub, async (instance: ScryMCPAgent) => {
      await instance._init(props);
      const upgraded = await instance.fetch(new Request("https://mcp.test/sse", { headers: { Upgrade: "websocket", "x-partykit-room": "sse-edge-test" } }));
      const ws = upgraded.webSocket!;
      ws.accept();
      const replies = new Set<number>();
      ws.addEventListener("message", ev => { const m = JSON.parse(String(ev.data)) as { id?: number }; if (m.id !== undefined) replies.add(m.id); });
      // The edge wrapper in front of the same call the SSE transport makes: the DO gets the forwarded Request.
      const edge = withEdgeRequestId({ fetch: async (req: Request) => { const err = await instance.onSSEMcpMessage("sse-edge-test", req); return new Response(err ? "bad" : "Accepted", { status: err ? 400 : 202 }); } } as ExportedHandler<Env>);
      const post = (body: unknown, headers: Record<string, string> = {}) =>
        edge.fetch!(new Request("https://mcp.test/sse/message?sessionId=sse-edge-test", { method: "POST", headers: { "content-type": "application/json", "content-length": String(JSON.stringify(body).length), ...headers }, body: JSON.stringify(body) }) as never, e, ctx());
      const waitFor = async (id: number) => { for (let i = 0; i < 400 && !replies.has(id); i++) { await new Promise(r => setTimeout(r, 10)); } expect(replies.has(id)).toBe(true); };
      await post(rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } }), { "x-scry-client": "scry-link/2.0.0" });
      await waitFor(1);
      await post(rpc(undefined, "notifications/initialized", {}));
      for (let round = 0; round < 50; round++) {
        sink.lines.length = 0;
        const base = 1000 + round * 3;
        const rl = await post(rpc(base, "tools/list", {}));
        const idList = rl.headers.get(REQUEST_ID_HEADER)!;
        const hs = { "x-scry-client": "scry-link/2.0.0" };
        // search_components is slow (mocked upstream 15 ms), whoami instant, started second: adversarial order.
        const first = post(rpc(base + 1, "tools/call", { name: "search_components", arguments: { query: "q" } }), hs);
        const second = post(rpc(base + 2, "tools/call", { name: "whoami", arguments: {} }), { ...hs, "x-scry-request-id": "01ARZ3NDEKTSV4RRFFQ69G5FZZ" });
        const [r1, r2] = await Promise.all(round % 2 ? [second, first].reverse() : [first, second]);
        await Promise.all([waitFor(base), waitFor(base + 1), waitFor(base + 2)]);
        await settle();
        const id1 = r1.headers.get(REQUEST_ID_HEADER)!;
        const id2 = r2.headers.get(REQUEST_ID_HEADER)!;
        const tools = tail(sink);
        expect(tools.find(l => l.route === "search_components")?.request_id).toBe(id1);
        expect(tools.find(l => l.route === "whoami")?.request_id).toBe(id2);
        expect(tools.map(l => l.request_id)).not.toContain(idList);
        expect(tools.map(l => l.request_id)).not.toContain("01ARZ3NDEKTSV4RRFFQ69G5FZZ");
        expect(tools.every(l => l.client === "scry-link/2.0.0")).toBe(true);
      }
      ws.close();
    });
  }, 590000);

  it("overhead: the edge adds no Durable Object call to /mcp requests (counted stub calls, with and without the edge)", async () => {
    const withoutEdge = countingEnv();
    const post0 = streamable(false, withoutEdge.e);
    const sid0 = await openSession(post0);
    withoutEdge.calls.length = 0;
    await reply(await post0(rpc(70, "tools/call", { name: "whoami", arguments: {} }), { "mcp-session-id": sid0, "x-scry-client": "scry-link/1.0.0" }));
    const withEdge = countingEnv();
    const post1 = streamable(true, withEdge.e);
    const sid1 = await openSession(post1);
    withEdge.calls.length = 0;
    await reply(await post1(rpc(70, "tools/call", { name: "whoami", arguments: {} }), { "mcp-session-id": sid1, "x-scry-client": "scry-link/1.0.0" }));
    console.log("stub calls per tools/call request: without edge", withoutEdge.calls, "with edge", withEdge.calls);
    expect(withoutEdge.calls.length).toBeGreaterThan(0);
    expect(withEdge.calls).toEqual(withoutEdge.calls);
    // And the edge wrapper on its own never touches the namespace: any access throws, the request still passes.
    const trap = new Proxy({}, { get() { throw new Error("edge touched MCP_OBJECT"); } });
    const seen: string[] = [];
    const h = withEdgeRequestId({ fetch: async (r: Request) => { seen.push(await r.text()); return new Response("ok"); } } as ExportedHandler<Env>);
    const res = await h.fetch!(new Request("https://mcp.test/mcp", { method: "POST", headers: { "mcp-session-id": "a".repeat(64), "x-scry-client": "scry-link/1.0.0", "content-type": "application/json" }, body: JSON.stringify(rpc(1, "tools/call", { name: "whoami" })) }) as never, { ...e, MCP_OBJECT: trap } as unknown as Env, ctx());
    expect(res.status).toBe(200);
    expect(JSON.parse(seen[0]).params._meta["scry/request_id"]).toMatch(ULID);
  });
});

describe("carryInMessage: what the edge writes into the message", () => {
  const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
  it("overwrites a caller-chosen id on tools/call, strips it elsewhere, handles batches and non-JSON", () => {
    const spoof = { "scry/request_id": "01ARZ3NDEKTSV4RRFFQ69G5FZZ", "scry/client": "evil/9", keep: 1 };
    const out = JSON.parse(carryInMessage(JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "a", _meta: spoof } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: spoof } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "b" } },
    ]), ID, undefined)!);
    expect(out[0].params._meta).toEqual({ "scry/request_id": ID, keep: 1 });
    expect(out[1].params._meta).toEqual({ keep: 1 });
    expect(out[2].params._meta).toEqual({ "scry/request_id": ID });
    expect(JSON.parse(carryInMessage(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "a" } }), ID, "scry-link/1.0.0")!).params._meta).toEqual({ "scry/request_id": ID, "scry/client": "scry-link/1.0.0" });
    expect(carryInMessage(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" }), ID, undefined)).toBeUndefined();
    expect(() => carryInMessage("not json tools/call", ID, undefined)).toThrow();
  });
});
