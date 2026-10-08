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
  /** csv of sink names; unset = "log". Production sets none beyond the default until Gate B (G7). */
  ANALYTICS_SINKS?: string;
  POSTHOG_PROJECT_TOKEN?: string;
  POSTHOG_HOST?: string;
  SCRY_COMMIT?: string;
}

export interface AnalyticsDeps {
  logger: () => Logger;
  waitUntil?: (promise: Promise<unknown>) => void;
  onError?: (sink: string, err: unknown) => void;
  budgetMs?: number;
  /** Tests: replaces the PostHog HTTP transport. */
  posthogFetch?: Parameters<typeof createPostHogSink>[0]["fetch"];
}

/** Sinks named in `ANALYTICS_SINKS` that are also usable (posthog needs its token). */
export function createSinks(env: AnalyticsEnv, deps: AnalyticsDeps): AnalyticsSink[] {
  const sinks: AnalyticsSink[] = [];
  for (const name of parseSinks(env.ANALYTICS_SINKS).names) {
    if (name === "log") sinks.push(createLogSink(deps.logger));
    if (name === "posthog") {
      const sink = createPostHogSink({
        token: env.POSTHOG_PROJECT_TOKEN,
        host: env.POSTHOG_HOST,
        serverBuild: env.SCRY_COMMIT,
        fetch: deps.posthogFetch,
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
