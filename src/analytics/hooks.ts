/**
 * Protocol-level hooks for analytics (feature mcp-analytics). They observe requests; they never change a
 * response and never throw into the protocol layer.
 */
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type RawHandler = (request: unknown, extra: unknown) => Promise<unknown>;
type LowLevel = {
  _requestHandlers?: Map<string, RawHandler>;
  setRequestHandler(schema: unknown, handler: RawHandler): void;
};

/**
 * Call `onList(toolNames)` after every answered `tools/list`. Call once, after all tools are registered (the
 * SDK installs its own tools/list handler on the first registration). Reads the SDK's handler table, which is
 * not public API, so it returns false (and does nothing) if the table is not there.
 */
export function onToolsListed(server: McpServer, onList: (toolNames: string[]) => void): boolean {
  try {
    const low = server.server as unknown as LowLevel;
    const original = low._requestHandlers?.get("tools/list");
    if (!original) return false;
    low.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      const response = await original(request, extra);
      try {
        const tools = (response as { tools?: Array<{ name?: unknown }> } | undefined)?.tools ?? [];
        onList(tools.map(t => (typeof t?.name === "string" ? t.name : "")).filter(Boolean));
      } catch {
        // Observing the list must never change it.
      }
      return response;
    });
    return true;
  } catch {
    return false;
  }
}
