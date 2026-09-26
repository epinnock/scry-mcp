import { env, runInDurableObject } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScryMCP, type AuthProps } from "../src/mcp";
import { resetSampleRateCache, type SpansMessage } from "../src/telemetry/producer";
import { traceIdFor } from "../src/telemetry/ids";

declare module "cloudflare:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Workers pool environment augmentation.
  interface ProvidedEnv extends Env {}
}

const props: AuthProps = {
  firebaseUid: "gen-test-user",
  email: "gen@example.test",
  displayName: "Gen Test",
  emailVerified: true,
};

const GATEWAY = "https://gateway.ai.cloudflare.com/v1/acct/scry-stage";
const GEMINI_KEY = "test-gemini-key";

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
      GEMINI_API_KEY: GEMINI_KEY,
      MCP_USAGE: undefined,
      ...overrides,
    });
    agent.props = props;
    await agent.init();
    const client = new Client({ name: "gen-test", version: "1.0.0" });
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

type Captured = { url: string; headers: Headers; body: string };

function mockUpstreams(gemini: () => Response = () => Response.json({
  candidates: [{ finishReason: "STOP", content: { parts: [
    { text: "A blue button" },
    { inlineData: { data: "aW1hZ2U=", mimeType: "image/png" } },
  ] } }],
  usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 1290, totalTokenCount: 1299 },
}), sampling: (() => Response) | null = null) {
  const calls: Captured[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes(":generateContent")) {
      calls.push({ url, headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      return gemini();
    }
    if (url.endsWith("/api/telemetry/sampling") && sampling) {
      calls.push({ url, headers: new Headers(init?.headers), body: "" });
      return sampling();
    }
    if (url.endsWith("/api/image/upload")) return Response.json({ success: true });
    if (url.endsWith("/api/image/presign")) {
      return Response.json({ url: "https://images.example.test/image.png", expires_at: "2030-01-01T00:00:00Z" });
    }
    throw new Error(`Unexpected test fetch: ${url}`);
  });
  return calls;
}

function fakeQueue() {
  return { send: vi.fn(async (_body: SpansMessage, _opts?: unknown) => {}), sendBatch: vi.fn() };
}

const REF = `data:image/png;base64,${"iVBORw0KGgo".repeat(100)}`;
const call = { name: "generate_image", arguments: { prompt: "A blue button", reference_images: [REF] } };

afterEach(() => {
  vi.restoreAllMocks();
  resetSampleRateCache();
});

describe("generate_image through the AI Gateway", () => {
  it("routes via google-ai-studio with the key in x-goog-api-key and the cf-aig headers", async () => {
    const calls = mockUpstreams();
    await withClient({ LLM_GATEWAY_URL: GATEWAY, CF_AIG_TOKEN: "run-token" }, async (client) => {
      const result = await client.callTool(call);
      expect(result.isError).not.toBe(true);
    });
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.url).toBe(`${GATEWAY}/google-ai-studio/v1beta/models/gemini-3.1-flash-image-preview:generateContent`);
    expect(c.url).not.toContain("key=");
    expect(c.url).not.toContain(GEMINI_KEY);
    expect(c.headers.get("x-goog-api-key")).toBe(GEMINI_KEY);
    expect(c.headers.get("cf-aig-authorization")).toBe("Bearer run-token");
    expect(c.headers.get("cf-aig-skip-cache")).toBe("true");
    expect(c.headers.get("cf-aig-collect-log-payload")).toBe("false");
    const meta = JSON.parse(c.headers.get("cf-aig-metadata")!);
    expect(Object.keys(meta)).toEqual(["svc", "feat", "user", "run"]);
    expect(meta).toMatchObject({ svc: "mcp", feat: "generate_image", user: props.firebaseUid });
    expect(meta.run).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // the tool call's x-scry-request-id
  });

  it("goes direct with no cf-aig header when LLM_GATEWAY_URL is unset (kill switch), key still in a header", async () => {
    const calls = mockUpstreams();
    await withClient({ LLM_GATEWAY_URL: undefined, CF_AIG_TOKEN: "run-token" }, async (client) => {
      expect((await client.callTool(call)).isError).not.toBe(true);
    });
    const [c] = calls;
    expect(c.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent");
    expect(c.headers.get("x-goog-api-key")).toBe(GEMINI_KEY);
    expect([...c.headers.keys()].filter((k) => k.startsWith("cf-aig"))).toEqual([]);
    // The request body itself is unchanged: reference image first, then the prompt.
    const body = JSON.parse(c.body);
    expect(body.contents[0].parts[0].inlineData.mimeType).toBe("image/png");
    expect(body.contents[0].parts[1]).toEqual({ text: "A blue button" });
  });

  it("fails closed as SERVER_MISCONFIGURED without calling Gemini when the token is missing", async () => {
    const calls = mockUpstreams();
    const queue = fakeQueue();
    await withClient({ LLM_GATEWAY_URL: GATEWAY, CF_AIG_TOKEN: undefined, LANGFUSE_ENABLED: "1", TELEMETRY_QUEUE: queue as never }, async (client) => {
      const result = await client.callTool(call);
      expect(result.isError).toBe(true);
      expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({ error: "SERVER_MISCONFIGURED", retryable: false });
    });
    expect(calls).toHaveLength(0);
    // Root span only: no request was sent.
    expect(queue.send.mock.calls[0][0].span_count).toBe(1);
  });
});

describe("generate_image traces", () => {
  it("enqueues root + LLM spans with tokens, the R2 ref and no image bytes", async () => {
    mockUpstreams();
    const queue = fakeQueue();
    await withClient({ LLM_GATEWAY_URL: GATEWAY, CF_AIG_TOKEN: "t", LANGFUSE_ENABLED: "1", TELEMETRY_QUEUE: queue as never }, async (client) => {
      expect((await client.callTool(call)).isError).not.toBe(true);
    });
    expect(queue.send).toHaveBeenCalledOnce();
    const msg = queue.send.mock.calls[0][0];
    expect(msg).toMatchObject({ v: 1, kind: "spans", service: "mcp", env: "staging", span_count: 2 });
    expect(msg.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const spans = msg.otlp.resourceSpans[0].scopeSpans[0].spans;
    expect(spans.map((s) => s.name)).toEqual(["mcp.generate_image", "llm.gemini_image"]);
    expect(spans[0].traceId).toBe(traceIdFor(msg.run_id));
    const attr = (i: number, k: string) => spans[i].attributes.find((a) => a.key === k)?.value;
    expect(attr(1, "llm.token_count.total")).toEqual({ intValue: "1299" });
    expect(attr(1, "llm.model_name")).toEqual({ stringValue: "gemini-3.1-flash-image-preview" });
    expect(String(attr(1, "llm.output_messages.0.message.contents.1.message_content.image.image.url")?.stringValue))
      .toMatch(/^scry-r2:\/\/scry-component-snapshot-bucket-staging\/generated\/gen-test-user\/\d+-[0-9a-f]{12}\.png$/);
    expect(attr(0, "user.id")).toEqual({ stringValue: props.firebaseUid });
    const text = JSON.stringify(msg);
    expect(text).not.toContain("data:image");
    expect(text).not.toContain("aW1hZ2U=");
    expect(text).not.toContain(GEMINI_KEY);
    expect(text).not.toContain(props.email);
  });

  it("traces an upstream error and keeps the tool error contract", async () => {
    mockUpstreams(() => new Response("boom", { status: 503 }));
    const queue = fakeQueue();
    await withClient({ LANGFUSE_ENABLED: "1", TELEMETRY_QUEUE: queue as never }, async (client) => {
      const result = await client.callTool(call);
      expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({ error: "GEMINI_API_ERROR", retryable: true });
    });
    const spans = queue.send.mock.calls[0][0].otlp.resourceSpans[0].scopeSpans[0].spans;
    expect(spans[1].status).toEqual({ code: 2, message: "HTTP 503" });
    expect(spans[0].status).toEqual({ code: 2, message: "GEMINI_API_ERROR" });
  });

  it("traces a safety block", async () => {
    mockUpstreams(() => Response.json({ candidates: [{ finishReason: "SAFETY" }] }));
    const queue = fakeQueue();
    await withClient({ LANGFUSE_ENABLED: "1", TELEMETRY_QUEUE: queue as never }, async (client) => {
      const result = await client.callTool(call);
      expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({ error: "SAFETY_FILTERED" });
    });
    const spans = queue.send.mock.calls[0][0].otlp.resourceSpans[0].scopeSpans[0].spans;
    expect(spans[1].attributes.find((a) => a.key === "metadata")?.value.stringValue).toContain('"finish_reason":"SAFETY"');
  });

  it("sends nothing when disabled or sampled out, and a failing queue never breaks the tool", async () => {
    mockUpstreams();
    const queue = fakeQueue();
    await withClient({ LANGFUSE_ENABLED: "0", TELEMETRY_QUEUE: queue as never }, async (client) => {
      expect((await client.callTool(call)).isError).not.toBe(true);
    });
    await withClient({ LANGFUSE_ENABLED: "1", LANGFUSE_SAMPLE_RATE: "0", TELEMETRY_QUEUE: queue as never }, async (client) => {
      expect((await client.callTool(call)).isError).not.toBe(true);
    });
    expect(queue.send).not.toHaveBeenCalled();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = { send: vi.fn(async () => { throw new Error("queue down"); }) };
    await withClient({ LANGFUSE_ENABLED: "1", TELEMETRY_QUEUE: failing as never }, async (client) => {
      const result = await client.callTool(call);
      expect(result.isError).not.toBe(true);
      expect((result.content as { type: string }[]).some((p) => p.type === "image")).toBe(true);
    });
    expect(failing.send).toHaveBeenCalledOnce();
    err.mockRestore();
  });
});

describe("generate_image request body", () => {
  it("sends aspect_ratio as generationConfig.imageConfig.aspectRatio (not generationConfig.aspect_ratio)", async () => {
    const calls = mockUpstreams();
    await withClient({ LLM_GATEWAY_URL: undefined }, async (client) => {
      const result = await client.callTool({ name: "generate_image", arguments: { prompt: "banner", aspect_ratio: "16:9" } });
      expect(result.isError).not.toBe(true);
      expect((result.structuredContent as { generatedImage: { aspectRatio: string } }).generatedImage.aspectRatio).toBe("16:9");
    });
    const body = JSON.parse(calls[0].body);
    expect(body.generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9" } });
    expect(body.generationConfig).not.toHaveProperty("aspect_ratio");
  });

  it("omits imageConfig when no aspect_ratio is given (Gemini default)", async () => {
    const calls = mockUpstreams();
    await withClient({ LLM_GATEWAY_URL: undefined }, async (client) => {
      expect((await client.callTool({ name: "generate_image", arguments: { prompt: "banner" } })).isError).not.toBe(true);
    });
    expect(JSON.parse(calls[0].body).generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"] });
  });
});

describe("generate_image dynamic Langfuse sample rate", () => {
  const DIFF = "https://diff.example.test";
  const dyn = { LANGFUSE_ENABLED: "1", LANGFUSE_SAMPLE_RATE: "1", LANGFUSE_DYNAMIC_SAMPLING: "1", CREDITS_API_URL: DIFF, CREDITS_API_TOKEN: "svc-token" };
  const rates = (mcp: number | null) => () => Response.json({ v: 1, env: "staging", rates: mcp === null ? null : { diff: 1, indexing: 1, mcp, search: 1 }, step: null, period_start: "2026-09-01", evaluated_at: "x", ttl_s: 300 });

  it("uses the published mcp rate (0 → no spans, fetched once per isolate TTL)", async () => {
    resetSampleRateCache();
    const calls = mockUpstreams(undefined, rates(0));
    const queue = fakeQueue();
    await withClient({ ...dyn, TELEMETRY_QUEUE: queue as never }, async (client) => {
      expect((await client.callTool(call)).isError).not.toBe(true);
      expect((await client.callTool(call)).isError).not.toBe(true);
    });
    expect(queue.send).not.toHaveBeenCalled();
    const sampling = calls.filter((c) => c.url.endsWith("/api/telemetry/sampling"));
    expect(sampling).toHaveLength(1);
    expect(sampling[0].url).toBe(`${DIFF}/api/telemetry/sampling`);
    expect(sampling[0].headers.get("authorization")).toBe("Bearer svc-token");
  });

  it("rates: null → the env var (1 → traced)", async () => {
    resetSampleRateCache();
    mockUpstreams(undefined, rates(null));
    const queue = fakeQueue();
    await withClient({ ...dyn, TELEMETRY_QUEUE: queue as never }, async (client) => {
      expect((await client.callTool(call)).isError).not.toBe(true);
    });
    expect(queue.send).toHaveBeenCalledOnce();
  });

  it("an unreachable endpoint falls back to the env var and never breaks the tool", async () => {
    resetSampleRateCache();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mockUpstreams(undefined, () => { throw new Error("down"); });
    const queue = fakeQueue();
    await withClient({ ...dyn, TELEMETRY_QUEUE: queue as never }, async (client) => {
      expect((await client.callTool(call)).isError).not.toBe(true);
    });
    expect(queue.send).toHaveBeenCalledOnce();
    err.mockRestore();
  });

  it("does not fetch the rate when telemetry is off or the kill switch is set", async () => {
    resetSampleRateCache();
    const calls = mockUpstreams(undefined, rates(0));
    const queue = fakeQueue();
    await withClient({ ...dyn, LANGFUSE_ENABLED: "0", TELEMETRY_QUEUE: queue as never }, async (client) => {
      expect((await client.callTool(call)).isError).not.toBe(true);
    });
    await withClient({ ...dyn, LANGFUSE_DYNAMIC_SAMPLING: "0", TELEMETRY_QUEUE: queue as never }, async (client) => {
      expect((await client.callTool(call)).isError).not.toBe(true);
    });
    expect(calls.filter((c) => c.url.endsWith("/api/telemetry/sampling"))).toHaveLength(0);
    expect(queue.send).toHaveBeenCalledOnce(); // the kill-switch call, at env rate 1
  });
});
