/**
 * Sink contract, config parsing and the fail-open dispatcher (feature mcp-analytics, guarantees G3, G4, G5).
 *
 * A sink receives vendor-neutral events (event.ts). The dispatcher calls every sink inside try/catch with a
 * time budget, never awaits them on the tool-call path, and hands the pending work to `waitUntil` when the
 * platform offers it. A sink that throws, rejects or hangs changes nothing for the caller.
 */
import type { AnalyticsEvent, McpInitializeEvent, McpToolCallEvent, McpToolsListEvent } from "./event";

export interface AnalyticsSink {
  readonly name: string;
  toolCall(event: McpToolCallEvent): void | Promise<void>;
  initialize(event: McpInitializeEvent): void | Promise<void>;
  toolsList(event: McpToolsListEvent): void | Promise<void>;
}

export const KNOWN_SINKS = ["log", "posthog"] as const;
export type SinkName = (typeof KNOWN_SINKS)[number];

/**
 * `ANALYTICS_SINKS`: comma-separated sink names. The `log` sink is ALWAYS on, whatever the value says (the data must
 * always land in the logs), so unset, empty, "none" and "off" all give just `log`, and `posthog` alone gives
 * `log,posthog`. Unknown names are ignored (returned in `unknown` so the caller can warn), so a typo can never
 * enable something.
 */
export function parseSinks(value: string | undefined): { names: SinkName[]; unknown: string[] } {
  const raw = (value ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const names: SinkName[] = ["log"];
  const unknown: string[] = [];
  for (const r of raw) {
    if (r === "none" || r === "off") continue;
    if ((KNOWN_SINKS as readonly string[]).includes(r)) {
      if (!names.includes(r as SinkName)) names.push(r as SinkName);
    } else unknown.push(r);
  }
  return { names, unknown };
}

export interface AnalyticsOptions {
  sinks: AnalyticsSink[];
  /** Per-sink time budget. Work still running after this is abandoned (not awaited). Default 2000 ms. */
  budgetMs?: number;
  /** Keep the platform alive for pending sends (Durable Object / Worker `ctx.waitUntil`). */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Diagnostics for a failing sink. Must not throw; failures here are swallowed too. */
  onError?: (sink: string, err: unknown) => void;
}

export interface Analytics {
  emit(event: AnalyticsEvent): void;
  readonly sinkNames: string[];
}

/** A no-op analytics handle (no sinks configured). */
export const noAnalytics: Analytics = { emit: () => {}, sinkNames: [] };

function dispatch(sink: AnalyticsSink, event: AnalyticsEvent): void | Promise<void> {
  switch (event.schema) {
    case "mcp_tool_call.v1":
      return sink.toolCall(event);
    case "mcp_initialize.v1":
      return sink.initialize(event);
    case "mcp_tools_list.v1":
      return sink.toolsList(event);
  }
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // Diagnostics must never change the answer.
  }
}

export function createAnalytics(opts: AnalyticsOptions): Analytics {
  const budget = opts.budgetMs ?? 2000;
  const sinks = opts.sinks;
  const report = (sink: string, err: unknown) => safely(() => opts.onError?.(sink, err));

  function runOne(sink: AnalyticsSink, event: AnalyticsEvent): Promise<void> {
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        report(sink.name, new Error("analytics sink timed out"));
        resolve();
      }, budget);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      try {
        Promise.resolve(dispatch(sink, event)).then(done, err => {
          report(sink.name, err);
          done();
        });
      } catch (err) {
        report(sink.name, err);
        done();
      }
    });
  }

  return {
    sinkNames: sinks.map(s => s.name),
    emit(event) {
      if (sinks.length === 0) return;
      // Each sink starts in this tick but is never awaited by the caller.
      const pending = Promise.all(sinks.map(s => runOne(s, event)));
      safely(() => opts.waitUntil?.(pending));
    },
  };
}
