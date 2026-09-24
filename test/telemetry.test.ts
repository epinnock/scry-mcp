import { describe, expect, it, vi } from "vitest";
import { fnv1a64, spanIdFor, traceIdFor } from "../src/telemetry/ids";
import { encodeTraceRequest, resourceAttrs, toOtlpSpan } from "../src/telemetry/otlp";
import {
  enqueueSpans,
  isSampled,
  MAX_MESSAGE_BYTES,
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
