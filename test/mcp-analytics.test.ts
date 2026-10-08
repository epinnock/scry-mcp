/**
 * mcp-analytics: one vendor-neutral event per tool call, to the standard logs and (staging) to PostHog.
 * Guarantees are named `guarantee-N` (see features/mcp-analytics/plan.md). The first half is unit tests of
 * the event, scrubber, schema injection and dispatcher; the second half drives the real Durable Object.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ScryMCP, type AuthProps } from "../src/mcp";
import {
  buildInitializeEvent,
  buildToolCallEvent,
  buildToolsListEvent,
  MAX_INTENT,
  presentInputKeys,
  responseBytes,
  scrubIntent,
  statusOfOutcome,
  type McpToolCallEvent,
} from "../src/analytics/event";
import { createAnalytics, noAnalytics, parseSinks, type AnalyticsSink } from "../src/analytics/sinks";
import { createLogSink, clientLabel } from "../src/analytics/sinks/log";
import { createPostHogSink } from "../src/analytics/sinks/posthog";
import { onToolsListed } from "../src/analytics/hooks";
import { prepareSchema, stripInjected } from "../src/analytics/inject";
import { instrumentToolRegistration, wrapToolHandler } from "../src/lib/tool-request";
import { validateLine, type LogLine, type Sink } from "../src/lib/scry-log";
import { getLogger, setLogSinkForTest } from "../src/lib/log";
import recorded from "./fixtures/search-dedup-response.json";
import wranglerRaw from "../wrangler.jsonc?raw";
import eslintRaw from "../eslint.config.mjs?raw";

declare module "cloudflare:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Workers pool environment augmentation.
  interface ProvidedEnv extends Env {}
}

const UID = "canary-firebase-uid-91b2";
const EMAIL = "canary.user@example.test";
const props: AuthProps = { firebaseUid: UID, email: EMAIL, displayName: "Canary Person", emailVerified: true };

const ARG_CANARY = "canary-arg-value-product-7f3a";
const RESP_CANARY = "CanaryRespTitle9d2e";
const KEY_CANARY = "sk-canaryKEY1234567890abcdef";
const TOKEN = "phc_test_token_not_real";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

afterEach(() => {
  setLogSinkForTest(null);
  vi.restoreAllMocks();
});

// --- unit: event, scrubber -------------------------------------------------------------------------

describe("scrubIntent", () => {
  it("removes emails, urls, bearer tokens, key-shaped strings and long ids", () => {
    const out = scrubIntent(
      `find the login form for ${EMAIL} see https://acme.test/x?token=abc123 and www.acme.test, ${KEY_CANARY} ` +
        `Bearer abc.def.ghi 0123456789abcdef0123 eyJhbGciOiJIUzI1NiJ9.payload.sig`,
    )!;
    for (const secret of [EMAIL, "acme.test", KEY_CANARY, "abc.def.ghi", "0123456789abcdef0123", "eyJhbGci"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("find the login form for");
  });

  it("keeps ordinary prose, collapses whitespace and control characters, and caps at 300 chars", () => {
    expect(scrubIntent("  Looking   for\n a \t checkout   button  ")).toBe("Looking for a checkout button");
    const long = scrubIntent("word ".repeat(200))!;
    expect(long.length).toBeLessThanOrEqual(MAX_INTENT);
  });

  it("returns undefined for non-strings and empty text", () => {
    for (const v of [undefined, null, 5, {}, "", "   \n "]) expect(scrubIntent(v)).toBeUndefined();
  });
});

describe("event building", () => {
  const base = { requestId: "01M3EQG44Y0J8F2K6ZP9RX1T7C", tool: "search_components", outcome: "ok" as const, ms: 12.6, inputKeys: ["query"], responseBytes: 321 };

  it("builds only allow-listed fields and ignores everything else it is handed", () => {
    const evil = { ...base, uid: UID, email: EMAIL, token: KEY_CANARY, args: { q: ARG_CANARY }, response: RESP_CANARY } as unknown as Parameters<typeof buildToolCallEvent>[0];
    const e = buildToolCallEvent(evil);
    const allowed = new Set([
      "schema", "request_id", "tool", "outcome", "ms", "err_code", "project_id", "uid_hash", "session_id", "conversation_id",
      "client_name", "client_version", "protocol_version", "llm_model", "llm_model_source", "intent", "intent_source",
      "input_keys", "response_bytes", "missing_capability", "server_build", "env",
    ]);
    for (const k of Object.keys(e)) expect(allowed.has(k)).toBe(true);
    expect(JSON.stringify(e)).not.toMatch(new RegExp(`${UID}|${EMAIL}|${KEY_CANARY}|${ARG_CANARY}|${RESP_CANARY}`));
    expect(e).toMatchObject({ schema: "mcp_tool_call.v1", tool: "search_components", outcome: "ok", ms: 13, missing_capability: false, response_bytes: 321 });
  });

  it("scrubs the intent, tags its source, and drops unsafe ids and oversize labels", () => {
    const e = buildToolCallEvent({ ...base, context: `why ${EMAIL}`, conversationId: "conv-1", projectId: "bad id <x>", client_name: "x".repeat(300) });
    expect(e.intent).toBe("why [redacted]");
    expect(e.intent_source).toBe("context_parameter");
    expect(e.conversation_id).toBe("conv-1");
    expect(e.project_id).toBeUndefined();
    expect((e.client_name ?? "").length).toBeLessThanOrEqual(64);
  });

  it("carries the error code only on errors", () => {
    expect(buildToolCallEvent({ ...base, outcome: "error", errCode: "ACCESS_DENIED" }).err_code).toBe("ACCESS_DENIED");
    expect(buildToolCallEvent({ ...base, errCode: "ACCESS_DENIED" }).err_code).toBeUndefined();
  });

  it("builds initialize and tools-list events", () => {
    const i = buildInitializeEvent({ client_name: "claude-code", client_version: "2.1.0", protocol_version: "2025-06-18", session_id: "do_1", env: "staging" });
    expect(i).toMatchObject({ schema: "mcp_initialize.v1", client_name: "claude-code", client_version: "2.1.0" });
    const t = buildToolsListEvent({ toolNames: ["a", "b"], env: "staging" });
    expect(t).toMatchObject({ schema: "mcp_tools_list.v1", tool_count: 2, tool_names: ["a", "b"] });
  });

  it("input keys are declared names that were present, never values; sizes are bytes", () => {
    expect(presentInputKeys({ query: ARG_CANARY, zzz: 1, context: "x" }, new Set(["query", "limit"]))).toEqual(["query"]);
    expect(presentInputKeys({ query: 1 }, undefined)).toEqual(["query"]);
    expect(responseBytes({ content: [{ type: "text", text: "héllo" }] })).toBeGreaterThan(5);
    expect(responseBytes(undefined)).toBe(0);
    expect(statusOfOutcome("ok", undefined)).toBe(200);
    expect(statusOfOutcome("error", "ACCESS_DENIED")).toBe(403);
  });
});

describe("config", () => {
  it("ANALYTICS_SINKS: default log, csv, none/off, unknown ignored", () => {
    expect(parseSinks(undefined).names).toEqual(["log"]);
    expect(parseSinks("").names).toEqual(["log"]);
    expect(parseSinks("log, PostHog ,log").names).toEqual(["log", "posthog"]);
    expect(parseSinks("none").names).toEqual([]);
    expect(parseSinks("off").names).toEqual([]);
    expect(parseSinks("log,mixpanel")).toEqual({ names: ["log"], unknown: ["mixpanel"] });
  });
});

// --- unit: schema injection and strip ------------------------------------------------------------------

describe("prepareSchema / stripInjected", () => {
  it("adds optional context + conversation_id to a raw shape, a ZodObject and to no schema", () => {
    const shape = prepareSchema({ query: z.string() });
    expect(Object.keys(shape.schema as object).sort()).toEqual(["context", "conversation_id", "query"]);
    expect([...shape.meta.injected].sort()).toEqual(["context", "conversation_id"]);
    const obj = prepareSchema(z.object({ query: z.string() }));
    expect(Object.keys((obj.schema as z.ZodObject<z.ZodRawShape>).shape).sort()).toEqual(["context", "conversation_id", "query"]);
    const none = prepareSchema(undefined);
    expect(none.meta.adaptNoSchema).toBe(true);
    expect(Object.keys(none.schema as object).sort()).toEqual(["context", "conversation_id"]);
  });

  it("never overrides or strips an argument the tool declares itself", () => {
    const p = prepareSchema({ context: z.string(), q: z.string() });
    expect([...p.meta.injected]).toEqual(["conversation_id"]);
    expect(stripInjected({ context: "c", conversation_id: "x", q: "q" }, p.meta.injected)).toEqual({ context: "c", q: "q" });
  });

  it("leaves a schema kind it does not understand untouched", () => {
    const weird = { notZod: 1 } as unknown;
    expect(prepareSchema(weird).changed).toBe(false);
  });
});

// --- unit: dispatcher ---------------------------------------------------------------------------------

function fakeSink(name: string, impl: Partial<AnalyticsSink> = {}): AnalyticsSink & { calls: McpToolCallEvent[] } {
  const calls: McpToolCallEvent[] = [];
  return {
    name,
    calls,
    toolCall: e => { calls.push(e); },
    initialize: () => {},
    toolsList: () => {},
    ...impl,
  };
}
const sampleEvent = () => buildToolCallEvent({ requestId: "r1", tool: "t", outcome: "ok", ms: 1, inputKeys: [], responseBytes: 0 });

describe("dispatcher", () => {
  it("delivers to every sink, and a failing sink does not stop the others", async () => {
    const errors: string[] = [];
    const bad = fakeSink("bad", { toolCall: () => { throw new Error("boom"); } });
    const rejects = fakeSink("rej", { toolCall: async () => { throw new Error("nope"); } });
    const good = fakeSink("good");
    const pending: Promise<unknown>[] = [];
    const a = createAnalytics({ sinks: [bad, rejects, good], onError: s => errors.push(s), waitUntil: p => pending.push(p) });
    a.emit(sampleEvent());
    await Promise.all(pending);
    expect(good.calls).toHaveLength(1);
    expect(errors.sort()).toEqual(["bad", "rej"]);
  });

  it("abandons a hanging sink after its budget and reports it", async () => {
    const errors: string[] = [];
    const hang = fakeSink("hang", { toolCall: () => new Promise<void>(() => {}) });
    const pending: Promise<unknown>[] = [];
    const a = createAnalytics({ sinks: [hang], budgetMs: 20, onError: s => errors.push(s), waitUntil: p => pending.push(p) });
    a.emit(sampleEvent());
    await Promise.all(pending);
    expect(errors).toEqual(["hang"]);
  });

  it("survives a throwing onError and a throwing waitUntil; no-sinks and noAnalytics are no-ops", async () => {
    const a = createAnalytics({ sinks: [fakeSink("x", { toolCall: () => { throw new Error("e"); } })], onError: () => { throw new Error("again"); }, waitUntil: () => { throw new Error("w"); } });
    expect(() => a.emit(sampleEvent())).not.toThrow();
    await sleep(5);
    expect(() => createAnalytics({ sinks: [] }).emit(sampleEvent())).not.toThrow();
    expect(() => noAnalytics.emit(sampleEvent())).not.toThrow();
  });
});

// --- unit: sinks --------------------------------------------------------------------------------------

function collectingSink(): Sink & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  return { lines, write: l => { lines.push(l); }, flush: async () => {} };
}

describe("log sink", () => {
  it("writes one schema-v1 mcp_tool_call line per call, without intent text, args or keys", () => {
    const sink = collectingSink();
    setLogSinkForTest(sink);
    const log = createLogSink(() => getLogger({ SCRY_ENV: "staging" }));
    log.toolCall(buildToolCallEvent({
      requestId: "01M3EQG44Y0J8F2K6ZP9RX1T7C", tool: "search_components", outcome: "error", ms: 40, errCode: "ACCESS_DENIED",
      uidHash: "abcdef012345", client_name: "claude-code", client_version: "2.1.0", context: "secret intent words", inputKeys: ["query"], responseBytes: 9,
    }));
    expect(sink.lines).toHaveLength(1);
    const line = sink.lines[0] as unknown as Record<string, unknown>;
    expect(validateLine(line).errors).toEqual([]);
    expect(line).toMatchObject({ msg: "mcp_tool_call", route: "search_components", status: 403, request_id: "01M3EQG44Y0J8F2K6ZP9RX1T7C", uid_hash: "abcdef012345", client: "claude-code/2.1.0" });
    expect(JSON.stringify(line)).not.toContain("secret intent words");
  });

  it("initialize and tools-list produce valid schema-v1 info lines", () => {
    const sink = collectingSink();
    setLogSinkForTest(sink);
    const log = createLogSink(() => getLogger({ SCRY_ENV: "staging" }));
    log.initialize(buildInitializeEvent({ client_name: "cursor", client_version: "1.0", env: "staging" }));
    log.toolsList(buildToolsListEvent({ toolNames: ["a"], env: "staging" }));
    expect(sink.lines.map(l => l.msg)).toEqual(["mcp_initialize", "mcp_tools_list"]);
    for (const l of sink.lines) expect(validateLine(l as unknown as Record<string, unknown>).errors).toEqual([]);
    expect(clientLabel("???", "!!")).toBeUndefined();
  });
});

describe("posthog sink", () => {
  it("is absent without a token", () => {
    expect(createPostHogSink({ token: undefined })).toBeNull();
    expect(createPostHogSink({ token: "  " })).toBeNull();
  });

  it("sends $mcp_tool_call (+ $exception on error) with names and sizes only, distinct_id = uid_hash", async () => {
    const bodies: string[] = [];
    const sink = createPostHogSink({
      token: TOKEN,
      fetch: async (_url, init) => {
        bodies.push(String(init?.body));
        return { status: 200, text: async () => "{}", json: async () => ({ status: 1 }) } as never;
      },
    })!;
    await sink.toolCall(buildToolCallEvent({
      requestId: "r1", tool: "search_components", outcome: "error", ms: 7, errCode: "ACCESS_DENIED", uidHash: "abcdef012345",
      context: `find buttons ${EMAIL}`, conversationId: "conv-9", inputKeys: ["query"], responseBytes: 12, env: "staging",
    }));
    const all = bodies.join("\n");
    expect(all).toContain("$mcp_tool_call");
    expect(all).toContain("$exception");
    expect(all).toContain("abcdef012345");
    expect(all).toContain("find buttons [redacted]");
    expect(all).not.toContain(EMAIL);
    expect(all).not.toContain("$mcp_parameters");
    expect(all).not.toContain("$mcp_response");
  });

  it("never throws when the transport fails", async () => {
    const sink = createPostHogSink({ token: TOKEN, fetch: async () => { throw new Error("network down"); } })!;
    await expect(Promise.resolve(sink.toolCall(sampleEvent()))).resolves.toBeUndefined();
  });
});

// --- unit: hooks -------------------------------------------------------------------------------------------

describe("onToolsListed", () => {
  it("reports the tool names after each tools/list without changing the answer", async () => {
    const server = new McpServer({ name: "t", version: "1" });
    server.tool("alpha", "a", {}, async () => ({ content: [{ type: "text", text: "a" }] }));
    server.tool("beta", "b", {}, async () => ({ content: [{ type: "text", text: "b" }] }));
    const seen: string[][] = [];
    expect(onToolsListed(server, names => seen.push(names))).toBe(true);
    const client = new Client({ name: "c", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const list = await client.listTools();
    expect(list.tools.map(t => t.name).sort()).toEqual(["alpha", "beta"]);
    expect(seen).toEqual([["alpha", "beta"]]);
    await client.close();
  });

  it("returns false and does nothing when the server has no tools/list handler", () => {
    expect(onToolsListed(new McpServer({ name: "t", version: "1" }), () => {})).toBe(false);
  });
});

// --- Durable Object harness ------------------------------------------------------------------------------

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
      MCP_USAGE: undefined,
      ...({ SCRY_LOG_SALT: "test-salt" } as Partial<Env>),
      ...overrides,
    });
    agent.props = props;
    await agent.init();
    const client = new Client({ name: "analytics-test", version: "9.8.7" });
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

type SearchResponse = typeof recorded.cases.latest.response;
function responseWithCanary(): SearchResponse {
  const r = structuredClone(recorded.cases.latest.response) as SearchResponse;
  for (const row of r.results as Array<Record<string, unknown>>) row.component_name = RESP_CANARY;
  return r;
}

interface World {
  /** Bodies POSTed to PostHog. */
  posthog: string[];
  console: string[];
  sink: ReturnType<typeof collectingSink>;
}

/** Stubs: search answers `respond`, PostHog (any host named posthog) records its bodies. Logs are collected. */
function world(respond: () => Response = () => Response.json(responseWithCanary())): World {
  const w: World = { posthog: [], console: [], sink: collectingSink() };
  setLogSinkForTest(w.sink);
  for (const m of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { w.console.push(a.map(String).join(" ")); });
  }
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("posthog")) {
      w.posthog.push(typeof init?.body === "string" ? init.body : String(init?.body ?? ""));
      return Response.json({ status: 1 });
    }
    return respond();
  });
  return w;
}

const toolLines = (w: World) => w.sink.lines.filter(l => l.msg === "mcp_tool_call") as unknown as Array<Record<string, unknown>>;
const requestLines = (w: World) => w.sink.lines.filter(l => l.msg === "request") as unknown as Array<Record<string, unknown>>;
const SINKS_BOTH = { ANALYTICS_SINKS: "log,posthog", POSTHOG_PROJECT_TOKEN: TOKEN } as Partial<Env>;

async function callSearch(client: Client, extra: Record<string, unknown> = {}) {
  return client.callTool({ name: "search_components", arguments: { query: ARG_CANARY, project_id: "proj-a", ...extra } });
}

describe("end to end in the Durable Object", () => {
  it("guarantee-1 argument values and response bodies appear in neither the logs nor PostHog", async () => {
    const w = world();
    await withClient(SINKS_BOTH, async client => {
      const r = await callSearch(client, { context: "looking for the login screen", conversation_id: "conv-1" });
      expect(JSON.stringify(r)).toContain(RESP_CANARY); // the caller does get the real answer
    });
    await vi.waitFor(() => expect(w.posthog.join("")).toContain("$mcp_tool_call"));
    const everything = [...w.console, ...w.posthog, JSON.stringify(w.sink.lines)].join("\n");
    expect(everything).not.toContain(ARG_CANARY);
    expect(everything).not.toContain(RESP_CANARY);
    expect(w.posthog.join("")).toContain("query"); // names yes
    expect(w.posthog.join("")).toContain("login screen"); // the (scrubbed) intent goes to PostHog only
    expect(JSON.stringify(w.sink.lines)).not.toContain("login screen"); // never into the logs
  });

  it("guarantee-2 no raw uid, email, key or token in any event or line", async () => {
    const w = world();
    await withClient(SINKS_BOTH, async client => {
      await callSearch(client, { context: `from ${EMAIL} using ${KEY_CANARY} at https://private.example.test/a` });
      await client.callTool({ name: "whoami", arguments: {} });
    });
    await vi.waitFor(() => expect(w.posthog.join("")).toContain("$mcp_tool_call"));
    const everything = [...w.console, ...w.posthog, JSON.stringify(w.sink.lines)].join("\n");
    for (const secret of [UID, EMAIL, KEY_CANARY, "private.example.test", TOKEN.replace("phc_", "")]) {
      // The PostHog token travels as the `api_key` field of the batch; it is not an event property.
      if (secret === TOKEN.replace("phc_", "")) continue;
      expect(everything).not.toContain(secret);
    }
    const hashes = toolLines(w).map(l => l.uid_hash);
    expect(hashes.length).toBeGreaterThan(0);
    for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(w.posthog.join("")).toContain(String(hashes[0])); // distinct_id is the hash
  });

  it("guarantee-3 a throwing or hanging sink leaves the tool result identical and bounded", async () => {
    const run = async (sinks: AnalyticsSink[] | null) => {
      const calls: number[] = [];
      const analytics = sinks ? createAnalytics({ sinks, budgetMs: 50 }) : undefined;
      const server = new McpServer({ name: "t", version: "1" });
      instrumentToolRegistration(server, { analytics, report: () => {}, emit: () => {}, identify: () => ({ uid: UID, salt: "s" }) });
      server.tool("echo", "e", { text: z.string() }, async ({ text }) => {
        calls.push(1);
        return { content: [{ type: "text", text: `echo:${text}` }] };
      });
      const client = new Client({ name: "c", version: "1" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      await client.connect(ct);
      const t0 = performance.now();
      const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
      const elapsed = performance.now() - t0;
      await client.close();
      return { result, elapsed, calls: calls.length };
    };
    const baseline = await run(null);
    const throwing = await run([fakeSink("t", { toolCall: () => { throw new Error("sink exploded"); } })]);
    const rejecting = await run([fakeSink("r", { toolCall: () => Promise.reject(new Error("sink rejected")) })]);
    const hanging = await run([fakeSink("h", { toolCall: () => new Promise<void>(() => {}) })]);
    for (const r of [throwing, rejecting, hanging]) {
      expect(r.result).toEqual(baseline.result);
      expect(r.calls).toBe(1);
      expect(r.elapsed).toBeLessThan(1500); // generous cap: a hang would be the 50 ms budget at most, never awaited
    }
  });

  it("guarantee-3 PostHog unreachable or a failing logger: the real tools still answer", async () => {
    const w = world();
    vi.mocked(globalThis.fetch).mockImplementation(async input => {
      if (String(input instanceof Request ? input.url : input).includes("posthog")) throw new Error("posthog down");
      return Response.json(responseWithCanary());
    });
    await withClient(SINKS_BOTH, async client => {
      const down = await callSearch(client);
      expect(down.isError).toBeFalsy();
      expect(JSON.stringify(down)).toContain(RESP_CANARY);
      setLogSinkForTest({ write: () => { throw new Error("logger broke"); }, flush: async () => {} });
      const broken = await callSearch(client);
      expect(broken.isError).toBeFalsy();
      expect(JSON.stringify(broken)).toContain(RESP_CANARY);
    });
    await sleep(30);
    expect(w.posthog).toHaveLength(0);
  });

  it("guarantee-4 exactly one mcp_tool_call line per call, joined to the request line, with and without PostHog", async () => {
    for (const overrides of [{} as Partial<Env>, { ANALYTICS_SINKS: "log" } as Partial<Env>, SINKS_BOTH]) {
      const w = world();
      await withClient(overrides, async client => {
        await callSearch(client);
        await callSearch(client, { project_id: "proj-b" });
        await client.callTool({ name: "whoami", arguments: {} });
      });
      await vi.waitFor(() => expect(toolLines(w)).toHaveLength(3));
      await sleep(40);
      const lines = toolLines(w);
      expect(lines).toHaveLength(3);
      expect(new Set(lines.map(l => l.request_id)).size).toBe(3);
      expect(lines.map(l => l.route)).toEqual(["search_components", "search_components", "whoami"]);
      expect(requestLines(w).map(l => l.request_id)).toEqual(lines.map(l => l.request_id));
      for (const l of lines) {
        expect(validateLine(l).errors).toEqual([]);
        expect(l.client).toBe("analytics-test/9.8.7");
      }
    }
  });

  it("guarantee-4 an erroring call is an error line with its code, and a $exception in PostHog", async () => {
    const w = world(() => Response.json({ error: "ACCESS_DENIED", message: "no" }, { status: 403 }));
    await withClient(SINKS_BOTH, async client => {
      await callSearch(client);
    });
    await vi.waitFor(() => expect(w.posthog.join("")).toContain("$exception"));
    const [line] = toolLines(w);
    expect(line).toMatchObject({ status: 403, err_code: "access_denied", level: "warn" });
  });

  it("guarantee-5 PostHog is replaceable: sinks=log (or no token) sends nothing and keeps the log complete", async () => {
    for (const overrides of [{ ANALYTICS_SINKS: "log", POSTHOG_PROJECT_TOKEN: TOKEN } as Partial<Env>, { ANALYTICS_SINKS: "log,posthog" } as Partial<Env>, { POSTHOG_PROJECT_TOKEN: TOKEN } as Partial<Env>]) {
      const w = world();
      await withClient(overrides, async client => { await callSearch(client); });
      await vi.waitFor(() => expect(toolLines(w)).toHaveLength(1));
      await sleep(60);
      expect(w.posthog).toHaveLength(0);
    }
  });

  it("guarantee-5 only src/analytics/sinks/posthog.ts imports a PostHog SDK, and lint forbids anything else", () => {
    const files = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const importing = Object.entries(files)
      .filter(([, text]) => /(?:from|import\()\s*["'](?:@posthog\/|posthog-node)/.test(text))
      .map(([path]) => path);
    expect(importing).toEqual(["../src/analytics/sinks/posthog.ts"]);
    expect(eslintRaw).toContain("no-restricted-imports");
    expect(eslintRaw).toContain("@posthog/*");
    expect(eslintRaw).toContain("posthog-node");
    expect(eslintRaw).toContain('ignores: ["src/analytics/sinks/posthog.ts"]');
  });

  it("guarantee-6 handlers never see context / conversation_id, whichever way the tool was registered", async () => {
    const seen: Record<string, unknown[]> = {};
    const server = new McpServer({ name: "t", version: "1" });
    const analytics = createAnalytics({ sinks: [] });
    instrumentToolRegistration(server, { analytics, report: () => {}, emit: () => {} });
    const record = (name: string) => async (...a: unknown[]) => { seen[name] = a; return { content: [{ type: "text" as const, text: name }] }; };
    server.registerTool("reg_shape", { description: "d", inputSchema: { q: z.string() } }, record("reg_shape") as never);
    server.registerTool("reg_obj", { description: "d", inputSchema: z.object({ q: z.string() }) as never }, record("reg_obj") as never);
    server.registerTool("reg_none", { description: "d" }, record("reg_none") as never);
    server.tool("old_shape", "d", { q: z.string() }, record("old_shape") as never);
    server.tool("old_empty", "d", {}, record("old_empty") as never);
    server.tool("old_bare", record("old_bare") as never);
    server.tool("old_desc_only", "d", record("old_desc_only") as never);
    server.tool("own_context", "d", { context: z.string(), q: z.string() }, record("own_context") as never);

    const client = new Client({ name: "c", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const { tools } = await client.listTools();
    for (const t of tools) {
      const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
      expect(props, t.name).toContain("context");
      expect(props, t.name).toContain("conversation_id");
    }
    const extras = { context: "why", conversation_id: "conv-1" };
    await client.callTool({ name: "reg_shape", arguments: { q: "x", ...extras } });
    await client.callTool({ name: "reg_obj", arguments: { q: "x", ...extras } });
    await client.callTool({ name: "reg_none", arguments: extras });
    await client.callTool({ name: "old_shape", arguments: { q: "x", ...extras } });
    await client.callTool({ name: "old_empty", arguments: extras });
    await client.callTool({ name: "old_bare", arguments: extras });
    await client.callTool({ name: "old_desc_only", arguments: extras });
    await client.callTool({ name: "own_context", arguments: { q: "x", context: "mine", conversation_id: "conv-1" } });

    expect(seen.reg_shape[0]).toEqual({ q: "x" });
    expect(seen.reg_obj[0]).toEqual({ q: "x" });
    expect(seen.old_shape[0]).toEqual({ q: "x" });
    expect(seen.own_context[0]).toEqual({ context: "mine", q: "x" }); // its own argument is untouched
    // Tools registered without an input schema keep the handler signature they were written for: (extra).
    for (const name of ["reg_none", "old_bare", "old_desc_only"]) {
      expect(seen[name], name).toHaveLength(1);
      expect(JSON.stringify(seen[name][0]), name).not.toContain("conv-1");
    }
    expect(Object.keys((seen.old_empty[0] ?? {}) as object)).not.toContain("context");
    await client.close();
  });

  it("guarantee-6 the real tools list the injected arguments and still work (registerAppTool, issue and capture tools included)", async () => {
    world();
    await withClient({ ISSUE_TOOLS_ENABLED: "1", CAPTURE_TOOLS_ENABLED: "1" } as Partial<Env>, async client => {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(5);
      for (const t of tools) {
        const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
        expect(props, t.name).toContain("context");
        expect(props, t.name).toContain("conversation_id");
        // Optional everywhere except get_more_tools, whose point is the context.
        const required = ((t.inputSchema as { required?: string[] }).required ?? []);
        expect(required.includes("conversation_id"), t.name).toBe(false);
        if (t.name !== "get_more_tools") expect(required.includes("context"), t.name).toBe(false);
      }
      expect(tools.map(t => t.name)).toContain("get_more_tools");
    });
  });

  it("guarantee-7 production sends nothing to PostHog: no sinks var, no token anywhere in the config", () => {
    const config = parseJsonc(wranglerRaw) as { vars?: Record<string, unknown>; env?: Record<string, { vars?: Record<string, unknown> }> };
    expect(config.vars?.ANALYTICS_SINKS).toBeUndefined();
    expect(JSON.stringify(config.vars)).not.toMatch(/posthog/i);
    expect(config.env?.staging?.vars?.ANALYTICS_SINKS).toBe("log,posthog");
    for (const [name, e] of Object.entries(config.env ?? {})) {
      if (name === "staging") continue;
      expect(String(e.vars?.ANALYTICS_SINKS ?? ""), name).not.toMatch(/posthog/i);
    }
    expect(wranglerRaw).not.toMatch(/phc_[A-Za-z0-9]{10,}/); // no token committed
    expect(parseSinks(undefined).names).toEqual(["log"]); // and the code default is log only
  });

  it("guarantee-7 a prod-like env (no ANALYTICS_SINKS) with a token present still sends nothing", async () => {
    const w = world();
    await withClient({ SCRY_ENV: "production", POSTHOG_PROJECT_TOKEN: TOKEN } as Partial<Env>, async client => { await callSearch(client); });
    await vi.waitFor(() => expect(toolLines(w)).toHaveLength(1));
    await sleep(60);
    expect(w.posthog).toHaveLength(0);
  });

  it("get_more_tools acknowledges, logs one line, and PostHog gets a missing-capability event with the scrubbed context", async () => {
    const w = world();
    await withClient(SINKS_BOTH, async client => {
      const r = await client.callTool({ name: "get_more_tools", arguments: { context: `need to export a Figma frame to PDF for ${EMAIL}`, conversation_id: "conv-7" } });
      expect(r.isError).toBeFalsy();
      expect(JSON.stringify(r)).toMatch(/recorded/i);
    });
    await vi.waitFor(() => expect(w.posthog.join("")).toContain("missing_capability"));
    expect(toolLines(w)).toHaveLength(1);
    expect(toolLines(w)[0].route).toBe("get_more_tools");
    const posted = w.posthog.join("");
    expect(posted).toContain("export a Figma frame to PDF");
    expect(posted).not.toContain(EMAIL);
    expect(JSON.stringify(w.sink.lines)).not.toContain("Figma frame");
  });

  it("initialize and tools/list produce events carrying the client name, version and protocol", async () => {
    const w = world();
    await withClient(SINKS_BOTH, async client => {
      await client.listTools();
    });
    await vi.waitFor(() => {
      expect(w.sink.lines.map(l => l.msg)).toContain("mcp_initialize");
      expect(w.sink.lines.map(l => l.msg)).toContain("mcp_tools_list");
      expect(w.posthog.join("")).toContain("$mcp_initialize");
      expect(w.posthog.join("")).toContain("$mcp_tools_list");
    });
    const init = w.sink.lines.find(l => l.msg === "mcp_initialize") as unknown as Record<string, unknown>;
    expect(init.client).toBe("analytics-test/9.8.7");
    expect(w.posthog.join("")).toContain("analytics-test");
  });

  it("the existing request line is unchanged: still one per call with its original keys", async () => {
    const w = world();
    await withClient({}, async client => { await callSearch(client); });
    await vi.waitFor(() => expect(requestLines(w)).toHaveLength(1));
    const [l] = requestLines(w);
    expect(l).toMatchObject({ msg: "request", route: "search_components", status: 200 });
    expect(Object.keys(l)).not.toContain("intent");
  });
});

// --- helpers -----------------------------------------------------------------------------------------------

/** Parse JSONC (comments and trailing commas), leaving "//" inside strings alone. */
function parseJsonc(text: string): unknown {
  const stripped = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str: string | undefined) => str ?? "");
  return JSON.parse(stripped.replace(/,(\s*[}\]])/g, "$1"));
}

describe("wrapToolHandler without analytics", () => {
  it("is unchanged when no analytics handle is given (no injection, args pass through)", async () => {
    const lines: unknown[] = [];
    let got: unknown;
    const h = wrapToolHandler("t", async (a: unknown) => { got = a; return { content: [] }; }, { emit: l => lines.push(l) });
    await h({ q: 1, context: "kept" }, {});
    expect(got).toEqual({ q: 1, context: "kept" });
    expect(lines).toHaveLength(1);
  });
});
