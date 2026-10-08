/**
 * Log sink: one schema-v1 `mcp_tool_call` line per tool call through the shared scry-log logger, joinable to
 * the `request` line by `request_id`. Schema v1 is a closed allow-list, so the line carries only the keys the
 * schema defines: request_id, route (= tool), status, ms, err_code, uid_hash and client ("name/version").
 * The intent text, argument names and response size are not logged (L5); they go to the other sinks.
 */
import type { Logger } from "../../lib/scry-log";
import { clientOf, errCodeOf } from "../../lib/log";
import { statusOfOutcome, type McpInitializeEvent, type McpToolCallEvent, type McpToolsListEvent } from "../event";
import type { AnalyticsSink } from "../sinks";

function slug(value: string | undefined, max: number): string | undefined {
  const chars = (value ?? "").replace(/[^A-Za-z0-9._+-]+/g, "-").slice(0, max);
  let start = 0;
  let end = chars.length;
  while (start < end && !/[A-Za-z0-9]/.test(chars[start])) start++;
  while (end > start && chars[end - 1] === "-") end--;
  return chars.slice(start, end) || undefined;
}

/** `name/version` in the shape the schema's `client` field accepts, else undefined. */
export function clientLabel(name: string | undefined, version: string | undefined): string | undefined {
  const n = slug(name, 32);
  const v = slug(version, 32);
  return n && v ? clientOf(`${n}/${v}`) : undefined;
}

export function createLogSink(logger: () => Logger): AnalyticsSink {
  return {
    name: "log",
    toolCall(e: McpToolCallEvent) {
      logger().request({
        msg: "mcp_tool_call",
        request_id: e.request_id,
        route: e.tool,
        status: statusOfOutcome(e.outcome, e.err_code),
        ms: e.ms,
        err_code: e.outcome === "error" ? errCodeOf(e.err_code) : undefined,
        uid_hash: e.uid_hash,
        client: clientLabel(e.client_name, e.client_version),
      });
    },
    initialize(e: McpInitializeEvent) {
      logger().info("mcp_initialize", { uid_hash: e.uid_hash, client: clientLabel(e.client_name, e.client_version) });
    },
    toolsList(e: McpToolsListEvent) {
      logger().info("mcp_tools_list", { uid_hash: e.uid_hash, client: clientLabel(e.client_name, e.client_version) });
    },
  };
}
