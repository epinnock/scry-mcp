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

import { scrubString } from "../lib/scry-log";

export const TOOL_CALL_SCHEMA = "mcp_tool_call.v1" as const;
export const INITIALIZE_SCHEMA = "mcp_initialize.v1" as const;
export const TOOLS_LIST_SCHEMA = "mcp_tools_list.v1" as const;

/** Names of the arguments the wrapper injects into every tool and strips before the handler (G6). */
export const CONTEXT_ARG = "context";
export const CONVERSATION_ARG = "conversation_id";
/** The tool agents call to describe a capability Scry does not offer. */
export const MISSING_CAPABILITY_TOOL = "get_more_tools";

export const MAX_INTENT = 300;
/** The raw intent is cut to this many characters BEFORE any pattern runs (bounds the scrubber's work, G3). */
export const MAX_INTENT_RAW = 1000;
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

/** The label shape allowed to leave the server (client name/version, protocol, model): a short safe token. */
const LABEL_SHAPE = /^[A-Za-z0-9._\-\/ ()+]{1,64}$/;
/** What a present but unsafe label is reported as. */
export const OTHER_LABEL = "other";

/**
 * A client-controlled label (client name/version, protocol version, model id). Absent or empty is `undefined`;
 * a value that is not a safe token (shape above, within `max`, and unchanged by the logger's `scrubString`) is
 * reported as "other" and never sent in part, so a hostile name can carry no secret and no unbounded cardinality.
 * The event builders use this, so the log attrs and PostHog get the same value.
 */
export function cleanLabel(value: unknown, max = MAX_LABEL): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return OTHER_LABEL;
  return value.length <= max && LABEL_SHAPE.test(value) && scrubString(value) === value ? value : OTHER_LABEL;
}

// --- Intent scrubber -------------------------------------------------------------------------------

const REDACTED = "[redacted]";
const WORD = "A-Za-z0-9_";
/** Characters of a "token-like" run. */
const RUN = "A-Za-z0-9_+/=.-";
const HEX_GROUP = "[0-9A-Fa-f]{1,4}";
/** One decimal IPv4 octet, 0-255. */
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
/** The separator allowed inside a phone number: one space, dot or hyphen. */
const SEP = "[ .-]";

/**
 * Every pattern below is linear-time (feature mcp-analytics, review F1): no unbounded quantifier is nested or
 * re-tried from every start position. Where a pattern must look at a whole run of characters it can only START
 * at the beginning of that run (a lookbehind), or its quantifiers are bounded.
 * Order matters: URLs first (they contain token-shaped parts), then secrets, then long ids.
 */
export const CORE_RULES: ReadonlyArray<RegExp> = [
  // URLs. The scheme part is at most 32 characters, so each start position costs O(32).
  /(?:[a-z][a-z0-9+.-]{0,31}:\/\/|\bwww\.)[^\s<>"')]+/gi,
  /\bBearer\s+[A-Z0-9._~+/=-]+/gi, // auth headers
  /\beyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]+){0,2}/g, // JWTs
  /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|glpat|xox[abprs]|phc|phx|AIza|AKIA|ya29|scry)[-_A-Za-z0-9.]{6,}/g, // known key prefixes
  /\b[A-Fa-f0-9]{16,}\b/g, // hex ids and hashes
  // Mixed letters + digits, 20+ chars. Starts only at the beginning of a run (lookbehind); the run's first word
  // character is where the old `\b` start fell, so the match is the same, but the two lookaheads now run once per run.
  new RegExp(`(?<![${RUN}])(?<keep>[+/=.-]*)(?=[${WORD}])(?=[${RUN}]*\\d)(?=[${RUN}]*[A-Za-z])[${RUN}]{20,}`, "g"),
  /\b[A-Za-z0-9_+/=-]{32,}\b/g, // any 32+ char run
];

/** Phone numbers and IP addresses (added in fix round 1). Bounded, start-anchored, linear. */
export const PII_RULES: ReadonlyArray<RegExp> = [
  // E.164 and international: + country code then digits with common separators, 8 to 15 digits in all.
  /(?<![\w.+])\+\d(?:[ .()-]?\d){7,14}(?!\d)/g,
  // US / NANP: optional 1 or +1, area code in () or bare, then 3-4 digits with one optional . - or space between.
  new RegExp(`(?<![\\w.+-])(?:\\+?1${SEP}?)?(?:\\(\\d{3}\\)${SEP}?|\\d{3}${SEP})\\d{3}${SEP}\\d{4}(?![\\d-])`, "g"),
  /(?<![\w.+-])\d{10}(?![\d.-])/g, // ten bare digits
  // IPv4: four decimal octets 0-255 (a version such as 1.2.3 or a date has fewer or longer parts).
  new RegExp(`(?<![\\w.])(?:${OCTET}\\.){3}${OCTET}(?!\\w|\\.\\d)`, "g"),
  // IPv6: eight groups, or a "::" compressed form. A clock time such as 12:00:00 has neither.
  new RegExp(
    `(?<![\\w:.])(?:(?:${HEX_GROUP}:){7}${HEX_GROUP}|(?:${HEX_GROUP}(?::${HEX_GROUP}){0,6})?::(?:${HEX_GROUP}(?::${HEX_GROUP}){0,6})?)(?![\\w:])`,
    "g",
  ),
];

const SCRUB_RULES: ReadonlyArray<RegExp> = [...CORE_RULES, ...PII_RULES];

/** Replacement: the whole match, except a leading `keep` group (punctuation before the first word character) stays. */
function redact(...args: unknown[]): string {
  const groups = args[args.length - 1];
  const keep = typeof groups === "object" && groups !== null ? (groups as { keep?: string }).keep : undefined;
  return `${keep ?? ""}${REDACTED}`;
}

/** One scrub pass over `text` (already length-bounded by the caller): control characters, emails, patterns, whitespace. */
export function scrubPass(text: string, rules: ReadonlyArray<RegExp> = SCRUB_RULES, probe?: (inputLength: number) => void): string {
  probe?.(text.length);
  let s = text.replace(/[\u0000-\u001F\u007F]/g, " ");
  // Emails: any whitespace-delimited word with an @ in its middle (no regex backtracking).
  s = s.split(/\s+/).map(w => (w.indexOf("@") > 0 && w.indexOf("@") < w.length - 1 ? REDACTED : w)).join(" ");
  for (const rule of rules) s = s.replace(rule, redact);
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Strip emails, URLs, phone numbers, IPs and token/key-shaped strings; collapse whitespace; cap at 300 chars.
 * Pipeline: cut the raw value to 1000 chars, scrub, cut to 300, scrub again (a secret split by the 300 boundary
 * is redacted by the second pass). `probe` receives the length of each pass's input (tests: never above 1000).
 */
export function scrubIntent(value: unknown, probe?: (inputLength: number) => void): string | undefined {
  if (typeof value !== "string") return undefined;
  let s = scrubPass(value.length > MAX_INTENT_RAW ? value.slice(0, MAX_INTENT_RAW) : value, SCRUB_RULES, probe);
  if (s.length > MAX_INTENT) s = scrubPass(s.slice(0, MAX_INTENT), SCRUB_RULES, probe);
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

/**
 * Declared argument names that are present in `args` (never values), minus the analytics args the wrapper injected.
 * A tool's own `context` / `conversation_id` is a normal argument and its name is listed (F3).
 */
export function presentInputKeys(args: unknown, declared: ReadonlySet<string> | undefined, injected?: ReadonlySet<string>): string[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const keys: string[] = [];
  for (const k of Object.keys(args)) {
    if (injected?.has(k)) continue;
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
