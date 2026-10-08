/**
 * PostHog sink (feature mcp-analytics). THE ONLY FILE that imports `@posthog/*` or `posthog-node`
 * (enforced by the `no-restricted-imports` rule in eslint.config.mjs, guarantee G5). To drop PostHog: delete
 * this file, its registration in `src/analytics/index.ts` and the two dependencies.
 *
 * It maps our vendor-neutral events onto PostHog's MCP analytics events ($mcp_tool_call, $mcp_initialize,
 * $mcp_tools_list, $mcp_missing_capability, $exception) through `PostHogMCP`, PostHog's custom-dispatcher API,
 * so the PostHog MCP analytics dashboard recognises them. Privacy (G1, G2): `parameters` and `response` are
 * never passed (the SDK omits the properties when they are undefined), so argument values and result bodies
 * cannot be sent; `$mcp_input_keys` carries names only; distinct_id is the salted uid hash.
 *
 * No-op without a project token. The module is loaded lazily on the first event, so a deploy without the
 * token never evaluates the SDK. The SDK queues events and never throws; the dispatcher adds a time budget.
 */
import type { PostHogMCP, PostHogMCPOptions } from "@posthog/mcp";
import type { McpInitializeEvent, McpToolCallEvent, McpToolsListEvent } from "../event";
import type { AnalyticsSink } from "../sinks";

export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

export interface PostHogSinkOptions {
  /** Project token (`POSTHOG_PROJECT_TOKEN`). The sink is absent (null) when empty. */
  token: string | undefined;
  host?: string;
  /** Immutable build id, sent as `$mcp_server_build`. */
  serverBuild?: string;
  /** Tests: replaces the HTTP transport of the PostHog client. */
  fetch?: PostHogMCPOptions["fetch"];
  /** Per-request HTTP timeout. Default 1500 ms. */
  requestTimeoutMs?: number;
}

type Client = PostHogMCP;

/** Let queued microtasks (the SDK's async event pipeline) finish before flushing. */
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export function createPostHogSink(opts: PostHogSinkOptions): AnalyticsSink | null {
  const token = opts.token?.trim();
  if (!token) return null;

  let client: Promise<Client | null> | undefined;
  const load = async (): Promise<Client | null> => {
    try {
      const { PostHogMCP: Ctor } = await import("@posthog/mcp");
      return new Ctor(token, {
        host: opts.host || DEFAULT_POSTHOG_HOST,
        flushAt: 1,
        flushInterval: 0,
        fetchRetryCount: 0,
        requestTimeout: opts.requestTimeoutMs ?? 1500,
        disableCompression: true,
        disableGeoip: true,
        preloadFeatureFlags: false,
        disableRemoteConfig: true,
        captureModel: false,
        enableConversationId: false,
        serverBuild: opts.serverBuild,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
    } catch {
      return null;
    }
  };

  async function send(capture: (c: Client) => void): Promise<void> {
    try {
      client ??= load();
      const c = await client;
      if (!c) return;
      capture(c);
      await tick();
      await c.flush();
    } catch {
      // A sink never throws: PostHog being down must not become anyone's problem (G3).
    }
  }

  const common = (e: { uid_hash?: string; session_id?: string; protocol_version?: string }) => ({
    distinctId: e.uid_hash,
    sessionId: e.session_id,
    protocolVersion: e.protocol_version,
  });

  return {
    name: "posthog",
    toolCall(e: McpToolCallEvent) {
      const isError = e.outcome === "error";
      return send(c => {
        c.captureToolCall({
          ...common(e),
          toolName: e.tool,
          conversationId: e.conversation_id,
          intent: e.intent,
          intentSource: e.intent ? "context_parameter" : undefined,
          llmModel: e.llm_model,
          llmModelSource: e.llm_model ? (e.llm_model_source ?? "self_reported") : undefined,
          // parameters / response intentionally omitted (G1): the SDK sends neither property.
          durationMs: e.ms,
          isError,
          error: isError ? new Error(`Tool ${e.tool} failed: ${e.err_code ?? "tool_error"}`) : undefined,
          errorType: isError ? (e.err_code ?? "tool_error") : undefined,
          properties: {
            $mcp_input_keys: e.input_keys,
            $mcp_client_name: e.client_name,
            $mcp_client_version: e.client_version,
            $mcp_server_name: "scry",
            scry_request_id: e.request_id,
            scry_project_id: e.project_id,
            scry_response_bytes: e.response_bytes,
            scry_missing_capability: e.missing_capability,
            scry_event_schema: e.schema,
            scry_env: e.env,
          },
        });
        if (e.missing_capability) {
          c.captureMissingCapability({
            ...common(e),
            conversationId: e.conversation_id,
            context: e.intent,
            llmModel: e.llm_model,
            llmModelSource: e.llm_model ? (e.llm_model_source ?? "self_reported") : undefined,
            properties: {
              $mcp_client_name: e.client_name,
              $mcp_client_version: e.client_version,
              scry_request_id: e.request_id,
              scry_env: e.env,
            },
          });
        }
      });
    },
    initialize(e: McpInitializeEvent) {
      return send(c => {
        c.captureInitialize({
          ...common(e),
          clientName: e.client_name,
          clientVersion: e.client_version,
          properties: { $mcp_server_name: "scry", scry_event_schema: e.schema, scry_env: e.env },
        });
      });
    },
    toolsList(e: McpToolsListEvent) {
      return send(c => {
        c.captureToolsList({
          ...common(e),
          toolNames: e.tool_names,
          properties: {
            $mcp_client_name: e.client_name,
            $mcp_client_version: e.client_version,
            $mcp_server_name: "scry",
            scry_tool_count: e.tool_count,
            scry_event_schema: e.schema,
            scry_env: e.env,
          },
        });
      });
    },
  };
}
