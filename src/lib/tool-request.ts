/**
 * One request id per MCP tool call (feature observability-request-id).
 *
 * Every tool handler is wrapped by `instrumentToolRegistration`, which:
 * - always mints a fresh ULID per call and ignores any inbound
 *   `x-scry-request-id` (contract "Trust rule": MCP faces end users and API
 *   clients, so it is an edge that never accepts a caller-chosen id);
 * - runs the handler inside an AsyncLocalStorage context, so any outbound call
 *   to a Scry service (search, dashboard, credits ledger) can forward the id with
 *   `requestIdHeaders()` without threading it through every signature;
 * - adds `"request_id"` to every JSON tool-error body, so no tool has to remember;
 * - writes ONE request line at the end of the call through the shared scry-log
 *   logger (schema v1: `request_id, route, status, ms, project, uid_hash,
 *   err_code`), built from a fixed allow-list, never a spread, and never the raw
 *   uid, the query text, a key or a body. `project` is logged
 *   only once the service that enforces access (search, dashboard) has answered
 *   the call for that project (`confirmProjectAccess`); caller input alone never
 *   puts a project id in the line;
 * - reports a thrown handler error to Sentry with the tags `request_id` and
 *   `tool`, and turns it into a structured tool error instead of a raw message.
 *
 * - (feature mcp-analytics) when `analytics` is configured, emits ONE vendor-neutral `McpToolCallEvent` per
 *   call next to the request line (src/analytics/), and, at registration, adds the optional `context` and
 *   `conversation_id` arguments to every tool's input schema and strips the ones it added before the
 *   handler runs. The request line is unchanged.
 *
 * Observability never breaks a tool call: logging, analytics and Sentry failures are
 * swallowed.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import * as Sentry from "@sentry/cloudflare";
import { REQUEST_ID_HEADER, mintRequestId } from "./request-id";
import type { Logger } from "./scry-log";
import { errCodeOf, getLogger, hashUid } from "./log";
import type { Analytics } from "../analytics/sinks";
import {
  CONTEXT_ARG,
  CONVERSATION_ARG,
  MISSING_CAPABILITY_TOOL,
  buildToolCallEvent,
  presentInputKeys,
  responseBytes,
  statusOfOutcome,
  type SessionInfo,
} from "../analytics/event";
import { prepareSchema, stripInjected, isPlainShape, type ArgMeta } from "../analytics/inject";

interface ToolCallContext {
  requestId: string;
  /** Set only after an access-checking Scry service answered for this project. */
  projectId?: string;
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

/**
 * Record that the service which enforces project access (search API, dashboard
 * agent API) answered this tool call successfully for `projectId`, so the
 * request line may name it. Call only after that success; a no-op outside a
 * tool call or for an unsafe value.
 */
export function confirmProjectAccess(projectId: unknown): void {
  const store = context.getStore();
  const safe = safeToken(projectId);
  if (store && safe) store.projectId = safe;
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

export interface ToolWrapOptions {
  /** Where the request line goes. Default: the shared logger (`logger`, else the env-less default one). */
  emit?: (line: RequestLine) => void;
  /** Shared scry-log logger for the default emit (the Durable Object passes its own, built from env). */
  logger?: Logger;
  /** The caller's raw uid and the uid_hash salt; only the salted hash is ever logged. */
  identify?: () => { uid?: string; salt?: string; env?: string };
  /** Error reporting for a thrown handler. Default: Sentry with request_id + tool tags. */
  report?: (err: unknown, tags: { request_id: string; tool: string }) => void;
  /** Vendor-neutral analytics (feature mcp-analytics). Absent = no event and no argument injection. */
  analytics?: Analytics;
  /** MCP session and client facts held by the Durable Object (client name/version, protocol, session id). */
  session?: () => SessionInfo | Promise<SessionInfo>;
  /** Immutable build id (SCRY_COMMIT) for the event. */
  serverBuild?: string;
}

/** HTTP-like status for a tool outcome: see `statusOfOutcome`. */
function statusOf(line: RequestLine): number {
  return statusOfOutcome(line.outcome, line.code);
}

function defaultEmit(line: RequestLine, logger: Logger | undefined, extra: { uid_hash?: string }): void {
  (logger ?? getLogger(undefined)).request({
    request_id: line.request_id,
    route: line.route,
    status: statusOf(line),
    ms: line.ms,
    project: line.project_id,
    err_code: line.outcome === "error" ? errCodeOf(line.code) : undefined,
    uid_hash: extra.uid_hash,
  });
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

type CallFacts = {
  requestId: string;
  tool: string;
  isError: boolean;
  ms: number;
  code?: string;
  projectId?: string;
  result: unknown;
  rawArgs: unknown;
  extra: unknown;
};

const CODEX_TURN_METADATA_KEY = "x-codex-turn-metadata";

/** The calling model when the client states it in request metadata (Codex). Never guessed. */
function modelFromMeta(extra: unknown): string | undefined {
  try {
    const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta?.[CODEX_TURN_METADATA_KEY] as { model?: unknown } | undefined;
    return typeof meta?.model === "string" ? meta.model : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build and emit the analytics event for one finished call. Fire and forget: the hash and the session lookup
 * happen off the request path, and every failure is swallowed (G3).
 */
function emitAnalytics(opts: ToolWrapOptions, meta: ArgMeta | undefined, f: CallFacts, uidHash: Promise<string | undefined>): void {
  const analytics = opts.analytics;
  if (!analytics) return;
  const raw = (f.rawArgs && typeof f.rawArgs === "object" ? f.rawArgs : {}) as Record<string, unknown>;
  // Sizes and names only, computed now so the result object is read before anything else can touch it.
  const inputKeys = presentInputKeys(raw, meta?.declared);
  const bytes = responseBytes(f.result);
  const context = meta ? raw[CONTEXT_ARG] : undefined;
  const conversationId = meta ? raw[CONVERSATION_ARG] : undefined;
  const model = modelFromMeta(f.extra);
  void (async () => {
    const [uid_hash, session] = await Promise.all([uidHash, Promise.resolve(opts.session?.()).catch(() => undefined)]);
    const who = opts.identify?.() ?? {};
    analytics.emit(
      buildToolCallEvent({
        ...(session ?? {}),
        requestId: f.requestId,
        tool: f.tool,
        outcome: f.isError ? "error" : "ok",
        ms: f.ms,
        errCode: f.code,
        projectId: f.projectId,
        uidHash: uid_hash,
        conversationId,
        llmModel: model,
        llmModelSource: model ? "client_metadata" : undefined,
        context,
        inputKeys,
        responseBytes: bytes,
        missingCapability: f.tool === MISSING_CAPABILITY_TOOL,
        serverBuild: opts.serverBuild,
        env: who.env,
      }),
    );
  })().catch(() => {});
}

/** Wrap one tool handler; see the module comment for what it adds. `meta` is set when the schema was injected. */
export function wrapToolHandler(tool: string, handler: AnyHandler, opts: ToolWrapOptions = {}, meta?: ArgMeta): (...args: unknown[]) => Promise<unknown> {
  const report = opts.report ?? defaultReport;
  const wrapped = async (...args: unknown[]) => {
    const requestId = mintRequestId();
    const start = Date.now();
    const store: ToolCallContext = { requestId };
    const rawArgs = args[0];
    // G6: the handler never sees the arguments the wrapper added.
    const callArgs = meta && meta.injected.size > 0 ? [stripInjected(args[0], meta.injected), ...args.slice(1)] : args;
    return context.run(store, async () => {
      let result: unknown;
      try {
        result = await handler(...callArgs);
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
        const ms = Date.now() - start;
        const line = buildRequestLine({
          requestId,
          tool,
          outcome: isError ? "error" : "ok",
          ms,
          code: isError ? toolErrorCode(result) : undefined,
          projectId: store.projectId,
        });
        // Fire and forget: the hash is computed off the request path (G4).
        const who = opts.identify?.() ?? {};
        const uidHash = hashUid(who.uid, who.salt, who.env);
        try {
          if (opts.emit) opts.emit(line);
          else uidHash.then(uid_hash => defaultEmit(line, opts.logger, { uid_hash })).catch(() => {});
        } catch {
          // A failing request-line sink must not stop the analytics event.
        }
        emitAnalytics(opts, meta, { requestId, tool, isError, ms, code: line.code, projectId: line.project_id, result, rawArgs, extra: args[1] }, uidHash);
      } catch {
        // Logging must never change the answer.
      }
      return result;
    });
  };
  return wrapped;
}

type Registrar = { registerTool: AnyHandler; tool: AnyHandler };

/** Wrap `handler` (and inject the analytics arguments into `schema`) when analytics is on. */
function prepare(name: string, schema: unknown, handler: AnyHandler, opts: ToolWrapOptions): { schema: unknown; handler: (...a: unknown[]) => Promise<unknown>; changed: boolean } {
  if (!opts.analytics) return { schema, handler: wrapToolHandler(name, handler, opts), changed: false };
  const prep = prepareSchema(schema);
  const inner: AnyHandler = prep.meta.adaptNoSchema ? (_args: unknown, extra: unknown) => handler(extra) : handler;
  return { schema: prep.schema, handler: wrapToolHandler(name, inner, opts, prep.meta), changed: prep.changed };
}

/** Split `tool(name, [description], [shape], [annotations], cb)` into its parts, as the SDK reads it. */
function parseToolArgs(args: unknown[]): { description?: string; shape?: unknown; annotations?: unknown; cb: AnyHandler } | null {
  const rest = args.slice(1, args.length - 1);
  const cb = args[args.length - 1] as AnyHandler;
  let description: string | undefined;
  if (typeof rest[0] === "string") description = rest.shift() as string;
  let shape: unknown;
  let annotations: unknown;
  if (rest.length > 0) {
    if (isPlainShape(rest[0])) {
      shape = rest.shift();
      if (rest.length > 0 && typeof rest[0] === "object" && rest[0] !== null) annotations = rest.shift();
    } else if (typeof rest[0] === "object" && rest[0] !== null) {
      annotations = rest.shift();
    }
  }
  return rest.length === 0 ? { description, shape, annotations, cb } : null;
}

/**
 * Patch `server.registerTool` and `server.tool` so every tool registered after
 * this call (including via ext-apps `registerAppTool` and `registerIssueTools`)
 * is wrapped. Idempotent per server.
 */
export function instrumentToolRegistration(server: object, opts: ToolWrapOptions = {}): void {
  const s = server as Registrar & { __scryRequestIdWrapped?: boolean };
  if (s.__scryRequestIdWrapped) return;
  s.__scryRequestIdWrapped = true;

  const originalRegisterTool = s.registerTool.bind(server);
  s.registerTool = (...args: unknown[]) => {
    const [name, config, cb] = args as [unknown, Record<string, unknown> | undefined, unknown];
    if (typeof name !== "string" || typeof cb !== "function") return originalRegisterTool(...args);
    const p = prepare(name, config?.inputSchema, cb as AnyHandler, opts);
    const cfg = p.changed ? { ...config, inputSchema: p.schema } : config;
    return originalRegisterTool(name, cfg, p.handler);
  };

  const originalTool = s.tool.bind(server);
  s.tool = (...args: unknown[]) => {
    const last = args.length - 1;
    if (typeof args[0] !== "string" || typeof args[last] !== "function") return originalTool(...args);
    const parts = parseToolArgs(args);
    if (!parts) {
      // An overload this wrapper does not recognise: wrap the handler only, as before.
      args[last] = wrapToolHandler(args[0], args[last] as AnyHandler, opts);
      return originalTool(...args);
    }
    const p = prepare(args[0], parts.shape, parts.cb, opts);
    if (!p.changed) {
      args[last] = p.handler;
      return originalTool(...args);
    }
    const mid: unknown[] = [];
    if (parts.description !== undefined) mid.push(parts.description);
    mid.push(p.schema);
    if (parts.annotations !== undefined) mid.push(parts.annotations);
    return originalTool(args[0], ...mid, p.handler);
  };
}
