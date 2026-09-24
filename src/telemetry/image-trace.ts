// OpenInference spans for one `generate_image` tool call (feature llm-telemetry,
// PR 7; plan "Span schema": `llm.gemini_image` — prompt text, reference images as
// refs, output image as its `generated/…` R2 key).
//
//   mcp.generate_image     CHAIN  root, one per tool call (trace id = the call's UUID)
//   └─ llm.gemini_image    LLM    the Gemini generateContent request
//
// Images never leave as bytes. Reference images are supplied inline by the
// caller and are not stored anywhere, so they appear as an omitted marker with
// their MIME type and size; the generated image appears as its R2 reference
// (`scry-r2://<bucket>/generated/<uid>/…`) when the upload succeeded. Any stray
// data URL in the prompt is replaced. No email or display name is recorded —
// user.id is the Firebase uid.

import { spanIdFor, traceIdFor } from "./ids";
import type { AttrValue, SpanRecord } from "./otlp";

/** Longest text kept on a span (characters). */
export const MAX_TEXT_CHARS = 16_000;
export const IMAGE_OMITTED = "scry-image:omitted";

const DATA_URL_RE = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*;base64,[a-z0-9+/=_-]*/gi;
/** A long unbroken base64 run (a raw image pasted without the data: prefix). */
const RAW_BASE64_RE = /[A-Za-z0-9+/]{512,}={0,2}/g;

/** Replace inline base64 (data URLs and long raw runs) in `text`. */
export function scrubInlineData(text: string): string {
  return text.replace(DATA_URL_RE, "[inline data omitted]").replace(RAW_BASE64_RE, "[inline data omitted]");
}

export function capText(text: string, max = MAX_TEXT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

function traceText(text: string): string {
  return capText(scrubInlineData(text));
}

function json(value: unknown): string {
  return scrubInlineData(JSON.stringify(value));
}

/** `scry-r2://<bucket>/<key>` for an object the search API stored. */
export function r2Ref(env: { SCRY_ENV?: string; SCREENSHOT_BUCKET_NAME?: string }, key: string | null | undefined): string | null {
  if (!key) return null;
  const bucket = env.SCREENSHOT_BUCKET_NAME
    || (env.SCRY_ENV === "staging" ? "scry-component-snapshot-bucket-staging" : "scry-component-snapshot-bucket");
  return `scry-r2://${bucket}/${key}`;
}

/** Marker for one caller-supplied reference image: type and size only. */
export function referenceImageMarker(image: string): string {
  const mime = image.match(/^data:(image\/[\w.+-]+);base64,/)?.[1] ?? "image/png";
  const raw = image.replace(/^data:[^,]*,/, "");
  const bytes = Math.floor((raw.length * 3) / 4);
  return `${IMAGE_OMITTED};source=caller;mime=${mime};bytes=${bytes}`;
}

/** Gemini `usageMetadata`. */
export interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

export interface ImageCallTrace {
  runId: string;
  userId: string | null;
  envName: string;
  commit?: string | null;
  /** Tool call start/end (the root span). */
  startMs: number;
  endMs: number;
  /** Gemini request start/end (the LLM span); absent when the request was never sent. */
  call?: {
    startMs: number;
    endMs: number;
    model: string;
    viaGateway: boolean;
    /** ok | error (HTTP / network) | safety (blocked) | no_image */
    status: "ok" | "error" | "safety" | "no_image";
    httpStatus?: number | null;
    error?: string | null;
    finishReason?: string | null;
    usage?: GeminiUsage | null;
    /** Text parts the model returned alongside the image. */
    outputText?: string | null;
    outputMimeType?: string | null;
  };
  prompt: string;
  quality: string;
  aspectRatio: string | null;
  referenceImages: readonly string[];
  /** R2 ref of the stored output image, or null when it was not stored. */
  outputRef: string | null;
  presigned: boolean;
  /** The tool outcome: ok, or the tool error code returned to the client. */
  outcome: string;
}

export function rootSpanId(runId: string): string {
  return spanIdFor(runId, "root");
}

export function llmSpanId(runId: string): string {
  return spanIdFor(runId, "call|gemini_image|1");
}

/** The two spans for one generate_image call (just the root when no request was sent). */
export function buildImageSpans(t: ImageCallTrace): SpanRecord[] {
  const traceId = traceIdFor(t.runId);
  const rootId = rootSpanId(t.runId);
  const tags = ["mcp", "generate_image", t.quality];
  const metadata: Record<string, string | number | boolean | null> = {
    request_id: t.runId,
    tool: "generate_image",
    quality: t.quality,
    aspect_ratio: t.aspectRatio,
    reference_image_count: t.referenceImages.length,
    model: t.call?.model ?? null,
    via_gateway: t.call?.viaGateway ?? null,
    stored: Boolean(t.outputRef),
    presigned: t.presigned,
    outcome: t.outcome,
    env: t.envName,
    commit: t.commit ?? null,
  };
  const userMessage = [
    ...t.referenceImages.map((img) => ({ type: "image_url", image_url: { url: referenceImageMarker(img) } })),
    { type: "text", text: traceText(t.prompt) },
  ];
  const rootAttrs: Record<string, AttrValue> = {
    "openinference.span.kind": "CHAIN",
    metadata: json(metadata),
    "tag.tags": tags,
    "input.value": json({ prompt: traceText(t.prompt), quality: t.quality, aspect_ratio: t.aspectRatio, reference_images: t.referenceImages.length }),
    "input.mime_type": "application/json",
    "output.value": json({ outcome: t.outcome, image: t.outputRef, presigned: t.presigned }),
    "output.mime_type": "application/json",
    "langfuse.trace.name": "mcp.generate_image",
    "langfuse.trace.tags": tags,
  };
  if (t.userId) {
    rootAttrs["user.id"] = t.userId;
    rootAttrs["langfuse.user.id"] = t.userId;
  }
  for (const [k, v] of Object.entries(metadata)) {
    if (v !== null && v !== undefined) rootAttrs[`langfuse.trace.metadata.${k}`] = String(v);
  }
  if (t.commit) rootAttrs["langfuse.release"] = t.commit;
  const rootOk = t.outcome === "ok";
  const spans: SpanRecord[] = [{
    traceId,
    spanId: rootId,
    parentSpanId: null,
    name: "mcp.generate_image",
    startMs: t.startMs,
    endMs: Math.max(t.startMs, t.endMs),
    attrs: rootAttrs,
    status: rootOk ? "ok" : "error",
    ...(rootOk ? {} : { statusMessage: t.outcome }),
  }];

  const c = t.call;
  if (!c) return spans;
  const attrs: Record<string, AttrValue> = {
    "openinference.span.kind": "LLM",
    "llm.system": "vertexai",
    "llm.provider": "google",
    "llm.model_name": c.model,
    "llm.invocation_parameters": json({
      responseModalities: ["TEXT", "IMAGE"],
      ...(t.aspectRatio ? { aspect_ratio: t.aspectRatio } : {}),
    }),
    metadata: json({
      request_id: t.runId,
      feat: "generate_image",
      call_status: c.status,
      http_status: c.httpStatus ?? null,
      finish_reason: c.finishReason ?? null,
      via_gateway: c.viaGateway,
      error: c.error ?? null,
    }),
    "input.value": json([{ role: "user", content: userMessage }]),
    "input.mime_type": "application/json",
    "llm.input_messages.0.message.role": "user",
  };
  userMessage.forEach((p, j) => {
    const base = `llm.input_messages.0.message.contents.${j}.message_content`;
    attrs[`${base}.type`] = p.type === "text" ? "text" : "image";
    if (p.type === "text") attrs[`${base}.text`] = (p as { text: string }).text;
    else attrs[`${base}.image.image.url`] = (p as { image_url: { url: string } }).image_url.url;
  });
  const u = c.usage ?? null;
  if (u) {
    if (typeof u.promptTokenCount === "number") attrs["llm.token_count.prompt"] = u.promptTokenCount;
    if (typeof u.candidatesTokenCount === "number" || typeof u.thoughtsTokenCount === "number") {
      attrs["llm.token_count.completion"] = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
    }
    if (typeof u.thoughtsTokenCount === "number") attrs["llm.token_count.completion_details.reasoning"] = u.thoughtsTokenCount;
    if (typeof u.cachedContentTokenCount === "number") attrs["llm.token_count.prompt_details.cache_read"] = u.cachedContentTokenCount;
    if (typeof u.totalTokenCount === "number") attrs["llm.token_count.total"] = u.totalTokenCount;
  }
  if (c.status === "ok") {
    const outParts: { type: string; text?: string; url?: string }[] = [];
    if (c.outputText) outParts.push({ type: "text", text: traceText(c.outputText) });
    outParts.push({ type: "image", url: t.outputRef ?? `${IMAGE_OMITTED};reason=not_stored;mime=${c.outputMimeType ?? "image/png"}` });
    attrs["llm.output_messages.0.message.role"] = "model";
    outParts.forEach((p, j) => {
      const base = `llm.output_messages.0.message.contents.${j}.message_content`;
      attrs[`${base}.type`] = p.type;
      if (p.type === "text") attrs[`${base}.text`] = p.text!;
      else attrs[`${base}.image.image.url`] = p.url!;
    });
    attrs["output.value"] = json({ image: outParts.find((p) => p.type === "image")?.url, text: c.outputText ? traceText(c.outputText) : null, mime_type: c.outputMimeType ?? null });
    attrs["output.mime_type"] = "application/json";
  }
  const ok = c.status === "ok";
  spans.push({
    traceId,
    spanId: llmSpanId(t.runId),
    parentSpanId: rootId,
    name: "llm.gemini_image",
    startMs: c.startMs,
    endMs: Math.max(c.startMs, c.endMs),
    attrs,
    status: ok ? "ok" : "error",
    ...(ok ? {} : { statusMessage: capText(scrubInlineData(c.error ?? c.status), 300) }),
  });
  return spans;
}
