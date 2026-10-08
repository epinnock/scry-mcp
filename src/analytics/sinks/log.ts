/**
 * Log sink: one schema-v1 `mcp_tool_call` line per tool call through the shared scry-log logger, joinable to
 * the `request` line by `request_id`. The standard keys (request_id, route = tool, status, ms, err_code, uid_hash,
 * project) carry the headline; the rest of the event travels in the registered `attrs` object
 * (`mcp.*`, declared in the scry-log attribute registry), so the log holds the full event and can be queried with
 * `scry-logs.py --attr mcp.session_id=...`. The schema's `client` key is not used: since scry-log #114 the store keeps
 * it only for Scry's own producers (an allow-list), so the third-party MCP client is `mcp.client_name`/`mcp.client_version`. The intent TEXT is never logged (only `mcp.has_intent`), nor argument
 * values or bodies. Adding a field: register it in scry-management/lib/scry-log, re-sync, then add it here.
 */
import type { LogAttrs, Logger } from "../../lib/scry-log";
import { errCodeOf } from "../../lib/log";
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

interface AttrSource {
  session_id?: string;
  conversation_id?: string;
  client_name?: string;
  client_version?: string;
  protocol_version?: string;
}

/** The `mcp.*` attributes every event shares. The build is not one of them: it rides in the top-level `version` (SCRY_COMMIT), and a 40-hex sha is secret-shaped to the attrs scrubber (F15). Names and versions are slugged so they are single tokens; undefined values are omitted. */
function sharedAttrs(e: AttrSource): LogAttrs {
  const a: Record<string, string | number | boolean | string[] | undefined> = {
    "mcp.session_id": e.session_id,
    "mcp.conversation_id": e.conversation_id,
    "mcp.client_name": slug(e.client_name, 64),
    "mcp.client_version": slug(e.client_version, 32),
    "mcp.protocol_version": slug(e.protocol_version, 16),
  };
  return compact(a);
}

function compact(a: Record<string, string | number | boolean | string[] | undefined>): LogAttrs {
  const out: LogAttrs = {};
  for (const [k, v] of Object.entries(a)) if (v !== undefined) out[k] = v;
  return out;
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
        project: e.project_id,
        attrs: {
          ...sharedAttrs(e),
          ...compact({
            "mcp.llm_model": slug(e.llm_model, 64),
            "mcp.llm_model_source": e.llm_model_source,
            "mcp.input_keys": e.input_keys.map(k => slug(k, 64)).filter((k): k is string => k !== undefined),
            "mcp.response_bytes": e.response_bytes,
            "mcp.has_intent": e.intent !== undefined,
            "mcp.intent_source": e.intent_source,
            "mcp.missing_capability": e.missing_capability,
          }),
        },
      });
    },
    initialize(e: McpInitializeEvent) {
      logger().info("mcp_initialize", { uid_hash: e.uid_hash, attrs: sharedAttrs(e) });
    },
    toolsList(e: McpToolsListEvent) {
      logger().info("mcp_tools_list", {
        uid_hash: e.uid_hash,
        attrs: { ...sharedAttrs(e), "mcp.tool_count": e.tool_count },
      });
    },
  };
}
