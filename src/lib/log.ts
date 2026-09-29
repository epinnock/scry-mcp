// log-standardization: the shared scry-log logger for this Worker and its Durable Object (schema v1,
// console sink; the scry-logs tail consumer ships the lines). Fail-open: nothing here throws or blocks a call.
import { createLogger, consoleSink, type Logger, type Sink } from "./scry-log";

export interface LogEnv {
  SCRY_ENV?: string;
  SCRY_COMMIT?: string;
  SCRY_LOG_DEBUG?: string;
  /**
   * SECRET salt for uid_hash (`wrangler secret put SCRY_LOG_SALT`, never a var in git). Unset in staging or
   * production: `uid_hash` is omitted (a public salt would let anyone confirm a known uid).
   */
  SCRY_LOG_SALT?: string;
}

let sinkOverride: Sink | null = null;
let cached: { key: string; log: Logger } | null = null;

/** Tests only: route lines to a custom sink (null restores the console sink). */
export function setLogSinkForTest(sink: Sink | null): void {
  sinkOverride = sink;
  cached = null;
}

function schemaEnv(value: string | undefined): "production" | "staging" | "development" {
  return value === "production" || value === "staging" ? value : "development";
}

/** The logger for this deploy (cached per env/commit). Never throws. */
export function getLogger(env: LogEnv | undefined): Logger {
  const e = schemaEnv(env?.SCRY_ENV);
  const version = env?.SCRY_COMMIT;
  const key = `${e}|${version ?? ""}|${env?.SCRY_LOG_DEBUG ?? ""}|${sinkOverride ? "o" : "c"}`;
  if (cached?.key === key) return cached.log;
  const log = createLogger({ service: "mcp", env: e, version, debug: env?.SCRY_LOG_DEBUG, sink: sinkOverride ?? consoleSink() });
  cached = { key, log };
  return log;
}

/**
 * First 12 hex of sha256(uid + salt); undefined when there is no uid, no salt outside development, or hashing
 * is unavailable. `scryEnv` is the Worker's SCRY_ENV: only development (local runs, tests) may hash without a
 * configured secret, with a throwaway constant; staging and production never fall back to a public salt.
 */
export async function hashUid(uid: unknown, salt: string | undefined, scryEnv?: string): Promise<string | undefined> {
  if (typeof uid !== "string" || uid.length === 0) return undefined;
  const used = salt || (schemaEnv(scryEnv) === "development" ? "scry-log-dev" : undefined);
  if (!used) return undefined;
  try {
    const bytes = new TextEncoder().encode(uid + used);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest).slice(0, 6), b => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return undefined;
  }
}

/** `x-scry-client` header value: "<name>/<version>" only, capped; anything else is dropped. */
const CLIENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}\/[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;
export function clientOf(value: unknown): string | undefined {
  return typeof value === "string" && CLIENT_RE.test(value) ? value : undefined;
}

/** A tool error code as a schema err_code (`SEARCH_API_500` -> `search_api_500`), else a fixed fallback. */
export function errCodeOf(code: unknown, fallback = "tool_error"): string {
  const c = typeof code === "string" ? code.toLowerCase().replace(/[^a-z0-9_.]/g, "_") : "";
  return /^[a-z][a-z0-9_.]{0,47}$/.test(c) ? c : fallback;
}

/** `generateImageViaGemini` -> `generate Image Via Gemini`: words only, as the schema's msg requires. */
export function msgWords(name: string, fallback = "diagnostic"): string {
  const s = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[^A-Za-z _.:-]/g, " ").replace(/\s+/g, " ").trim();
  return s && s.split(" ").every(w => w.length <= 20) ? s.slice(0, 80) : fallback;
}
