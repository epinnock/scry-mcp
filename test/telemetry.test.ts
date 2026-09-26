import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fnv1a64, spanIdFor, traceIdFor, ulidToHex } from "../src/telemetry/ids";
import { encodeTraceRequest, resourceAttrs, toOtlpSpan } from "../src/telemetry/otlp";
import {
  enqueueSpans,
  isSampled,
  MAX_MESSAGE_BYTES,
  resetSampleRateCache,
  resolveSampleRate,
  sampleRate,
  shouldTrace,
  spansMessage,
  telemetryEnabled,
  utcDay,
} from "../src/telemetry/producer";
import {
  buildImageSpans,
  IMAGE_OMITTED,
  llmSpanId,
  r2Ref,
  referenceImageMarker,
  rootSpanId,
  scrubInlineData,
  type ImageCallTrace,
} from "../src/telemetry/image-trace";

const RUN = "3f2a9c1e-7b04-4d2a-9c91-e04b2c91e04b";
const PNG = `data:image/png;base64,${"iVBORw0KGgo".repeat(200)}`;

function trace(overrides: Partial<ImageCallTrace> = {}): ImageCallTrace {
  return {
    runId: RUN,
    userId: "uid-1",
    envName: "staging",
    commit: "abc123",
    startMs: 1_000,
    endMs: 9_000,
    call: {
      startMs: 1_100,
      endMs: 8_000,
      model: "gemini-3.1-flash-image-preview",
      viaGateway: true,
      status: "ok",
      httpStatus: 200,
      finishReason: "STOP",
      usage: { promptTokenCount: 12, candidatesTokenCount: 1290, thoughtsTokenCount: 10, totalTokenCount: 1312 },
      outputText: "Here is your button",
      outputMimeType: "image/png",
    },
    prompt: `A blue button ${PNG}`,
    quality: "fast",
    aspectRatio: "1:1",
    referenceImages: [PNG, "iVBORw0KGgo".repeat(100)],
    outputRef: "scry-r2://bucket/generated/uid-1/1-abc.png",
    presigned: true,
    outcome: "ok",
    ...overrides,
  };
}

describe("telemetry ids", () => {
  it("uses the UUID as the trace id and derives stable, distinct span ids", () => {
    expect(traceIdFor(RUN)).toBe(RUN.replace(/-/g, ""));
    expect(traceIdFor("not-a-uuid")).toMatch(/^[0-9a-f]{32}$/);
    // A ULID request id (observability-request-id) maps to its own 128 bits.
    expect(traceIdFor("01M3EQG44Y0J8F2K6ZP9RX1T7C")).toBe(ulidToHex("01M3EQG44Y0J8F2K6ZP9RX1T7C"));
    expect(ulidToHex("00000000000000000000000001")).toBe("00000000000000000000000000000001");
    expect(ulidToHex("7ZZZZZZZZZZZZZZZZZZZZZZZZZ")).toBe("f".repeat(32));
    expect(ulidToHex("not-a-ulid")).toBeNull();
    expect(rootSpanId(RUN)).toBe(spanIdFor(RUN, "root"));
    expect(llmSpanId(RUN)).not.toBe(rootSpanId(RUN));
    expect(llmSpanId(RUN)).toMatch(/^[0-9a-f]{16}$/);
    expect(fnv1a64("")).toBe("cbf29ce484222325");
  });
});

describe("generate_image spans", () => {
  it("builds a CHAIN root and an LLM child with OpenInference attributes", () => {
    const [root, llm] = buildImageSpans(trace());
    expect(root.name).toBe("mcp.generate_image");
    expect(root.parentSpanId).toBeNull();
    expect(root.attrs["openinference.span.kind"]).toBe("CHAIN");
    expect(root.attrs["user.id"]).toBe("uid-1");
    expect(root.attrs["langfuse.trace.metadata.request_id"]).toBe(RUN);
    expect(root.attrs["langfuse.trace.metadata.via_gateway"]).toBe("true");
    expect(root.status).toBe("ok");
    expect(llm.name).toBe("llm.gemini_image");
    expect(llm.parentSpanId).toBe(root.spanId);
    expect(llm.traceId).toBe(root.traceId);
    expect(llm.attrs).toMatchObject({
      "openinference.span.kind": "LLM",
      "llm.provider": "google",
      "llm.model_name": "gemini-3.1-flash-image-preview",
      "llm.token_count.prompt": 12,
      "llm.token_count.completion": 1300,
      "llm.token_count.completion_details.reasoning": 10,
      "llm.token_count.total": 1312,
      "llm.input_messages.0.message.contents.0.message_content.type": "image",
      "llm.input_messages.0.message.contents.2.message_content.type": "text",
      "llm.output_messages.0.message.contents.1.message_content.image.image.url": "scry-r2://bucket/generated/uid-1/1-abc.png",
    });
    expect(llm.startMs).toBe(1_100);
    expect(llm.endMs).toBe(8_000);
  });

  it("never carries image bytes: no data: URL or long base64 run in any attribute", () => {
    const req = encodeTraceRequest(buildImageSpans(trace()), resourceAttrs("mcp", "staging"));
    const text = JSON.stringify(req);
    expect(text).not.toContain("data:image");
    expect(text).not.toMatch(/[A-Za-z0-9+/]{512,}/);
    expect(text).toContain(`${IMAGE_OMITTED};source=caller;mime=image/png`);
    expect(text).toContain("A blue button [inline data omitted]");
  });

  it("marks an unstored output image as omitted, not as bytes", () => {
    const [, llm] = buildImageSpans(trace({ outputRef: null, presigned: false }));
    expect(llm.attrs["llm.output_messages.0.message.contents.1.message_content.image.image.url"])
      .toBe(`${IMAGE_OMITTED};reason=not_stored;mime=image/png`);
  });

  it("records failed calls as error spans without output, and just the root when no request was sent", () => {
    const [root, llm] = buildImageSpans(trace({
      outcome: "GEMINI_API_ERROR",
      outputRef: null,
      call: { startMs: 1, endMs: 2, model: "m", viaGateway: false, status: "error", httpStatus: 503, error: "HTTP 503" },
    }));
    expect(root.status).toBe("error");
    expect(root.statusMessage).toBe("GEMINI_API_ERROR");
    expect(llm.status).toBe("error");
    expect(llm.statusMessage).toBe("HTTP 503");
    expect(Object.keys(llm.attrs).some((k) => k.startsWith("llm.output_messages"))).toBe(false);
    expect(buildImageSpans(trace({ call: undefined, outcome: "SERVER_MISCONFIGURED" }))).toHaveLength(1);
    const anon = buildImageSpans(trace({ userId: null }))[0];
    expect(anon.attrs["user.id"]).toBeUndefined();
  });

  it("references and markers", () => {
    expect(r2Ref({ SCRY_ENV: "staging" }, "generated/a.png")).toBe("scry-r2://scry-component-snapshot-bucket-staging/generated/a.png");
    expect(r2Ref({ SCRY_ENV: "production" }, "k")).toBe("scry-r2://scry-component-snapshot-bucket/k");
    expect(r2Ref({ SCREENSHOT_BUCKET_NAME: "b" }, "k")).toBe("scry-r2://b/k");
    expect(r2Ref({}, null)).toBeNull();
    expect(referenceImageMarker("data:image/jpeg;base64,AAAA")).toBe(`${IMAGE_OMITTED};source=caller;mime=image/jpeg;bytes=3`);
    expect(scrubInlineData("x data:image/png;base64,AAAA y")).toBe("x [inline data omitted] y");
  });

  it("encodes OTLP JSON the diff-service consumer accepts", () => {
    const s = toOtlpSpan(buildImageSpans(trace())[1]);
    expect(s.startTimeUnixNano).toBe("1100000000");
    expect(s.status).toEqual({ code: 1 });
    expect(s.attributes.find((a) => a.key === "llm.token_count.total")?.value).toEqual({ intValue: "1312" });
    expect(s.attributes.find((a) => a.key === "llm.model_name")?.value).toEqual({ stringValue: "gemini-3.1-flash-image-preview" });
  });
});

describe("producer", () => {
  const queue = () => ({ send: vi.fn(async () => {}), sendBatch: vi.fn() });

  it("is enabled only with the flag and a queue binding", () => {
    expect(telemetryEnabled({ LANGFUSE_ENABLED: "1" })).toBe(false);
    expect(telemetryEnabled({ TELEMETRY_QUEUE: queue() as never })).toBe(false);
    expect(telemetryEnabled({ LANGFUSE_ENABLED: "true", TELEMETRY_QUEUE: queue() as never })).toBe(true);
  });

  it("parses and clamps the sample rate; sampling is deterministic per trace id", () => {
    expect(sampleRate({})).toBe(1);
    expect(sampleRate({ LANGFUSE_SAMPLE_RATE: "abc" })).toBe(1);
    expect(sampleRate({ LANGFUSE_SAMPLE_RATE: "0.25" })).toBe(0.25);
    expect(sampleRate({ LANGFUSE_SAMPLE_RATE: "7" })).toBe(1);
    expect(sampleRate({ LANGFUSE_SAMPLE_RATE: "-1" })).toBe(0);
    expect(isSampled(RUN, 1)).toBe(true);
    expect(isSampled(RUN, 0)).toBe(false);
    // 0x3f2a9c1e / 2^32 ≈ 0.247
    expect(isSampled(RUN, 0.25)).toBe(true);
    expect(isSampled(RUN, 0.24)).toBe(false);
    const ids = Array.from({ length: 2000 }, () => crypto.randomUUID());
    const share = ids.filter((id) => isSampled(id, 0.25)).length / ids.length;
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.3);
    expect(shouldTrace({ LANGFUSE_ENABLED: "1", LANGFUSE_SAMPLE_RATE: "0", TELEMETRY_QUEUE: queue() as never }, RUN)).toBe(false);
  });

  it("sends one SpansMessage in the diff-service shape", async () => {
    const q = queue();
    const env = { LANGFUSE_ENABLED: "1", TELEMETRY_QUEUE: q as never, SCRY_ENV: "staging", SCRY_COMMIT: "abc" };
    const spans = buildImageSpans(trace());
    expect(await enqueueSpans(env, { runId: RUN, day: utcDay(0), spans })).toBe(2);
    expect(q.send).toHaveBeenCalledOnce();
    const [body, opts] = q.send.mock.calls[0] as unknown as [ReturnType<typeof spansMessage>, unknown];
    expect(opts).toEqual({ contentType: "json" });
    expect(body).toMatchObject({ v: 1, kind: "spans", service: "mcp", env: "staging", run_id: RUN, day: "1970-01-01", span_count: 2 });
    const resource = body.otlp.resourceSpans[0].resource.attributes;
    expect(resource).toContainEqual({ key: "service.name", value: { stringValue: "scry-mcp-service" } });
    expect(resource).toContainEqual({ key: "openinference.project.name", value: { stringValue: "scry-mcp-staging" } });
    expect(body.otlp.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
  });

  it("never throws, and sends nothing when off, unsampled, empty or oversized", async () => {
    const q = queue();
    const spans = buildImageSpans(trace());
    expect(await enqueueSpans({ TELEMETRY_QUEUE: q as never }, { runId: RUN, day: "d", spans })).toBe(0);
    expect(await enqueueSpans({ LANGFUSE_ENABLED: "1", LANGFUSE_SAMPLE_RATE: "0", TELEMETRY_QUEUE: q as never }, { runId: RUN, day: "d", spans })).toBe(0);
    expect(await enqueueSpans({ LANGFUSE_ENABLED: "1", TELEMETRY_QUEUE: q as never }, { runId: RUN, day: "d", spans: [] })).toBe(0);
    const big = spans.map((s) => ({ ...s, attrs: { ...s.attrs, pad: "x".repeat(MAX_MESSAGE_BYTES) } }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await enqueueSpans({ LANGFUSE_ENABLED: "1", TELEMETRY_QUEUE: q as never }, { runId: RUN, day: "d", spans: big })).toBe(0);
    expect(q.send).not.toHaveBeenCalled();
    const failing = { send: vi.fn(async () => { throw new Error("queue down"); }) };
    expect(await enqueueSpans({ LANGFUSE_ENABLED: "1", TELEMETRY_QUEUE: failing as never }, { runId: RUN, day: "d", spans })).toBe(0);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("dynamic sample rate (diff-service /api/telemetry/sampling)", () => {
  const BASE = "https://diff.example.test";
  const on = {
    LANGFUSE_ENABLED: "1",
    LANGFUSE_SAMPLE_RATE: "0.9",
    TELEMETRY_QUEUE: { send: vi.fn() } as never,
    CREDITS_API_URL: `${BASE}/`,
    CREDITS_API_TOKEN: "svc-token",
  };
  const published = (rates: Record<string, number> | null, extra: Record<string, unknown> = {}) =>
    Response.json({ v: 1, env: "staging", rates, step: rates ? 1 : null, period_start: "2026-09-01", evaluated_at: "2026-09-24T00:00:00Z", ttl_s: 300, ...extra });

  let now = 1_000_000;
  beforeEach(() => {
    resetSampleRateCache();
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetSampleRateCache();
  });

  it("uses rates.mcp with the service bearer, and it drives the sampling decision", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(published({ diff: 1, indexing: 1, mcp: 0.2, search: 1 }));
    expect(await resolveSampleRate(on)).toBe(0.2);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(`${BASE}/api/telemetry/sampling`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer svc-token");
    // RUN's trace id maps to ~0.247: sampled out at 0.2, in at the env 0.9.
    expect(shouldTrace(on, RUN, 0.2)).toBe(false);
    expect(shouldTrace(on, RUN)).toBe(true);
    const queue = { send: vi.fn(async () => {}) };
    const spans = buildImageSpans(trace());
    expect(await enqueueSpans({ ...on, TELEMETRY_QUEUE: queue as never }, { runId: RUN, day: "d", spans, rate: 0.2 })).toBe(0);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("clamps the published rate to [0, 1]", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(published({ mcp: 7 }));
    expect(await resolveSampleRate(on)).toBe(1);
    resetSampleRateCache();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(published({ mcp: -1 }));
    expect(await resolveSampleRate(on)).toBe(0);
  });

  it("rates: null (no current evaluation) or no mcp entry → the env var, cached for ttl_s", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(published(null));
    expect(await resolveSampleRate(on)).toBe(0.9);
    expect(await resolveSampleRate(on)).toBe(0.9);
    expect(fetchSpy).toHaveBeenCalledOnce();
    resetSampleRateCache();
    fetchSpy.mockResolvedValue(published({ diff: 0.5 }));
    expect(await resolveSampleRate(on)).toBe(0.9);
  });

  it("caches for ttl_s, then refetches", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(published({ mcp: 0.5 }, { ttl_s: 120 }))
      .mockResolvedValueOnce(published({ mcp: 0.25 }));
    expect(await resolveSampleRate(on)).toBe(0.5);
    now += 119_000;
    expect(await resolveSampleRate(on)).toBe(0.5);
    expect(fetchSpy).toHaveBeenCalledOnce();
    now += 2_000;
    expect(await resolveSampleRate(on)).toBe(0.25);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("defaults the TTL to 300 s when ttl_s is missing, and shares one in-flight fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(published({ mcp: 0.5 }, { ttl_s: undefined }));
    const [a, b] = await Promise.all([resolveSampleRate(on), resolveSampleRate(on)]);
    expect([a, b]).toEqual([0.5, 0.5]);
    expect(fetchSpy).toHaveBeenCalledOnce();
    now += 299_000;
    await resolveSampleRate(on);
    expect(fetchSpy).toHaveBeenCalledOnce();
    now += 2_000;
    await resolveSampleRate(on);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("falls back to the env var on network error / non-200 and caches the failure ~60 s; never throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("not json", { status: 200 }))
      .mockResolvedValue(published({ mcp: 0.1 }));
    expect(await resolveSampleRate(on)).toBe(0.9);
    now += 59_000;
    expect(await resolveSampleRate(on)).toBe(0.9);
    expect(fetchSpy).toHaveBeenCalledOnce();
    now += 2_000;
    expect(await resolveSampleRate(on)).toBe(0.9); // 401
    now += 61_000;
    expect(await resolveSampleRate(on)).toBe(0.9); // unparseable 200
    now += 61_000;
    expect(await resolveSampleRate(on)).toBe(0.1);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(err).toHaveBeenCalled();
  });

  it("times out after 1.5 s and falls back", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const t0 = performance.now();
    expect(await resolveSampleRate(on)).toBe(0.9);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(3_000);
  });

  it("kill switch, telemetry off, or missing credentials → env var with no fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const v of ["0", "false", "off"]) {
      expect(await resolveSampleRate({ ...on, LANGFUSE_DYNAMIC_SAMPLING: v })).toBe(0.9);
    }
    expect(await resolveSampleRate({ ...on, LANGFUSE_ENABLED: "0" })).toBe(0.9);
    expect(await resolveSampleRate({ ...on, TELEMETRY_QUEUE: undefined })).toBe(0.9);
    expect(await resolveSampleRate({ ...on, CREDITS_API_TOKEN: "" })).toBe(0.9);
    expect(await resolveSampleRate({ ...on, CREDITS_API_URL: undefined })).toBe(0.9);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
