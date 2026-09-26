/**
 * One request id per MCP tool call (feature observability-request-id).
 *
 * Every tool handler is wrapped by `instrumentToolRegistration`, which:
 * - accepts a well-formed inbound `x-scry-request-id` when the transport carries
 *   one, and otherwise mints a ULID;
 * - runs the handler inside an AsyncLocalStorage context, so any outbound call
 *   to a Scry service (search, dashboard, credits ledger) can forward the id with
 *   `requestIdHeaders()` without threading it through every signature;
 * - adds `"request_id"` to every JSON tool-error body, so no tool has to remember;
 * - writes ONE request line at the end of the call, built from a fixed allow-list
 *   (`msg, request_id, route, outcome, ms, code?, project_id?`), never a spread,
 *   and never the uid, the query text, a key or a body;
 * - reports a thrown handler error to Sentry with the tags `request_id` and
 *   `tool`, and turns it into a structured tool error instead of a raw message.
 *
 * Observability never breaks a tool call: logging and Sentry failures are
 * swallowed.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import * as Sentry from "@sentry/cloudflare";
import { REQUEST_ID_HEADER, acceptOrMint } from "./request-id";

interface ToolCallContext {
  requestId: string;
}

const context = new AsyncLocalStorage<ToolCallContext>();

/** The request id of the tool call this code runs in, or undefined outside one. */
export function currentRequestId(): string | undefined {
  return context.getStore()?.requestId;
}

/** `{ "x-scry-request-id": id }` inside a tool call; `{}` outside one. For Scry hops only. */
export function requestIdHeaders(): Record<string, string> {
  const id = currentRequestId();
  return id ? { [REQUEST_ID_HEADER]: id } : {};
}

/** Run `fn` as if inside a tool call with this id (tests, and code outside the wrapper). */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return context.run({ requestId }, fn);
}

export type RequestLine = {
  msg: "request";
  request_id: string;
  route: string;
  outcome: "ok" | "error";
  ms: number;
  code?: string;
  project_id?: string;
};

const MAX_FIELD = 128;
const SAFE_TOKEN = /^[A-Za-z0-9_.:\-]+$/;

function safeToken(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD && SAFE_TOKEN.test(value)
    ? value
    : undefined;
}

/** Build the end-of-call line from the allow-list only. Unknown or unsafe values are dropped. */
export function buildRequestLine(input: {
  requestId: string;
  tool: string;
  outcome: "ok" | "error";
  ms: number;
  code?: unknown;
  projectId?: unknown;
}): RequestLine {
  const line: RequestLine = {
    msg: "request",
    request_id: input.requestId,
    route: safeToken(input.tool) ?? "unknown",
    outcome: input.outcome,
    ms: Math.max(0, Math.round(input.ms)),
  };
  const code = safeToken(input.code);
  if (input.outcome === "error" && code) line.code = code;
  const projectId = safeToken(input.projectId);
  if (projectId) line.project_id = projectId;
  return line;
}

type ContentBlock = { type: string; text?: string; [k: string]: unknown };
type ToolResultLike = { content?: ContentBlock[]; isError?: boolean; [k: string]: unknown };

function parseErrorJson(text: string | undefined): Record<string, unknown> | null {
  if (!text || text[0] !== "{") return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) && "error" in (v as object) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The tool error code (`error` of the first JSON error block), when the result is an error. */
export function toolErrorCode(result: unknown): string | undefined {
  const r = result as ToolResultLike | undefined;
  if (!r?.isError || !Array.isArray(r.content)) return undefined;
  for (const block of r.content) {
    const body = block?.type === "text" ? parseErrorJson(block.text) : null;
    if (body && typeof body.error === "string") return body.error;
  }
  return undefined;
}

/** Add `request_id` to every JSON error body of an error result. Other results pass through untouched. */
export function withRequestIdInErrors<T>(result: T, requestId: string): T {
  const r = result as ToolResultLike | undefined;
  if (!r?.isError || !Array.isArray(r.content)) return result;
  let changed = false;
  const content = r.content.map(block => {
    const body = block?.type === "text" ? parseErrorJson(block.text) : null;
    if (!body) return block;
    changed = true;
    return { ...block, text: JSON.stringify({ ...body, request_id: requestId }) };
  });
  return changed ? ({ ...r, content } as T) : result;
}

/** The inbound header, when the MCP transport exposes HTTP request headers (`extra.requestInfo`). */
export function inboundRequestId(extra: unknown): string | undefined {
  const headers = (extra as { requestInfo?: { headers?: unknown } } | undefined)?.requestInfo?.headers;
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(REQUEST_ID_HEADER) ?? undefined;
  const v = (headers as Record<string, unknown>)[REQUEST_ID_HEADER];
  return typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined;
}

export interface ToolWrapOptions {
  /** Where the request line goes. Default: console.log(JSON.stringify(line)). */
  emit?: (line: RequestLine) => void;
  /** Error reporting for a thrown handler. Default: Sentry with request_id + tool tags. */
  report?: (err: unknown, tags: { request_id: string; tool: string }) => void;
}

function defaultEmit(line: RequestLine): void {
  console.log(JSON.stringify(line));
}

function defaultReport(err: unknown, tags: { request_id: string; tool: string }): void {
  Sentry.withScope(scope => {
    scope.setTag("request_id", tags.request_id);
    scope.setTag("tool", tags.tool);
    Sentry.captureException(err);
  });
}

function thrownResult(err: unknown): ToolResultLike {
  const timeout = err instanceof Error && err.name === "AbortError";
  const code = timeout ? "UPSTREAM_TIMEOUT" : "INTERNAL_ERROR";
  const message = timeout
    ? "An upstream Scry service did not answer in time. Retry once."
    : "The Scry MCP server hit an unexpected error. Retry once; if it persists, report the request_id.";
  return { content: [{ type: "text", text: JSON.stringify({ error: code, message, retryable: true }) }], isError: true };
}

 
type AnyHandler = (...args: any[]) => unknown;

/** Wrap one tool handler; see the module comment for what it adds. */
export function wrapToolHandler(tool: string, handler: AnyHandler, opts: ToolWrapOptions = {}): (...args: unknown[]) => Promise<unknown> {
  const emit = opts.emit ?? defaultEmit;
  const report = opts.report ?? defaultReport;
  const wrapped = async (...args: unknown[]) => {
    const extra = args[args.length - 1];
    const input = args.length > 1 ? (args[0] as Record<string, unknown> | undefined) : undefined;
    const requestId = acceptOrMint(inboundRequestId(extra));
    const start = Date.now();
    return context.run({ requestId }, async () => {
      let result: unknown;
      try {
        result = await handler(...args);
      } catch (err) {
        try {
          report(err, { request_id: requestId, tool });
        } catch {
          // Error reporting must never change the answer.
        }
        result = thrownResult(err);
      }
      result = withRequestIdInErrors(result, requestId);
      try {
        const isError = (result as ToolResultLike | undefined)?.isError === true;
        emit(buildRequestLine({
          requestId,
          tool,
          outcome: isError ? "error" : "ok",
          ms: Date.now() - start,
          code: isError ? toolErrorCode(result) : undefined,
          projectId: input?.project_id,
        }));
      } catch {
        // Logging must never change the answer.
      }
      return result;
    });
  };
  return wrapped;
}

type Registrar = { registerTool: AnyHandler; tool: AnyHandler };

/**
 * Patch `server.registerTool` and `server.tool` so every tool registered after
 * this call (including via ext-apps `registerAppTool` and `registerIssueTools`)
 * is wrapped. Idempotent per server.
 */
export function instrumentToolRegistration(server: object, opts: ToolWrapOptions = {}): void {
  const s = server as Registrar & { __scryRequestIdWrapped?: boolean };
  if (s.__scryRequestIdWrapped) return;
  s.__scryRequestIdWrapped = true;
  for (const method of ["registerTool", "tool"] as const) {
    const original = s[method].bind(server);
    s[method] = (...args: unknown[]) => {
      const last = args.length - 1;
      if (typeof args[0] === "string" && typeof args[last] === "function") {
        args[last] = wrapToolHandler(args[0], args[last] as AnyHandler, opts);
      }
      return original(...args);
    };
  }
}
