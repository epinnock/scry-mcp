import { clientOf } from "./log";
import { REQUEST_ID_HEADER } from "./request-id";

/**
 * Streamable HTTP delivers messages to the Durable Object over a WebSocket, so the request's headers never
 * reach the tool handlers. Pass the (validated) `x-scry-client` to the session's object first, for the request
 * line's `client` field. Best effort with a short bound: never fails or delays the request (log-standardization).
 */
export function withClientNote<H extends { fetch: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> | Response }>(handler: H): H {
  return {
    ...handler,
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
      try {
        const client = clientOf(request.headers.get("x-scry-client"));
        // The edge (src/lib/edge-request.ts) overwrote this header with the id it minted; an id from
        // any other path is not trusted, so only a well-formed ULID is passed on.
        const rid = request.headers.get(REQUEST_ID_HEADER);
        const requestId = rid && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(rid) ? rid : undefined;
        const sessionId = request.headers.get("mcp-session-id");
        if ((client || requestId) && sessionId && /^[0-9a-f]{64}$/.test(sessionId)) {
          const stub = env.MCP_OBJECT.get(env.MCP_OBJECT.idFromName(`streamable-http:${sessionId}`)) as unknown as {
            noteClient(value: string | undefined, requestId?: string): Promise<void>;
          };
          await Promise.race([stub.noteClient(client, requestId), new Promise(resolve => setTimeout(resolve, 250))]);
        }
      } catch {
        // Logging metadata only.
      }
      return handler.fetch(request, env, ctx);
    },
  };
}
