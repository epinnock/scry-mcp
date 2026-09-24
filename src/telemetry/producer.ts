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
// The rate comes from scry-diff-service's unit-budget job when it is available:
// GET <CREDITS_API_URL>/api/telemetry/sampling (bearer CREDITS_API_TOKEN, the
// same diff-service service credentials the credits ledger uses) returns
// per-service rates; this Worker reads `rates.mcp`. The answer is cached per
// isolate for its `ttl_s` (default 300 s). When the endpoint is unreachable,
// slow (> 1.5 s), non-200, or reports `rates: null` (no current evaluation),
// the static LANGFUSE_SAMPLE_RATE var (0..1, default 1 = every call) is used;
// failures are cached for 60 s so a down endpoint is not hammered.
// LANGFUSE_DYNAMIC_SAMPLING="0" is the kill switch (env var only). Whatever the
// rate, the decision is a pure function of the trace id, so a replay or a
// retry makes the same choice. Gateway analytics still count 100% of calls.

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
  /** "0" / "false" / "off" / "no" → use LANGFUSE_SAMPLE_RATE only (no fetch). */
  LANGFUSE_DYNAMIC_SAMPLING?: string;
  /** The diff-service base URL and service bearer (shared with src/credits.ts). */
  CREDITS_API_URL?: string;
  CREDITS_API_TOKEN?: string;
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
  return clampRate(n);
}

function clampRate(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export const SAMPLING_PATH = "/api/telemetry/sampling";
export const SAMPLING_TIMEOUT_MS = 1_500;
export const SAMPLING_DEFAULT_TTL_S = 300;
export const SAMPLING_FAILURE_TTL_S = 60;

/** Per-isolate cache of the published rate (null = use the env var). */
let samplingCache: { key: string; rate: number | null; expiresAt: number } | null = null;
let samplingInflight: { key: string; promise: Promise<number | null> } | null = null;

/** Test hook: forget the cached published rate. */
export function resetSampleRateCache(): void {
  samplingCache = null;
  samplingInflight = null;
}

export function dynamicSamplingEnabled(env: TelemetryEnv): boolean {
  const v = (env.LANGFUSE_DYNAMIC_SAMPLING ?? "").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(v);
}

async function fetchPublishedRate(base: string, token: string, key: string): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SAMPLING_TIMEOUT_MS);
  let rate: number | null = null;
  let ttlS = SAMPLING_FAILURE_TTL_S;
  try {
    const res = await fetch(`${base}${SAMPLING_PATH}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (res.ok) {
      const body = (await res.json()) as { rates?: Record<string, unknown> | null; ttl_s?: unknown };
      const ttl = Number(body?.ttl_s);
      ttlS = Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, 3_600) : SAMPLING_DEFAULT_TTL_S;
      const mine = body?.rates ? Number(body.rates[TELEMETRY_SERVICE]) : NaN;
      // rates === null (no current evaluation) or no usable "mcp" entry → env var.
      rate = body?.rates && body.rates[TELEMETRY_SERVICE] !== null && Number.isFinite(mine) ? clampRate(mine) : null;
    } else {
      console.error("[scry-mcp] sampling rate fetch failed", res.status);
    }
  } catch (err) {
    console.error("[scry-mcp] sampling rate fetch failed", err instanceof Error && err.name === "AbortError" ? "timeout" : String(err));
    rate = null;
    ttlS = SAMPLING_FAILURE_TTL_S;
  } finally {
    clearTimeout(timer);
  }
  samplingCache = { key, rate, expiresAt: Date.now() + ttlS * 1_000 };
  return rate;
}

/**
 * The sample rate for this call: the diff-service published `rates.mcp` when
 * available (cached per isolate), else LANGFUSE_SAMPLE_RATE. Never throws and
 * never rejects; resolves within ~1.5 s at worst (once per TTL per isolate).
 * No fetch when telemetry is off, the kill switch is set, or the diff-service
 * URL/token are missing.
 */
export async function resolveSampleRate(env: TelemetryEnv): Promise<number> {
  const fallback = sampleRate(env);
  try {
    if (!telemetryEnabled(env) || !dynamicSamplingEnabled(env)) return fallback;
    const base = (env.CREDITS_API_URL ?? "").trim().replace(/\/+$/, "");
    const token = (env.CREDITS_API_TOKEN ?? "").trim();
    if (!/^https?:\/\//i.test(base) || !token) return fallback;
    const key = base;
    let rate: number | null;
    if (samplingCache && samplingCache.key === key && samplingCache.expiresAt > Date.now()) {
      rate = samplingCache.rate;
    } else {
      if (!samplingInflight || samplingInflight.key !== key) {
        const promise = fetchPublishedRate(base, token, key).finally(() => {
          if (samplingInflight?.promise === promise) samplingInflight = null;
        });
        samplingInflight = { key, promise };
      }
      rate = await samplingInflight.promise;
    }
    return rate ?? fallback;
  } catch {
    return fallback;
  }
}

/** Deterministic: the first 32 bits of the trace id as a fraction, compared with the rate. */
export function isSampled(runId: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return parseInt(traceIdFor(runId).slice(0, 8), 16) / 0x1_0000_0000 < rate;
}

/**
 * True when a full trace should be built and enqueued for this call. `rate`
 * is the resolved rate (resolveSampleRate); omitted → the env var.
 */
export function shouldTrace(env: TelemetryEnv, runId: string, rate: number = sampleRate(env)): boolean {
  return telemetryEnabled(env) && isSampled(runId, rate);
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
  input: { runId: string; day: string; spans: SpanRecord[]; rate?: number },
): Promise<number> {
  if (!input.spans.length || !shouldTrace(env, input.runId, input.rate ?? sampleRate(env))) return 0;
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
