// The producer half of store-and-forward for scry-mcp (feature llm-telemetry,
// PR 7; plan DECISION 2026-09-24).
//
// scry-mcp is a Cloudflare Worker, so it uses the same durable path as
// scry-diff-service: it binds a producer to the diff-service telemetry queue
// (scry-telemetry-<env>) and sends the same `SpansMessage` shape. The consumer
// there (scry-diff-service src/telemetry/delivery.ts) archives each message to
// R2 (telemetry/<env>/<day>/<run_id>.json), posts it to Langfuse with retries,
// backoff, a DLQ and a per-run delivery ledger, and counts it per `service`.
// Nothing here calls Langfuse and nothing here throws: a telemetry failure is
// logged, never surfaced to the tool call.
//
// Sampling (DECISION 2026-09-23, adaptive sampling): MCP traces ARE sampled.
// LANGFUSE_SAMPLE_RATE (0..1, default 1 = every call) is the knob the
// unit-budget job steps down; the decision is a pure function of the trace id,
// so a replay or a retry makes the same choice. Gateway analytics still count
// 100% of calls whatever the rate.

import { encodeTraceRequest, resourceAttrs, type OtlpTraceRequest, type SpanRecord } from "./otlp";
import { traceIdFor } from "./ids";

export const TELEMETRY_SERVICE = "mcp";

/** Cloudflare Queues accept 128 KB per message; keep headroom for the envelope. */
export const MAX_MESSAGE_BYTES = 110_000;

/** Must match scry-diff-service src/telemetry/producer.ts SpansMessage. */
export interface SpansMessage {
  v: 1;
  kind: "spans";
  service: string;
  env: string;
  run_id: string;
  /** UTC day of the call: the archive folder and the counter row. */
  day: string;
  span_count: number;
  otlp: OtlpTraceRequest;
}

export type TelemetryEnv = {
  LANGFUSE_ENABLED?: string;
  LANGFUSE_SAMPLE_RATE?: string;
  TELEMETRY_QUEUE?: Queue<SpansMessage>;
  SCRY_ENV?: string;
  SCRY_COMMIT?: string;
};

export function telemetryEnabled(env: TelemetryEnv): boolean {
  const on = ["1", "true", "on", "yes"].includes((env.LANGFUSE_ENABLED ?? "").trim().toLowerCase());
  return on && Boolean(env.TELEMETRY_QUEUE);
}

/** The configured sample rate, clamped to [0, 1]; unset or unparseable → 1. */
export function sampleRate(env: TelemetryEnv): number {
  const raw = (env.LANGFUSE_SAMPLE_RATE ?? "").trim();
  if (!raw) return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

/** Deterministic: the first 32 bits of the trace id as a fraction, compared with the rate. */
export function isSampled(runId: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return parseInt(traceIdFor(runId).slice(0, 8), 16) / 0x1_0000_0000 < rate;
}

/** True when a full trace should be built and enqueued for this call. */
export function shouldTrace(env: TelemetryEnv, runId: string): boolean {
  return telemetryEnabled(env) && isSampled(runId, sampleRate(env));
}

export function envName(env: TelemetryEnv): string {
  return env.SCRY_ENV || "dev";
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Build the queue message for one call's spans. */
export function spansMessage(env: TelemetryEnv, runId: string, day: string, spans: SpanRecord[]): SpansMessage {
  const name = envName(env);
  return {
    v: 1,
    kind: "spans",
    service: TELEMETRY_SERVICE,
    env: name,
    run_id: runId,
    day,
    span_count: spans.length,
    otlp: encodeTraceRequest(spans, resourceAttrs(TELEMETRY_SERVICE, name, env.SCRY_COMMIT ?? null)),
  };
}

/**
 * Put one call's spans on the queue. Returns the number of spans enqueued (0
 * when telemetry is off, the call was not sampled, or the send failed). Never throws.
 */
export async function enqueueSpans(
  env: TelemetryEnv,
  input: { runId: string; day: string; spans: SpanRecord[] },
): Promise<number> {
  if (!input.spans.length || !shouldTrace(env, input.runId)) return 0;
  try {
    const body = spansMessage(env, input.runId, input.day, input.spans);
    const bytes = new TextEncoder().encode(JSON.stringify(body)).length;
    if (bytes > MAX_MESSAGE_BYTES) {
      console.error("[scry-mcp] telemetry message too large, dropped", input.runId, bytes);
      return 0;
    }
    await env.TELEMETRY_QUEUE!.send(body, { contentType: "json" });
    return input.spans.length;
  } catch (err) {
    console.error("[scry-mcp] telemetry enqueue failed", input.runId, String(err));
    return 0;
  }
}
