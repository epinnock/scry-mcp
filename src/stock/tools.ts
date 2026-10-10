/**
 * search_stock (feature stock-metasearch, delivery step 4): live search of free stock libraries (Pixabay,
 * Unsplash, Openverse; Pexels when enabled) through the scry-stock Worker. Registered only when
 * STOCK_TOOLS_ENABLED="1" (stage first; production unset until the feature's Gate B).
 *
 * Privacy (G7): the query is the user's words. It goes to the stock service in the POST body and nowhere
 * else: no log line, no analytics event, no Sentry tag, and the analytics `context` / `conversation_id`
 * arguments are NOT added to this tool (NO_AGENT_ARGS_TOOLS in lib/tool-request.ts), because an intent
 * sentence would restate the query. Nothing from a provider is stored (G2).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  STOCK_DEFAULT_LIMIT,
  STOCK_MAX_LIMIT,
  STOCK_MAX_QUERY_LENGTH,
  STOCK_NO_PROVIDER_FAILURE,
  STOCK_PROVIDERS,
  STOCK_TYPES,
  formatStock,
  noProviderAnswered,
  type StockFailure,
  type StockResult,
} from "./format";

export const STOCK_TOOL_NAME = "search_stock";

export interface StockToolContext {
  /** Calls the stock service; never throws. */
  call: (body: Record<string, unknown>) => Promise<{ ok: true; result: StockResult } | { ok: false; failure: StockFailure }>;
  /** The existing 60 req/min/user limiter; true when the call may proceed. */
  checkRateLimit: () => boolean;
  /** Usage data point (tool, env, uid only). */
  log: (tool: string, data: Record<string, unknown>) => void;
}

function errorResult(f: StockFailure) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: f.code, message: f.message, retryable: f.retryable, ...f.detail }) }],
    isError: true,
  };
}

export function registerStockTools(server: McpServer, ctx: StockToolContext): void {
  server.registerTool(
    STOCK_TOOL_NAME,
    {
      title: "Search free stock pictures",
      description: [
        "Search free stock libraries (Pixabay, Unsplash, Openverse) for photos, illustrations and vectors, for example to suggest hero art, an empty-state illustration or a placeholder photo in a design.",
        "This searches public stock libraries, NOT the user's own Scry screens: for their screenshots and components use search_components.",
        "Each result has provider, title, creditLine, creditParts, pageUrl, providerUrl, previewUrl, type, licenseLabel and licenseUrl, plus the status of every provider and the provider notices.",
        "You MUST show the creditLine with every picture you suggest, exactly as given in the text result with its links (the same parts are in creditParts), and link to its pageUrl: pictures open on the provider's site, where the user downloads them under the stated licence. Show the provider notices that come with the result, such as the Openverse line (made with Openverse, not endorsed or certified by Openverse).",
        "Do not download, store or re-upload the pictures, and do not use them to train or fine-tune a model.",
        "Nothing is saved in Scry and the search words are not logged.",
        "Errors (JSON {error, message, retryable}): RATE_LIMITED, VALIDATION_ERROR, STOCK_TIMEOUT, STOCK_UNREACHABLE, STOCK_SERVICE_ERROR, STOCK_PROVIDERS_UNAVAILABLE, SERVER_MISCONFIGURED. A failure here never affects Scry's own search.",
      ].join(" "),
      inputSchema: {
        query: z.string().trim().min(1).max(STOCK_MAX_QUERY_LENGTH).describe("What to look for, 1-200 characters, for example \"empty state illustration\" or \"dashboard hero photo\"."),
        type: z.enum(STOCK_TYPES).optional().describe("Restrict to photo, illustration or vector."),
        provider: z.enum(STOCK_PROVIDERS).optional().describe("Search one provider only. Default: all enabled providers."),
        limit: z.number().int().min(1).max(STOCK_MAX_LIMIT).optional().describe(`Target number of results, 1-${STOCK_MAX_LIMIT} (default ${STOCK_DEFAULT_LIMIT}); each provider returns at least 3, so you may get more.`),
      },
      annotations: { title: "Search free stock pictures", readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ query, type, provider, limit }) => {
      ctx.log(STOCK_TOOL_NAME, {}); // one MCP_USAGE data point per call: tool, env and uid only
      if (!ctx.checkRateLimit()) {
        return errorResult({ code: "RATE_LIMITED", message: "Too many requests. Please wait a moment and try again.", retryable: true });
      }
      const body: Record<string, unknown> = { query, limit: limit ?? STOCK_DEFAULT_LIMIT };
      if (type) body.type = type;
      if (provider) body.providers = [provider];
      const res = await ctx.call(body);
      if (!res.ok) return errorResult(res.failure);
      if (res.result.items.length === 0 && noProviderAnswered(res.result)) return errorResult(STOCK_NO_PROVIDER_FAILURE);
      const { text, structured } = formatStock(res.result);
      return { content: [{ type: "text" as const, text }], structuredContent: structured };
    },
  );
}
