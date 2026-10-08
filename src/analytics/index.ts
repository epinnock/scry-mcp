/**
 * Analytics wiring for the Scry MCP server (feature mcp-analytics): builds the configured sinks from env.
 * This is the one place that lists sinks; add or replace one by writing a `sinks/<name>.ts` that implements
 * `AnalyticsSink` and registering it here and in `KNOWN_SINKS`.
 */
import type { Logger } from "../lib/scry-log";
import { createAnalytics, parseSinks, type Analytics, type AnalyticsSink } from "./sinks";
import { createLogSink } from "./sinks/log";
import { createPostHogSink } from "./sinks/posthog";

export interface AnalyticsEnv {
  /** csv of sink names; `log` is always on. Production sets nothing beyond the default until Gate B (G7). */
  ANALYTICS_SINKS?: string;
  /** "on" adds the `context` / `conversation_id` arguments to every tool and registers `get_more_tools`. Default off. */
  ANALYTICS_AGENT_ARGS?: string;
  POSTHOG_PROJECT_TOKEN?: string;
  POSTHOG_HOST?: string;
  SCRY_COMMIT?: string;
  /** Needed by the posthog sink: without it every event would be anonymous (the salted uid hash is the distinct id). */
  SCRY_LOG_SALT?: string;
}

/** True only for the exact value "on" (any case): the agent-visible arguments and tool are opt-in. */
export function agentArgsEnabled(env: Pick<AnalyticsEnv, "ANALYTICS_AGENT_ARGS">): boolean {
  return (env.ANALYTICS_AGENT_ARGS ?? "").trim().toLowerCase() === "on";
}

export interface AnalyticsDeps {
  logger: () => Logger;
  waitUntil?: (promise: Promise<unknown>) => void;
  onError?: (sink: string, err: unknown) => void;
  budgetMs?: number;
  /**
   * One schema-v1 warning line (message words, fixed err_code; never a value from the environment). Called at
   * most once per condition per `createSinks` and once per PostHog load failure.
   */
  warn?: (msg: string, errCode: string) => void;
  /** Tests: replaces the PostHog HTTP transport. */
  posthogFetch?: Parameters<typeof createPostHogSink>[0]["fetch"];
  /** Tests: replaces the PostHog module loader and the clock used for its retry backoff. */
  posthogLoadSdk?: Parameters<typeof createPostHogSink>[0]["loadSdk"];
  now?: () => number;
}

/**
 * The sinks to run: `log` always, plus the others named in `ANALYTICS_SINKS` that are usable. `posthog` needs its
 * token (silently absent without it) and `SCRY_LOG_SALT` (without it every event would be anonymous, so the sink
 * refuses to start and says so once). An unknown name logs one warning.
 */
export function createSinks(env: AnalyticsEnv, deps: AnalyticsDeps): AnalyticsSink[] {
  const warn = (msg: string, code: string) => {
    try {
      deps.warn?.(msg, code);
    } catch {
      // A warning is a diagnostic; it never changes startup.
    }
  };
  const sinks: AnalyticsSink[] = [];
  const parsed = parseSinks(env.ANALYTICS_SINKS);
  if (parsed.unknown.length > 0) warn("analytics unknown sink", "analytics_unknown_sink");
  for (const name of parsed.names) {
    if (name === "log") sinks.push(createLogSink(deps.logger));
    if (name === "posthog") {
      if (!env.POSTHOG_PROJECT_TOKEN?.trim()) continue;
      if (!env.SCRY_LOG_SALT?.trim()) {
        warn("analytics posthog disabled", "analytics_posthog_no_salt");
        continue;
      }
      const sink = createPostHogSink({
        token: env.POSTHOG_PROJECT_TOKEN,
        host: env.POSTHOG_HOST,
        serverBuild: env.SCRY_COMMIT,
        fetch: deps.posthogFetch,
        loadSdk: deps.posthogLoadSdk,
        now: deps.now,
        onLoadError: () => warn("analytics posthog load failed", "analytics_posthog_load"),
      });
      if (sink) sinks.push(sink);
    }
  }
  return sinks;
}

export function createAnalyticsFromEnv(env: AnalyticsEnv, deps: AnalyticsDeps): Analytics {
  return createAnalytics({ sinks: createSinks(env, deps), waitUntil: deps.waitUntil, onError: deps.onError, budgetMs: deps.budgetMs });
}

export * from "./event";
export type { Analytics, AnalyticsSink } from "./sinks";
