/**
 * Vendor-neutral analytics events for the Scry MCP server (feature mcp-analytics).
 *
 * One `McpToolCallEvent` per tool call, plus `McpInitializeEvent` and `McpToolsListEvent`. Every event is
 * built from an explicit allow-list (never a spread), so nothing that is not named here can reach a sink:
 * no argument values, no response bodies, no raw uid, no keys. The only free text is the agent's own
 * `context` (the intent), scrubbed and capped, and it is dropped by the log sink.
 *
 * No file in this folder except `sinks/posthog.ts` knows about a vendor.
 */

export const TOOL_CALL_SCHEMA = "mcp_tool_call.v1" as const;
export const INITIALIZE_SCHEMA = "mcp_initialize.v1" as const;
export const TOOLS_LIST_SCHEMA = "mcp_tools_list.v1" as const;

/** Names of the arguments the wrapper injects into every tool and strips before the handler (G6). */
export const CONTEXT_ARG = "context";
export const CONVERSATION_ARG = "conversation_id";
/** The tool agents call to describe a capability Scry does not offer. */
export const MISSING_CAPABILITY_TOOL = "get_more_tools";

export const MAX_INTENT = 300;
const MAX_ID = 128;
const MAX_LABEL = 64;
const MAX_KEYS = 50;

export type Outcome = "ok" | "error";
export type Environment = "production" | "staging" | "development";

export interface McpToolCallEvent {
  schema: typeof TOOL_CALL_SCHEMA;
  request_id: string;
  tool: string;
  outcome: Outcome;
  ms: number;
  err_code?: string;
  /** Only when the access-checking service confirmed it (same rule as the request line). */
  project_id?: string;
  /** Salted hash of the caller's uid; the raw uid never enters an event. */
  uid_hash?: string;
  session_id?: string;
  conversation_id?: string;
  client_name?: string;
  client_version?: string;
  protocol_version?: string;
  llm_model?: string;
  /** Only "client_metadata": a model the client stated in request metadata. Never inferred or self-reported. */
  llm_model_source?: "client_metadata";
  /** Scrubbed text of the `context` argument. Sinks decide whether to keep it; the log sink never does. */
  intent?: string;
  intent_source?: "context_parameter";
  /** Declared argument names that were present. Never values. */
  input_keys: string[];
  /** Size of the tool result in bytes. Never the body. */
  response_bytes: number;
  missing_capability: boolean;
  server_build?: string;
  env: Environment;
}

export interface McpInitializeEvent {
  schema: typeof INITIALIZE_SCHEMA;
  uid_hash?: string;
  session_id?: string;
  client_name?: string;
  client_version?: string;
  protocol_version?: string;
  server_build?: string;
  env: Environment;
}

export interface McpToolsListEvent {
  schema: typeof TOOLS_LIST_SCHEMA;
  uid_hash?: string;
  session_id?: string;
  client_name?: string;
  client_version?: string;
  protocol_version?: string;
  tool_names: string[];
  tool_count: number;
  server_build?: string;
  env: Environment;
}

export type AnalyticsEvent = McpToolCallEvent | McpInitializeEvent | McpToolsListEvent;

const SAFE_ID = /^[A-Za-z0-9_.:\-]+$/;

/** An id-like value: short, path-safe. Anything else is dropped, never repaired. */
export function safeId(value: unknown, max = MAX_ID): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max && SAFE_ID.test(value) ? value : undefined;
}

/** A short human label (client name, model id): printable ASCII only, whitespace collapsed, capped. */
export function cleanLabel(value: unknown, max = MAX_LABEL): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
  return s.length > 0 ? s : undefined;
}

// --- Intent scrubber -------------------------------------------------------------------------------

const REDACTED = "[redacted]";
// Order matters: URLs first (they contain token-shaped parts), then secrets, then long ids.
const SCRUB_RULES: ReadonlyArray<RegExp> = [
  /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"')]+/gi, // URLs
  /\bBearer\s+[A-Z0-9._~+/=-]+/gi, // auth headers
  /\beyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]+){0,2}/g, // JWTs
  /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|glpat|xox[abprs]|phc|phx|AIza|AKIA|ya29|scry)[-_A-Za-z0-9.]{6,}/g, // known key prefixes
  /\b[A-Fa-f0-9]{16,}\b/g, // hex ids and hashes
  /\b(?=[A-Za-z0-9_+/=.-]*\d)(?=[A-Za-z0-9_+/=.-]*[A-Za-z])[A-Za-z0-9_+/=.-]{20,}/g, // mixed letters+digits, 20+ chars
  /\b[A-Za-z0-9_+/=-]{32,}\b/g, // any 32+ char run
];

/** Strip emails, URLs, token/key-shaped strings; collapse whitespace; cap at 300 chars. */
export function scrubIntent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let s = value.replace(/[\u0000-\u001F\u007F]/g, " ");
  // Emails: any whitespace-delimited word with an @ in its middle (no regex backtracking).
  s = s.split(/\s+/).map(w => (w.indexOf("@") > 0 && w.indexOf("@") < w.length - 1 ? REDACTED : w)).join(" ");
  for (const rule of SCRUB_RULES) s = s.replace(rule, REDACTED);
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > MAX_INTENT) s = s.slice(0, MAX_INTENT).trimEnd();
  return s.length > 0 ? s : undefined;
}

// --- Sizes and keys --------------------------------------------------------------------------------

/** UTF-8 byte length of a string without allocating a copy. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

type ResultBlock = { type?: unknown; text?: unknown; data?: unknown };

/**
 * Approximate size of a tool result in bytes: text blocks by UTF-8 length, binary blocks by their base64
 * length, structuredContent by its JSON length. Reads sizes only and returns no content. 0 when unknowable.
 */
export function responseBytes(result: unknown): number {
  try {
    const r = result as { content?: unknown; structuredContent?: unknown } | undefined;
    let total = 0;
    if (Array.isArray(r?.content)) {
      for (const block of r.content as ResultBlock[]) {
        if (typeof block?.text === "string") total += utf8Length(block.text);
        else if (typeof block?.data === "string") total += block.data.length;
      }
    }
    if (r?.structuredContent !== undefined) total += utf8Length(JSON.stringify(r.structuredContent) ?? "");
    return total;
  } catch {
    return 0;
  }
}

/** Declared argument names that are present in `args` (never values), minus the injected analytics args. */
export function presentInputKeys(args: unknown, declared: ReadonlySet<string> | undefined): string[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const keys: string[] = [];
  for (const k of Object.keys(args)) {
    if (k === CONTEXT_ARG || k === CONVERSATION_ARG) continue;
    if (declared && !declared.has(k)) continue;
    const safe = safeId(k, MAX_LABEL);
    if (safe && (args as Record<string, unknown>)[k] !== undefined) keys.push(safe);
    if (keys.length >= MAX_KEYS) break;
  }
  return keys.sort();
}

// --- Builders (allow-list only) ----------------------------------------------------------------------

export interface SessionInfo {
  session_id?: string;
  client_name?: string;
  client_version?: string;
  protocol_version?: string;
}

export interface ToolCallInput extends SessionInfo {
  requestId: string;
  tool: string;
  outcome: Outcome;
  ms: number;
  errCode?: unknown;
  projectId?: unknown;
  uidHash?: unknown;
  conversationId?: unknown;
  llmModel?: unknown;
  llmModelSource?: unknown;
  context?: unknown;
  inputKeys?: string[];
  responseBytes?: number;
  missingCapability?: boolean;
  serverBuild?: unknown;
  env?: unknown;
}

export function schemaEnv(value: unknown): Environment {
  return value === "production" || value === "staging" ? value : "development";
}

function sessionFields(i: SessionInfo) {
  return {
    session_id: safeId(i.session_id),
    client_name: cleanLabel(i.client_name),
    client_version: cleanLabel(i.client_version, 32),
    protocol_version: cleanLabel(i.protocol_version, 16),
  };
}

function dropUndefined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k];
  return o;
}

export function buildToolCallEvent(i: ToolCallInput): McpToolCallEvent {
  const intent = scrubIntent(i.context);
  return dropUndefined<McpToolCallEvent>({
    schema: TOOL_CALL_SCHEMA,
    request_id: safeId(i.requestId) ?? "unknown",
    tool: safeId(i.tool, MAX_LABEL) ?? "unknown",
    outcome: i.outcome === "error" ? "error" : "ok",
    ms: Math.max(0, Math.round(Number(i.ms) || 0)),
    err_code: i.outcome === "error" ? safeId(i.errCode) : undefined,
    project_id: safeId(i.projectId),
    uid_hash: typeof i.uidHash === "string" && /^[0-9a-f]{12}$/.test(i.uidHash) ? i.uidHash : undefined,
    ...sessionFields(i),
    conversation_id: safeId(i.conversationId),
    llm_model: cleanLabel(i.llmModel),
    llm_model_source: cleanLabel(i.llmModel) && i.llmModelSource === "client_metadata" ? "client_metadata" : undefined,
    intent,
    intent_source: intent ? "context_parameter" : undefined,
    input_keys: (i.inputKeys ?? []).map(k => safeId(k, MAX_LABEL)).filter((k): k is string => !!k).slice(0, MAX_KEYS),
    response_bytes: Math.max(0, Math.round(Number(i.responseBytes) || 0)),
    missing_capability: i.missingCapability === true,
    server_build: safeId(i.serverBuild, 64),
    env: schemaEnv(i.env),
  });
}

export function buildInitializeEvent(i: SessionInfo & { uidHash?: unknown; serverBuild?: unknown; env?: unknown }): McpInitializeEvent {
  return dropUndefined<McpInitializeEvent>({
    schema: INITIALIZE_SCHEMA,
    uid_hash: typeof i.uidHash === "string" && /^[0-9a-f]{12}$/.test(i.uidHash) ? i.uidHash : undefined,
    ...sessionFields(i),
    server_build: safeId(i.serverBuild, 64),
    env: schemaEnv(i.env),
  });
}

export function buildToolsListEvent(
  i: SessionInfo & { toolNames: string[]; uidHash?: unknown; serverBuild?: unknown; env?: unknown },
): McpToolsListEvent {
  const names = i.toolNames.map(n => safeId(n, MAX_LABEL)).filter((n): n is string => !!n);
  return dropUndefined<McpToolsListEvent>({
    schema: TOOLS_LIST_SCHEMA,
    uid_hash: typeof i.uidHash === "string" && /^[0-9a-f]{12}$/.test(i.uidHash) ? i.uidHash : undefined,
    ...sessionFields(i),
    tool_names: names.slice(0, 200),
    tool_count: names.length,
    server_build: safeId(i.serverBuild, 64),
    env: schemaEnv(i.env),
  });
}

/** HTTP-like status for a tool outcome (shared with the request line): 200 ok; 402/403/429; 500 server-side; else 400. */
export function statusOfOutcome(outcome: Outcome, code: string | undefined): number {
  if (outcome === "ok") return 200;
  const c = (code ?? "").toUpperCase();
  if (c === "INSUFFICIENT_CREDITS") return 402;
  if (c === "ACCESS_DENIED") return 403;
  if (c === "RATE_LIMITED") return 429;
  return c === "INTERNAL_ERROR" || c === "UPSTREAM_TIMEOUT" || c.startsWith("GEMINI") || /_5\d\d$/.test(c) ? 500 : 400;
}
