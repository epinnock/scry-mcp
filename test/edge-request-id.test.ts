/**
 * log-standardization F32/G3: every response of the real fetch entry carries `x-scry-request-id`, the id is
 * minted at the edge (inbound ignored) and the edge writes one schema-v1 line with the same id. The edge never
 * reads or modifies a request body; a tool call inside an MCP request keeps its OWN tool id. Nothing here may
 * change a status, a body or a header.
 */
import { env } from "cloudflare:test";
import { ScryMCP as ScryMCPAgent, type AuthProps } from "../src/mcp";
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

  it("Set-Cookie multiplicity survives, on a mutable and on an immutable response", async () => {
    const mk = () => new Response("body", { status: 201, statusText: "Made", headers: [["set-cookie", "a=1; Path=/"], ["set-cookie", "b=2; Path=/"], ["x-keep", "1"]] });
    const mutable = await handlerOf(() => mk()).fetch(new Request("https://mcp.test/callback"), e, ctx());
    expect(mutable.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(mutable.status).toBe(201);
    const frozen = mk();
    const fh = new Headers(frozen.headers);
    fh.set = () => { throw new TypeError("immutable"); };
    Object.defineProperty(frozen, "headers", { value: fh });
    const immutable = await handlerOf(() => frozen).fetch(new Request("https://mcp.test/callback"), e, ctx());
    expect(immutable.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(immutable.headers.get("x-keep")).toBe("1");
    expect(immutable.status).toBe(201);
    expect(immutable.statusText).toBe("Made");
    expect(immutable.headers.get(REQUEST_ID_HEADER)).toMatch(ULID);
    expect(await immutable.text()).toBe("body");
  });

  it("edgeRoute maps only the fixed table, never a raw path", () => {
    expect(edgeRoute("/mcp/")).toBe("/mcp");
    expect(edgeRoute("/sse/message")).toBe("/sse/message");
    expect(edgeRoute("/whatever/abc123")).toBe("unmatched");
  });
});


describe("the edge never reads or modifies a request body", () => {
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
  /** The edge in front of a handler that records the exact bytes and headers it receives. */
  async function through(body: Uint8Array | ReadableStream<Uint8Array>, headers: Record<string, string>) {
    let got: Uint8Array | undefined;
    let gotHeaders: Headers | undefined;
    const h = withEdgeRequestId({ fetch: async (r: Request) => { gotHeaders = r.headers; got = new Uint8Array(await r.arrayBuffer()); return new Response("ok"); } } as ExportedHandler<Env>);
    const init: RequestInit & { duplex?: string } = { method: "POST", headers, body: body as BodyInit, duplex: "half" };
    const res = await h.fetch!(new Request("https://mcp.test/mcp", init) as never, e, ctx());
    return { res, got: got!, gotHeaders: gotHeaders! };
  }
  const enc = new TextEncoder();
  const toolCall = '{"jsonrpc":"2.0","id":1,"method":"tools\\/call","params":{"name":"whoami","_meta":{"scry\\/request_id":"01ARZ3NDEKTSV4RRFFQ69G5FZZ"}}}';

  it.each([
    ["a tools/call with escaped keys and a caller _meta", enc.encode(toolCall), "application/json"],
    ["malformed JSON", enc.encode('{"jsonrpc": tools/call _meta'), "application/json"],
    ["invalid UTF-8", new Uint8Array([0x7b, 0xff, 0xfe, 0x22, 0x7d]), "application/json"],
    ["an ISO-8859-1 body", new Uint8Array([0x7b, 0xe9, 0x7d]), "application/json; charset=iso-8859-1"],
    ["an empty body", new Uint8Array(), "application/json"],
  ])("%s reaches the handler byte-identical", async (_n, bytes, type) => {
    const { got, gotHeaders, res } = await through(bytes, { "content-type": type, "content-length": String(bytes.length) });
    expect(res.status).toBe(200);
    expect(same(got, bytes)).toBe(true);
    expect(gotHeaders.get("content-length")).toBe(String(bytes.length));
    expect(gotHeaders.get(REQUEST_ID_HEADER)).toBe(res.headers.get(REQUEST_ID_HEADER));
  });

  it("a gzip body keeps its bytes and its content-encoding header", async () => {
    const gz = new Uint8Array(await new Response(new Blob([toolCall]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    const { got, gotHeaders } = await through(gz, { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(gz.length) });
    expect(same(got, gz)).toBe(true);
    expect(gotHeaders.get("content-encoding")).toBe("gzip");
  });

  it("a chunked body over 4 MB is not read by the edge (the handler never asked, so nothing was pulled)", async () => {
    let pulls = 0;
    const chunk = new Uint8Array(256 * 1024).fill(0x61);
    const stream = new ReadableStream<Uint8Array>({ pull(c) { pulls++; if (pulls > 80) c.close(); else c.enqueue(chunk); } });
    let handlerSawBody = false;
    const h = withEdgeRequestId({ fetch: async (r: Request) => { handlerSawBody = r.body !== null; return new Response("unauth", { status: 401 }); } } as ExportedHandler<Env>);
    const init: RequestInit & { duplex?: string } = { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" };
    const res = await h.fetch!(new Request("https://mcp.test/mcp", init) as never, e, ctx());
    expect(res.status).toBe(401);
    expect(handlerSawBody).toBe(true);
    // 80 chunks = 20 MB; the edge buffering would have pulled all of them. Allow the stream's own read-ahead only.
    expect(pulls).toBeLessThan(10);
  });

  it("the real Durable Object path answers a malformed body identically with and without the edge", async () => {
    const props: AuthProps = { firebaseUid: "u-edge", email: "e@example.test", displayName: "E", emailVerified: true };
    const inner = ScryMCPAgent.serve("/mcp") as unknown as ExportedHandler<Env>;
    const c = { waitUntil() {}, passThroughOnException() {}, props } as unknown as ExecutionContext;
    const send = (h: ExportedHandler<Env>, bytes: Uint8Array) =>
      h.fetch!(new Request("https://mcp.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: bytes }) as never, e, c);
    for (const bytes of [enc.encode("{not json"), new Uint8Array([0x7b, 0xff, 0xfe, 0x22, 0x7d]), enc.encode(toolCall)]) {
      const a = await send(inner, bytes);
      const b = await send(withEdgeRequestId(inner), bytes);
      expect(b.status).toBe(a.status);
      expect(await b.text()).toBe(await a.text());
    }
  });
});

describe("tool calls keep their OWN tool id (real Durable Object); the edge id is a different, unjoined id", () => {
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
    const init = await post(rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } }));
    const sid = init.headers.get("mcp-session-id")!;
    await reply(init);
    await post(rpc(undefined, "notifications/initialized", {}), { "mcp-session-id": sid });
    return sid;
  }

  it("two concurrent tool calls on one session each log their own tool id and return it in the result (50 rounds)", async () => {
    const sink = collectingSink();
    setLogSinkForTest(sink);
    // One call fails inside the tool (search_components: the test env has no caller-assertion secret, so its error
    // body carries the tool id), the other succeeds (whoami): the pairing of result and line is checked by route.
    const post = streamable(true, e);
    const sid = await openSession(post);
    const hs = { "mcp-session-id": sid, "x-scry-client": "scry-link/1.0.0" };
    for (let round = 0; round < 50; round++) {
      sink.lines.length = 0;
      const rpcId = 100 + round * 2;
      const boom = () => post(rpc(rpcId, "tools/call", { name: "search_components", arguments: { query: "boom" } }), hs);
      const ok = () => post(rpc(rpcId + 1, "tools/call", { name: "whoami", arguments: {} }), { ...hs, "x-scry-request-id": "01ARZ3NDEKTSV4RRFFQ69G5FZZ" });
      const [rb, ro] = round % 2 ? (await Promise.all([ok(), boom()])).reverse() : await Promise.all([boom(), ok()]);
      const [tb, to] = await Promise.all([reply(rb), reply(ro)]);
      expect(tb).toContain(`"id":${rpcId}`);
      expect(to).toContain(`"id":${rpcId + 1}`);
      await settle();
      const edgeIds = [rb.headers.get(REQUEST_ID_HEADER)!, ro.headers.get(REQUEST_ID_HEADER)!];
      const lines = tail(sink);
      expect(lines).toHaveLength(2);
      const failed = lines.find(l => l.route === "search_components")!;
      const passed = lines.find(l => l.route === "whoami")!;
      expect(failed.status).toBe(400);
      expect(passed.status).toBe(200);
      expect(failed.request_id).not.toBe(passed.request_id);
      // The failing call's tool result carries exactly the id its own tool line logged.
      const bodyId = /request_id\\?":\\?"([0-9A-HJKMNP-TV-Z]{26})/.exec(tb)?.[1];
      expect(bodyId).toBe(failed.request_id);
      // Tool ids are minted per call, are not the edge ids, and the tool line has no client.
      for (const l of lines) { expect(edgeIds).not.toContain(l.request_id); expect(l.request_id).toMatch(ULID); expect(l.client).toBeUndefined(); }
      expect(lines.some(l => l.request_id === "01ARZ3NDEKTSV4RRFFQ69G5FZZ")).toBe(false);
    }
  }, 590000);

  it("DO subrequests per call equal the pre-PR baseline (the handler without the edge)", async () => {
    const baseline = countingEnv();
    const post0 = streamable(false, baseline.e);
    const sid0 = await openSession(post0);
    baseline.calls.length = 0;
    await reply(await post0(rpc(70, "tools/call", { name: "whoami", arguments: {} }), { "mcp-session-id": sid0, "x-scry-client": "scry-link/1.0.0" }));
    const withEdge = countingEnv();
    const post1 = streamable(true, withEdge.e);
    const sid1 = await openSession(post1);
    withEdge.calls.length = 0;
    await reply(await post1(rpc(70, "tools/call", { name: "whoami", arguments: {} }), { "mcp-session-id": sid1, "x-scry-client": "scry-link/1.0.0" }));
    console.log("stub calls per tools/call request: baseline", baseline.calls, "with edge", withEdge.calls);
    expect(baseline.calls.length).toBeGreaterThan(0);
    expect(withEdge.calls).toEqual(baseline.calls);
    // The edge on its own never touches the namespace: any access throws, the request still passes.
    const trap = new Proxy({}, { get() { throw new Error("edge touched MCP_OBJECT"); } });
    const h = withEdgeRequestId({ fetch: async () => new Response("ok") } as ExportedHandler<Env>);
    const res = await h.fetch!(new Request("https://mcp.test/mcp", { method: "POST", headers: { "mcp-session-id": "a".repeat(64), "content-type": "application/json" }, body: "{}" }) as never, { ...e, MCP_OBJECT: trap } as unknown as Env, ctx());
    expect(res.status).toBe(200);
  });
});
