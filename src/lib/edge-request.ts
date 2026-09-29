/**
 * Edge request id for EVERY response of the Worker (log-standardization G3, defect F32).
 *
 * Wraps the whole fetch entry, before OAuth/Durable Object routing:
 * - always mints a fresh ULID and ignores any inbound `x-scry-request-id` (contract "Trust rule": MCP faces
 *   end users and API clients; the rejected value is never echoed or logged);
 * - overwrites the header on the request handed downstream; the request BODY is never read or modified (an MCP
 *   tool call inside the request mints its own tool id, which is not joined to the edge id);
 * - sets `x-scry-request-id` on every response (errors, redirects, OAuth and well-known routes, SSE) by
 *   touching headers only; bodies and streams are never read or replaced;
 * - writes one schema-v1 request line (route pattern, status, ms, client from the `x-scry-client` header).
 *
 * Fail-open (G4): nothing here may fail, change or delay a request. A handler that throws still throws.
 */
import { REQUEST_ID_HEADER, mintRequestId } from "./request-id";
import { clientOf, getLogger, type LogEnv } from "./log";

const FIXED_ROUTES = new Set([
  "/mcp", "/sse", "/sse/message", "/authorize", "/token", "/register", "/callback", "/health", "/healthz",
]);

/** A route pattern from a fixed table; anything else is `unmatched`. Never the raw path or query. */
export function edgeRoute(pathname: string): string {
  const p = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (FIXED_ROUTES.has(p)) return p;
  if (p.startsWith("/.well-known/")) return "/well-known/*";
  return "unmatched";
}

function pathOf(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "";
  }
}

/** The request handed downstream: only the headers change (`x-scry-request-id` overwritten). The body is never read. */
function forwarded(request: Request, id: string): Request {
  try {
    const headers = new Headers(request.headers);
    headers.set(REQUEST_ID_HEADER, id);
    return new Request(request, { headers });
  } catch {
    return request;
  }
}

/** Set the id on the response headers; rebuild only when they are immutable. Bodies and streams pass through. */
function stamp(response: Response, id: string): Response {
  try {
    response.headers.set(REQUEST_ID_HEADER, id);
    return response;
  } catch {
    try {
      const copy = new Response(response.body, response);
      copy.headers.set(REQUEST_ID_HEADER, id);
      return copy;
    } catch {
      return response;
    }
  }
}

function logRequest(env: unknown, request: Request, id: string, status: number, start: number): void {
  try {
    getLogger(env as LogEnv).request({
      request_id: id,
      route: edgeRoute(pathOf(request)),
      status,
      ms: Math.max(0, Date.now() - start),
      client: clientOf(request.headers.get("x-scry-client")),
    });
  } catch {
    // Logging must never change the answer.
  }
}

export function withEdgeRequestId(handler: ExportedHandler<Env>): ExportedHandler<Env> {
  const inner = handler.fetch as (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;
  return {
    ...handler,
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
      const start = Date.now();
      let id: string;
      try {
        id = mintRequestId();
      } catch {
        return inner.call(handler, request, env, ctx);
      }
      let response: Response;
      try {
        response = await inner.call(handler, forwarded(request, id), env, ctx);
      } catch (err) {
        logRequest(env, request, id, 500, start);
        throw err;
      }
      logRequest(env, request, id, response.status, start);
      return stamp(response, id);
    },
  };
}
