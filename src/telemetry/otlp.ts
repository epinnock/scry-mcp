// OTLP/HTTP JSON encoding (feature llm-telemetry, PR 7). The same wire shape as
// scry-diff-service src/telemetry/otlp.ts, whose queue consumer delivers these
// requests to Langfuse unchanged.

export type AttrValue = string | number | boolean | string[];

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startMs: number;
  endMs: number;
  attrs: Record<string, AttrValue>;
  status: "ok" | "error" | "unset";
  statusMessage?: string;
}

export interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
  arrayValue?: { values: OtlpAnyValue[] };
}

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status: { code: number; message?: string };
}

export interface OtlpTraceRequest {
  resourceSpans: {
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: { scope: { name: string; version: string }; spans: OtlpSpan[] }[];
  }[];
}

export const SCOPE = { name: "scry-span-recorder", version: "1.0.0" };

export function anyValue(v: AttrValue): OtlpAnyValue {
  if (Array.isArray(v)) return { arrayValue: { values: v.map((x) => anyValue(x)) } };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
}

export function keyValues(attrs: Record<string, AttrValue>): OtlpKeyValue[] {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, v]) => ({ key, value: anyValue(v) }));
}

function nanos(msValue: number): string {
  return (BigInt(Math.round(msValue)) * 1_000_000n).toString();
}

const STATUS_CODE = { unset: 0, ok: 1, error: 2 } as const;

export function toOtlpSpan(s: SpanRecord): OtlpSpan {
  return {
    traceId: s.traceId,
    spanId: s.spanId,
    ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
    name: s.name,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: nanos(s.startMs),
    endTimeUnixNano: nanos(Math.max(s.startMs, s.endMs)),
    attributes: keyValues(s.attrs),
    status: { code: STATUS_CODE[s.status], ...(s.statusMessage ? { message: s.statusMessage } : {}) },
  };
}

/** Resource attributes for every span this Worker sends. */
export function resourceAttrs(service: string, envName: string, commit?: string | null): Record<string, AttrValue> {
  return {
    "service.name": `scry-${service}-service`,
    "deployment.environment": envName,
    "deployment.environment.name": envName,
    "openinference.project.name": `scry-${service}-${envName}`,
    ...(commit ? { "service.version": commit } : {}),
  };
}

export function encodeTraceRequest(spans: SpanRecord[], resource: Record<string, AttrValue>): OtlpTraceRequest {
  return {
    resourceSpans: [
      {
        resource: { attributes: keyValues(resource) },
        scopeSpans: [{ scope: SCOPE, spans: spans.map(toOtlpSpan) }],
      },
    ],
  };
}
