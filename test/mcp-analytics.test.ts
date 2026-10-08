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
  CORE_RULES,
  MAX_INTENT,
  MAX_INTENT_RAW,
  presentInputKeys,
  responseBytes,
  scrubIntent,
  scrubPass,
  statusOfOutcome,
  type McpToolCallEvent,
} from "../src/analytics/event";
import { agentArgsEnabled, createSinks } from "../src/analytics";
import { createAnalytics, noAnalytics, parseSinks, type AnalyticsSink } from "../src/analytics/sinks";
import { createLogSink } from "../src/analytics/sinks/log";
import { createPostHogSink, loadSdk, RETRY_BACKOFF_MS } from "../src/analytics/sinks/posthog";
import { onToolsListed } from "../src/analytics/hooks";
import { prepareSchema, stripInjected } from "../src/analytics/inject";
import { instrumentToolRegistration, wrapToolHandler } from "../src/lib/tool-request";
import { validateLine, type LogLine, type Sink } from "../src/lib/scry-log";
import { getLogger, setLogSinkForTest } from "../src/lib/log";
import recorded from "./fixtures/search-dedup-response.json";
import scrubCorpus from "./fixtures/scrub-corpus.json";
import piiCases from "./fixtures/scrub-pii-cases.json";
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

// --- fix round 1, item 1 (F1): the intent pipeline is bounded and linear ---------------------------------

/** Inputs that made the old URL / mixed-token rules backtrack: many boundaries, one very long run. */
const ADVERSARIAL: Array<[string, string]> = [
  ["a-", "a-"], ["a.", "a."], ["ab_", "ab_"], ["a/b-", "a/b-"], ["a://", "a://"], ["a1-", "a1-"],
  ["Bearer ", "Bearer "], ["eyJ", "eyJ"], ["ab12.", "ab12."], ["x ", "x "], ["+-", "+-"], ["1.", "1."],
  ["f", "f"], ["9", "9"], ["a:", "a:"], ["0:", "0:"], ["-", "-"],
];
const repeatTo = (unit: string, chars: number) => unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
/** Fastest of `rounds` runs of `fn` repeated `reps` times: robust against a noisy, loaded machine. */
function fastest(fn: () => void, reps: number, rounds = 3): number {
  let best = Infinity;
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now();
    for (let i = 0; i < reps; i++) fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe("scrubIntent is bounded and linear (fix 1, F1)", () => {
  it("fix1-item1a the scrubber is never called with more than 1000 characters", () => {
    const seen: number[] = [];
    const probe = (n: number) => { seen.push(n); };
    for (const big of [repeatTo("a-", 200_000), repeatTo("word ", 200_000), "x".repeat(MAX_INTENT_RAW + 1), "y".repeat(5_000_000)]) {
      seen.length = 0;
      scrubIntent(big, probe);
      expect(seen.length).toBeGreaterThan(0);
      expect(Math.max(...seen)).toBeLessThanOrEqual(MAX_INTENT_RAW);
    }
    // A value over the 300-char cap after the first scrub is scrubbed a second time, on at most 300 chars.
    seen.length = 0;
    scrubIntent("word ".repeat(100), probe);
    expect(seen).toEqual([500, MAX_INTENT]);
  });

  it("fix1-item1b scrubbing 100 KB costs no more than about 5x scrubbing 1 KB (ratio, no absolute time)", () => {
    for (const [name, unit] of ADVERSARIAL) {
      const small = repeatTo(unit, 1_000);
      const large = repeatTo(unit, 100_000);
      scrubIntent(small); // warm-up
      const t1 = fastest(() => scrubIntent(small), 20);
      const t100 = fastest(() => scrubIntent(large), 20);
      // The raw cap makes the two the same work; 5x leaves room for the one `slice` of the large value.
      expect(t100, name).toBeLessThanOrEqual(Math.max(t1 * 5, 5));
    }
  });

  it("fix1-item1b the rules themselves are linear: 4x the input costs well under 16x (a quadratic rule would not)", () => {
    for (const [name, unit] of ADVERSARIAL) {
      const a = repeatTo(unit, 20_000);
      const b = repeatTo(unit, 80_000);
      scrubPass(a);
      const ta = fastest(() => scrubPass(a), 3);
      const tb = fastest(() => scrubPass(b), 3);
      expect(tb, name).toBeLessThanOrEqual(Math.max(ta * 9, 40));
    }
  });

  it("fix1-item1c the reviewer's corpus gives identical output before and after the rewrite", () => {
    expect(scrubCorpus.length).toBeGreaterThanOrEqual(39);
    for (const row of scrubCorpus as Array<{ input: string; expected: string; before?: string }>) {
      // The rewritten original rules alone reproduce the old scrubber's output (`before` where phone / IP now differ)...
      expect(scrubPass(row.input, CORE_RULES), row.input).toBe(row.before ?? row.expected);
      // ...and the full pipeline gives the final output.
      expect(scrubIntent(row.input), row.input).toBe(row.expected);
    }
  });

  it("fix1-item1 a secret straddling the 1000 or 300 character cut leaves no fragment in the output", () => {
    const secret = "sk-" + "abcdefghij".repeat(3);
    for (const lead of [148, 150, 496, 498, 499]) {
      const out = scrubIntent(`${"x ".repeat(lead)}${secret} tail`)!;
      expect(out.length, String(lead)).toBeLessThanOrEqual(MAX_INTENT);
      expect(out, String(lead)).not.toMatch(/(?:sk-|abcdefghij|sk$)/);
    }
  });
});

// --- fix round 1, item 2: phone numbers and IP addresses --------------------------------------------------

describe("scrubIntent phone and IP redaction (fix 1)", () => {
  it("fix1-item2 redacts E.164 and common US phone formats", () => {
    for (const phone of piiCases.phones) {
      expect(scrubIntent(`call ${phone} today`), phone).toBe("call [redacted] today");
    }
    expect(scrubIntent("fax (210) 555-0199, voice +1-210-555-0188.")).toBe("fax [redacted], voice [redacted].");
  });

  it("fix1-item2 redacts IPv4 and IPv6 addresses", () => {
    for (const ip of piiCases.ips) {
      expect(scrubIntent(`host ${ip} down`), ip).toBe("host [redacted] down");
    }
    expect(scrubIntent("from 10.1.2.3, to 10.1.2.4.")).toBe("from [redacted], to [redacted].");
  });

  it("fix1-item2 does not redact ISO dates, times, version numbers and ordinary numbers", () => {
    for (const text of piiCases.keep) expect(scrubIntent(`see ${text} here`), text).toBe(`see ${text} here`);
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

  it("fix1-item5 client name/version, protocol and model are a safe token or \"other\" (never partly sent)", () => {
    const hostile = [...piiCases.hostile_labels, "x".repeat(65)];
    for (const bad of hostile) {
      const e = buildToolCallEvent({ ...base, client_name: bad, client_version: bad, protocol_version: bad, llmModel: bad });
      expect([e.client_name, e.client_version, e.protocol_version, e.llm_model], bad).toEqual(["other", "other", "other", "other"]);
      const i = buildInitializeEvent({ client_name: bad, client_version: bad, protocol_version: bad, session_id: "do_1", env: "staging" });
      expect([i.client_name, i.client_version, i.protocol_version], bad).toEqual(["other", "other", "other"]);
      expect(JSON.stringify([e, i])).not.toContain(bad);
    }
    for (const good of ["claude-code", "Claude Desktop", "codex_cli/0.4.1", "cursor (v1)+x", "2025-06-18", "gpt-5.1", "9.8.7"]) {
      const e = buildToolCallEvent({ ...base, client_name: good, client_version: good, protocol_version: good, llmModel: good });
      expect([e.client_name, e.client_version, e.protocol_version, e.llm_model]).toEqual([good, good, good, good]);
    }
    expect(buildToolCallEvent({ ...base, client_name: "", llmModel: undefined }).client_name).toBeUndefined();
    expect(buildToolCallEvent({ ...base, client_name: 42 as unknown as string }).client_name).toBe("other");
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
  it("ANALYTICS_SINKS: log is always on, csv, none/off add nothing, unknown names are reported", () => {
    expect(parseSinks(undefined).names).toEqual(["log"]);
    expect(parseSinks("").names).toEqual(["log"]);
    expect(parseSinks("log, PostHog ,log").names).toEqual(["log", "posthog"]);
    expect(parseSinks("none").names).toEqual(["log"]); // fix1-item7: whatever the setting says, the log sink is on
    expect(parseSinks("off").names).toEqual(["log"]);
    expect(parseSinks("posthog").names).toEqual(["log", "posthog"]);
    expect(parseSinks("log,mixpanel")).toEqual({ names: ["log"], unknown: ["mixpanel"] });
  });

  it("ANALYTICS_AGENT_ARGS is off unless it is exactly \"on\"", () => {
    expect(agentArgsEnabled({})).toBe(false);
    for (const v of ["", "off", "0", "true", "1", "yes", " "]) expect(agentArgsEnabled({ ANALYTICS_AGENT_ARGS: v }), v).toBe(false);
    for (const v of ["on", "ON", " On "]) expect(agentArgsEnabled({ ANALYTICS_AGENT_ARGS: v }), v).toBe(true);
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
      serverBuild: "28f387c84841a3bd40676a07c1cd930cf3a6683c", // a real 40-hex SCRY_COMMIT (F15: it was dropped as secret-shaped)
    }));
    expect(sink.lines).toHaveLength(1);
    const line = sink.lines[0] as unknown as Record<string, unknown>;
    expect(validateLine(line).errors).toEqual([]);
    expect((line.attrs as Record<string, unknown>)["mcp.server_build"]).toBeUndefined(); // the build rides in top-level `version`
    expect(line).toMatchObject({ msg: "mcp_tool_call", route: "search_components", status: 403, request_id: "01M3EQG44Y0J8F2K6ZP9RX1T7C", uid_hash: "abcdef012345" });
    expect(line.client).toBeUndefined(); // third-party clients are not allow-listed for `client`; they ride in attrs
    expect(line.attrs).toMatchObject({ "mcp.client_name": "claude-code", "mcp.client_version": "2.1.0", "mcp.has_intent": true, "mcp.input_keys": ["query"], "mcp.response_bytes": 9 });
    expect((line as { attrs_drop?: number }).attrs_drop).toBeUndefined();
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
    const [init, list] = sink.lines as unknown as Array<Record<string, unknown>>;
    expect(init.attrs).toMatchObject({ "mcp.client_name": "cursor", "mcp.client_version": "1.0" });
    expect(list.attrs).toMatchObject({ "mcp.tool_count": 1 });
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

describe("posthog sink load failure (fix 1, F5)", () => {
  const okFetch = async () => ({ status: 200, text: async () => "{}", json: async () => ({ status: 1 }) }) as never;

  it("fix1-item6 a failed client load warns once per failure, backs off for 60 s, then retries and succeeds", async () => {
    let clock = 1_000_000;
    let loads = 0;
    let failing = true;
    const warnings: number[] = [];
    const sink = createPostHogSink({
      token: TOKEN,
      fetch: okFetch,
      now: () => clock,
      loadSdk: (async () => {
        loads++;
        if (failing) throw new Error("module failed to load");
        return loadSdk();
      }) as typeof loadSdk,
      onLoadError: () => warnings.push(clock),
    })!;
    expect(RETRY_BACKOFF_MS).toBeGreaterThanOrEqual(60_000);

    await sink.toolCall(sampleEvent());
    expect([loads, warnings.length]).toEqual([1, 1]);

    // Inside the backoff: no new load attempt, no new warning, still no throw.
    clock += RETRY_BACKOFF_MS - 1;
    await sink.toolCall(sampleEvent());
    await sink.toolsList(buildToolsListEvent({ toolNames: ["a"], env: "staging" }));
    expect([loads, warnings.length]).toEqual([1, 1]);

    // After the backoff the load is tried again; a second failure is a second warning, and backs off again.
    clock += 2;
    await sink.toolCall(sampleEvent());
    expect([loads, warnings.length]).toEqual([2, 2]);
    await sink.toolCall(sampleEvent());
    expect([loads, warnings.length]).toEqual([2, 2]);

    // The module becomes loadable: the next attempt after the backoff creates the client, and it is kept.
    failing = false;
    clock += RETRY_BACKOFF_MS + 1;
    await sink.toolCall(sampleEvent());
    expect([loads, warnings.length]).toEqual([3, 2]);
    await sink.toolCall(sampleEvent());
    expect(loads).toBe(3);
  });

  it("fix1-item6 the failure is one schema-v1 warning line with err_code analytics_posthog_load and no value in it", async () => {
    const lines: Array<{ msg: string; err_code: string }> = [];
    const sinks = createSinks(
      { ANALYTICS_SINKS: "log,posthog", POSTHOG_PROJECT_TOKEN: TOKEN, SCRY_LOG_SALT: "s" },
      { logger: (() => ({})) as never, warn: (msg, err_code) => lines.push({ msg, err_code }), posthogLoadSdk: (async () => { throw new Error(`boom ${TOKEN}`); }) as typeof loadSdk },
    );
    const posthog = sinks.find(x => x.name === "posthog")!;
    await posthog.toolCall(sampleEvent());
    await posthog.toolCall(sampleEvent());
    expect(lines).toEqual([{ msg: "analytics posthog load failed", err_code: "analytics_posthog_load" }]);
  });
});

describe("createSinks configuration warnings (fix 1)", () => {
  const deps = () => {
    const lines: Array<{ msg: string; err_code: string }> = [];
    return { lines, deps: { logger: (() => ({})) as never, warn: (msg: string, err_code: string) => lines.push({ msg, err_code }) } };
  };

  it("fix1-item7 an unknown sink name logs one warning line and the log sink still runs", () => {
    const { lines, deps: d } = deps();
    const sinks = createSinks({ ANALYTICS_SINKS: "log,posthg,mixpanel" }, d);
    expect(sinks.map(x => x.name)).toEqual(["log"]);
    expect(lines).toEqual([{ msg: "analytics unknown sink", err_code: "analytics_unknown_sink" }]);
    expect(lines.map(l => JSON.stringify(l)).join()).not.toMatch(/posthg|mixpanel/); // the typo is not echoed
  });

  it("fix1-item7 the log sink is always on, whatever ANALYTICS_SINKS says", () => {
    for (const value of [undefined, "", "none", "off", "posthog", "mixpanel"]) {
      const { deps: d } = deps();
      expect(createSinks({ ANALYTICS_SINKS: value }, d).map(x => x.name), String(value)).toContain("log");
    }
  });

  it("fix1-item9 the posthog sink refuses to start without SCRY_LOG_SALT: one warning line, log sink still on", () => {
    for (const salt of [undefined, "", "   "]) {
      const { lines, deps: d } = deps();
      const sinks = createSinks({ ANALYTICS_SINKS: "log,posthog", POSTHOG_PROJECT_TOKEN: TOKEN, SCRY_LOG_SALT: salt }, d);
      expect(sinks.map(x => x.name), String(salt)).toEqual(["log"]);
      expect(lines).toEqual([{ msg: "analytics posthog disabled", err_code: "analytics_posthog_no_salt" }]);
    }
    const { lines, deps: d } = deps();
    expect(createSinks({ ANALYTICS_SINKS: "log,posthog", POSTHOG_PROJECT_TOKEN: TOKEN, SCRY_LOG_SALT: "s" }, d).map(x => x.name)).toEqual(["log", "posthog"]);
    expect(lines).toEqual([]);
    // Named but no token: the existing quiet "off" (production's shape), no warning.
    expect(createSinks({ ANALYTICS_SINKS: "log,posthog", SCRY_LOG_SALT: "s" }, d).map(x => x.name)).toEqual(["log"]);
    expect(lines).toEqual([]);
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
      // Each test chooses its sinks and agent-args flag; the wrangler production values must not leak in as defaults.
      ...({ SCRY_LOG_SALT: "test-salt", ANALYTICS_SINKS: undefined, ANALYTICS_AGENT_ARGS: undefined } as Partial<Env>),
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
const AGENT_ARGS_ON = { ANALYTICS_AGENT_ARGS: "on" } as Partial<Env>;
/** The staging shape: both sinks, the PostHog token, and the agent-visible arguments on. */
const SINKS_BOTH = { ANALYTICS_SINKS: "log,posthog", POSTHOG_PROJECT_TOKEN: TOKEN, ...AGENT_ARGS_ON } as Partial<Env>;

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
    // fix1-item7: `posthog` alone (no `log` in the setting) still writes the line, because the log sink is always on.
    const posthogOnly = { ANALYTICS_SINKS: "posthog", POSTHOG_PROJECT_TOKEN: TOKEN } as Partial<Env>;
    for (const overrides of [{} as Partial<Env>, { ANALYTICS_SINKS: "log" } as Partial<Env>, SINKS_BOTH, posthogOnly, { ANALYTICS_SINKS: "none" } as Partial<Env>]) {
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
        expect(l.client).toBeUndefined();
        // The full event rides in the registered attrs: nothing dropped, no intent text, no argument values.
        expect(l.attrs_drop).toBeUndefined();
        expect(l.attrs).toMatchObject({
          "mcp.client_name": "analytics-test",
          "mcp.client_version": "9.8.7",
          "mcp.has_intent": false,
          "mcp.missing_capability": false,
        });
        const a = l.attrs as Record<string, unknown>;
        expect(a["mcp.session_id"]).toMatch(/^do_[0-9a-f]{16}$/);
        expect(typeof a["mcp.response_bytes"]).toBe("number");
        expect(JSON.stringify(a)).not.toContain(ARG_CANARY);
      }
      expect((lines[0].attrs as Record<string, string[]>)["mcp.input_keys"]).toEqual(expect.arrayContaining(["query", "project_id"])); // names only
      expect((lines[2].attrs as Record<string, string[]>)["mcp.input_keys"]).toEqual([]);
    }
  });

  it("guarantee-4 the line's attrs carry the conversation, intent flag and source but never the intent text", async () => {
    const w = world();
    await withClient({ ANALYTICS_SINKS: "log", ...AGENT_ARGS_ON } as Partial<Env>, async client => {
      await callSearch(client, { context: `find the login form for ${EMAIL}`, conversation_id: "conv-1" });
    });
    await vi.waitFor(() => expect(toolLines(w)).toHaveLength(1));
    const [line] = toolLines(w);
    expect(validateLine(line).errors).toEqual([]);
    expect(line.attrs_drop).toBeUndefined();
    expect(line.attrs).toMatchObject({ "mcp.conversation_id": "conv-1", "mcp.has_intent": true, "mcp.intent_source": "context_parameter" });
    expect(JSON.stringify(line)).not.toMatch(/login form|acme|@/);
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
    for (const overrides of [
      { ANALYTICS_SINKS: "log", POSTHOG_PROJECT_TOKEN: TOKEN } as Partial<Env>,
      { ANALYTICS_SINKS: "log,posthog" } as Partial<Env>,
      { POSTHOG_PROJECT_TOKEN: TOKEN } as Partial<Env>,
      { ANALYTICS_SINKS: "none", POSTHOG_PROJECT_TOKEN: TOKEN } as Partial<Env>,
    ]) {
      const w = world();
      await withClient(overrides, async client => { await callSearch(client); });
      await vi.waitFor(() => expect(toolLines(w)).toHaveLength(1));
      await sleep(60);
      expect(w.posthog).toHaveLength(0);
    }
  });

  it("fix1-item7 guarantee-5 an unknown sink name logs one warning line in the Durable Object and the log line still lands", async () => {
    const w = world();
    await withClient({ ANALYTICS_SINKS: "log,posthg" } as Partial<Env>, async client => { await callSearch(client); });
    await vi.waitFor(() => expect(toolLines(w)).toHaveLength(1));
    const warnings = w.sink.lines.filter(l => l.msg === "analytics unknown sink") as unknown as Array<Record<string, unknown>>;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: "warn", err_code: "analytics_unknown_sink" });
    expect(validateLine(warnings[0]).errors).toEqual([]);
    expect(JSON.stringify(warnings[0])).not.toContain("posthg");
  });

  it("fix1-item9 posthog enabled but SCRY_LOG_SALT missing: no PostHog traffic, one warning line, the log line still lands", async () => {
    const w = world();
    await withClient({ ...SINKS_BOTH, SCRY_LOG_SALT: undefined } as Partial<Env>, async client => {
      await callSearch(client);
      await callSearch(client);
    });
    await vi.waitFor(() => expect(toolLines(w)).toHaveLength(2));
    await sleep(60);
    expect(w.posthog).toHaveLength(0);
    const warnings = w.sink.lines.filter(l => l.msg === "analytics posthog disabled") as unknown as Array<Record<string, unknown>>;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: "warn", err_code: "analytics_posthog_no_salt" });
    expect(validateLine(warnings[0]).errors).toEqual([]);
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
    instrumentToolRegistration(server, { analytics, injectArgs: true, report: () => {}, emit: () => {} });
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
    await withClient({ ISSUE_TOOLS_ENABLED: "1", CAPTURE_TOOLS_ENABLED: "1", ...AGENT_ARGS_ON } as Partial<Env>, async client => {
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

  it("guarantee-7 (after Gate B) production and staging both send to log + PostHog; no token is committed anywhere", () => {
    const config = parseJsonc(wranglerRaw) as { vars?: Record<string, unknown>; env?: Record<string, { vars?: Record<string, unknown> }> };
    expect(config.vars?.ANALYTICS_SINKS).toBe("log,posthog"); // Gate B approved 2026-10-08; the token is a secret
    expect(config.env?.staging?.vars?.ANALYTICS_SINKS).toBe("log,posthog");
    expect(wranglerRaw).not.toMatch(/phc_[A-Za-z0-9]{10,}/); // no token committed
    expect(parseSinks(undefined).names).toEqual(["log"]); // and the code default is still log only
  });

  it("fix1-item8 (after F22) production and staging both turn the agent-visible args on; the code default is off", () => {
    const config = parseJsonc(wranglerRaw) as { vars?: Record<string, unknown>; env?: Record<string, { vars?: Record<string, unknown> }> };
    expect(config.vars?.ANALYTICS_AGENT_ARGS).toBe("on"); // founder decision F22, 2026-10-08
    expect(config.env?.staging?.vars?.ANALYTICS_AGENT_ARGS).toBe("on");
    expect(agentArgsEnabled({ ANALYTICS_AGENT_ARGS: undefined })).toBe(false); // absent = off
  });

  it("fix1-item8 with the flag off (the production shape) no tool gains context / conversation_id and get_more_tools is absent, yet events flow", async () => {
    for (const flag of [undefined, "off", "", "0"]) {
      const w = world();
      await withClient({ ISSUE_TOOLS_ENABLED: "1", CAPTURE_TOOLS_ENABLED: "1", ANALYTICS_AGENT_ARGS: flag, ANALYTICS_SINKS: "log,posthog", POSTHOG_PROJECT_TOKEN: TOKEN } as Partial<Env>, async client => {
        const { tools } = await client.listTools();
        expect(tools.length).toBeGreaterThan(5);
        expect(tools.map(t => t.name)).not.toContain("get_more_tools");
        for (const t of tools) {
          const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
          expect(props, `${t.name} ${flag}`).not.toContain("context");
          expect(props, `${t.name} ${flag}`).not.toContain("conversation_id");
        }
        const r = await callSearch(client);
        expect(JSON.stringify(r)).toContain(RESP_CANARY);
        const missing = await client.callTool({ name: "get_more_tools", arguments: { context: "x" } }).then(r => r.isError === true, () => true);
        expect(missing).toBe(true); // an unknown tool: an error result or a protocol error, never an answer
      });
      await vi.waitFor(() => expect(toolLines(w).length).toBeGreaterThanOrEqual(1));
      await vi.waitFor(() => expect(w.posthog.join("")).toContain("$mcp_tool_call"));
      expect(toolLines(w)[0].attrs).toMatchObject({ "mcp.has_intent": false, "mcp.missing_capability": false });
    }
  });

  it("fix1-item3 an injected context / conversation_id of the wrong type or size is dropped: the result equals the call without it", async () => {
    const w = world();
    await withClient(SINKS_BOTH, async client => {
      const { tools } = await client.listTools();
      for (const t of tools.filter(x => x.name !== "get_more_tools")) {
        const p = (t.inputSchema as { properties: Record<string, { type?: string; description?: string }> }).properties;
        for (const arg of ["context", "conversation_id"]) {
          expect(p[arg].type, `${t.name}.${arg}`).toBe("string"); // still advertised as a string
          expect(p[arg].description, `${t.name}.${arg}`).toBeTruthy();
        }
      }
      const baseline = await callSearch(client);
      expect(baseline.isError).toBeFalsy();
      const bad: unknown[] = [null, 123, { a: 1 }, ["x"], true, "z".repeat(5000)];
      for (const value of bad) {
        for (const arg of ["context", "conversation_id"]) {
          const r = await callSearch(client, { [arg]: value });
          expect(r, `${arg}=${JSON.stringify(value)?.slice(0, 20)}`).toEqual(baseline);
        }
        const both = await callSearch(client, { context: value, conversation_id: value });
        expect(both).toEqual(baseline);
      }
      // whoami (no arguments of its own) behaves the same.
      const who = await client.callTool({ name: "whoami", arguments: {} });
      expect(await client.callTool({ name: "whoami", arguments: { context: null, conversation_id: 5 } })).toEqual(who);
    });
    await vi.waitFor(() => expect(toolLines(w).length).toBeGreaterThan(10));
    // Nothing from a dropped value reached analytics: no intent, no conversation id, in the lines or PostHog.
    for (const l of toolLines(w)) {
      expect(l.attrs).toMatchObject({ "mcp.has_intent": false });
      expect((l.attrs as Record<string, unknown>)["mcp.conversation_id"]).toBeUndefined();
    }
    expect(w.posthog.join("")).not.toContain("zzzzzzzz");
  });

  it("fix1-item3 a valid string context still becomes the intent (the lenient schema only drops bad values)", async () => {
    const w = world();
    await withClient(SINKS_BOTH, async client => {
      await callSearch(client, { context: "finding the pricing page", conversation_id: "conv-ok" });
    });
    await vi.waitFor(() => expect(w.posthog.join("")).toContain("finding the pricing page"));
    expect(toolLines(w)[0].attrs).toMatchObject({ "mcp.has_intent": true, "mcp.conversation_id": "conv-ok" });
  });

  it("fix1-item4 a tool that declares its own context / conversation_id keeps them: not injected, never read as the intent", async () => {
    const events: McpToolCallEvent[] = [];
    const sink = fakeSink("collect", { toolCall: e => { events.push(e); } });
    const server = new McpServer({ name: "t", version: "1" });
    instrumentToolRegistration(server, { analytics: createAnalytics({ sinks: [sink] }), injectArgs: true, report: () => {}, emit: () => {} });
    const seen: unknown[] = [];
    const own = async (a: unknown) => { seen.push(a); return { content: [{ type: "text" as const, text: "ok" }] }; };
    server.tool("own_args", "d", { context: z.string().describe("OWN-CONTEXT"), conversation_id: z.string().describe("OWN-CONV"), q: z.string() }, own as never);
    server.tool("plain", "d", { q: z.string() }, own as never);
    const client = new Client({ name: "c", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const { tools } = await client.listTools();
    const ownProps = (tools.find(t => t.name === "own_args")!.inputSchema as { properties: Record<string, { description?: string }>; required?: string[] });
    expect(ownProps.properties.context.description).toBe("OWN-CONTEXT"); // the tool's own definition, not ours
    expect(ownProps.properties.conversation_id.description).toBe("OWN-CONV");
    expect(ownProps.required).toEqual(expect.arrayContaining(["context", "conversation_id"]));
    expect((tools.find(t => t.name === "plain")!.inputSchema as { properties: object }).properties).toHaveProperty("context"); // control: injected

    await client.callTool({ name: "own_args", arguments: { context: "SECRET customer document text", conversation_id: "doc-42", q: "x" } });
    await client.callTool({ name: "plain", arguments: { q: "x", context: "why", conversation_id: "conv-2" } });
    await vi.waitFor(() => expect(events).toHaveLength(2));

    expect(seen[0]).toEqual({ context: "SECRET customer document text", conversation_id: "doc-42", q: "x" }); // the handler gets its own values
    const [ownEvent, plainEvent] = events;
    expect(ownEvent.intent).toBeUndefined();
    expect(ownEvent.intent_source).toBeUndefined();
    expect(ownEvent.conversation_id).toBeUndefined();
    expect(JSON.stringify(ownEvent)).not.toMatch(/SECRET|doc-42/);
    expect(ownEvent.input_keys).toEqual(expect.arrayContaining(["context", "conversation_id", "q"])); // its names are visible
    expect(plainEvent).toMatchObject({ intent: "why", conversation_id: "conv-2", intent_source: "context_parameter" });
    expect(plainEvent.input_keys).toEqual(["q"]);
    await client.close();
  });

  it("fix1-item5 a hostile client name, version, protocol and model reach neither the log attrs nor PostHog (they become \"other\")", async () => {
    const w = world();
    const evil = "evil@corp.io sk-abcdefghijklmnopqrstuvwxyz0123";
    const stub = env.MCP_OBJECT.get(env.MCP_OBJECT.newUniqueId());
    await runInDurableObject(stub, async (_instance, state) => {
      const agent = new TestScryMCP(state, {
        ...env, SCRY_ENV: "staging", SCRY_SEARCH_API_URL: "https://search.example.test", SCRY_SEARCH_API_KEY: "k",
        SCRY_CALLER_ASSERTION_SECRET: "s", MCP_USAGE: undefined, SCRY_LOG_SALT: "test-salt", ...SINKS_BOTH,
      } as Env);
      agent.props = props;
      await agent.init();
      const client = new Client({ name: evil, version: `v${evil}` });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await agent.server.connect(st);
      await client.connect(ct);
      await client.listTools();
      await callSearch(client);
      await client.close();
      await agent.server.close();
    });
    await vi.waitFor(() => {
      expect(w.posthog.join("")).toContain("$mcp_initialize");
      expect(w.posthog.join("")).toContain("$mcp_tool_call");
      expect(toolLines(w)).toHaveLength(1);
    });
    const everything = [...w.posthog, JSON.stringify(w.sink.lines)].join("\n");
    expect(everything).not.toMatch(/evil@corp|corp\.io|sk-abcdef/);
    expect(everything).toContain('"other"');
    expect(toolLines(w)[0].attrs).toMatchObject({ "mcp.client_name": "other", "mcp.client_version": "other" });
    const init = w.sink.lines.find(l => l.msg === "mcp_initialize") as unknown as Record<string, unknown>;
    expect(init.attrs).toMatchObject({ "mcp.client_name": "other", "mcp.client_version": "other" });
    expect(w.posthog.join("")).toMatch(/\$mcp_client_name"\s*:\s*"other"/);
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
    expect(init.attrs).toMatchObject({ "mcp.client_name": "analytics-test", "mcp.client_version": "9.8.7" });
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
