/**
 * Edge request id for EVERY response of the Worker (log-standardization G3, defect F32).
 *
 * Wraps the whole fetch entry, before OAuth/Durable Object routing:
 * - always mints a fresh ULID and ignores any inbound `x-scry-request-id` (contract "Trust rule": MCP faces
 *   end users and API clients; the rejected value is never echoed or logged);
 * - overwrites the header on the request handed downstream and writes the id (and validated client) into
 *   `params._meta` of each `tools/call` message, so the tool call's line carries the SAME id as the edge line
 *   with no shared per-session state and no extra Durable Object call (see carryInMessage);
 * - sets `x-scry-request-id` on every response (errors, redirects, OAuth and well-known routes, SSE) by
 *   touching headers only; bodies and streams are never read or replaced;
 * - writes one schema-v1 request line (route pattern, status, ms, client from `x-scry-client`).
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

/** Keys the edge writes into `params._meta` of every `tools/call` message; the tool wrapper reads them. */
export const META_REQUEST_ID = "scry/request_id";
export const META_CLIENT = "scry/client";

const MAX_BODY_BYTES = 4 * 1024 * 1024; // the agents transports reject anything larger themselves

/**
 * Carry the id WITH the message. Streamable HTTP hands each JSON-RPC message to the Durable Object over a
 * WebSocket (headers are dropped), and SSE messages arrive as separate POSTs on a shared session object, so
 * any per-session slot would swap ids between overlapping calls. `params._meta` travels with the one message
 * and reaches the tool handler as `extra._meta`: no shared state, no extra Durable Object call.
 * Every `tools/call` in the body (single or batch) gets THIS request's id and validated client; a value the
 * caller put there is overwritten (or removed from other messages), so a caller cannot choose the id.
 * Returns the body text to forward, or undefined to leave the request untouched.
 */
export function carryInMessage(text: string, id: string, client: string | undefined): string | undefined {
  if (!text.includes("_meta") && !text.includes("tools/call")) return undefined;
  const parsed: unknown = JSON.parse(text);
  const changed = (Array.isArray(parsed) ? parsed : [parsed]).map(msg => stampMessage(msg, id, client));
  return changed.includes(true) ? JSON.stringify(parsed) : undefined;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** `_meta` of a message's params, created when asked. */
function metaOf(msg: Obj, create: boolean): Obj | undefined {
  if (!isObj(msg.params)) {
    if (!create) return undefined;
    msg.params = {};
  }
  const params = msg.params as Obj;
  if (!isObj(params._meta)) {
    if (!create) return undefined;
    params._meta = {};
  }
  return params._meta as Obj;
}

/** Write (tools/call) or strip (anything else) the scry keys of one message; true when it changed. */
function stampMessage(msg: unknown, id: string, client: string | undefined): boolean {
  if (!isObj(msg)) return false;
  if (msg.method === "tools/call") {
    const meta = metaOf(msg, true) as Obj;
    meta[META_REQUEST_ID] = id;
    if (client) meta[META_CLIENT] = client;
    else delete meta[META_CLIENT];
    return true;
  }
  const meta = metaOf(msg, false);
  if (!meta || !(META_REQUEST_ID in meta || META_CLIENT in meta)) return false;
  delete meta[META_REQUEST_ID];
  delete meta[META_CLIENT];
  return true;
}

/** True for a JSON-RPC POST the edge should read (`/mcp`, `/sse/message`) and small enough for the transports. */
function carriesMessage(request: Request): boolean {
  const route = edgeRoute(pathOf(request));
  if (request.method !== "POST" || !request.body || (route !== "/mcp" && route !== "/sse/message")) return false;
  const declared = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  return !(declared > MAX_BODY_BYTES);
}

/** Body to forward for `text`: the message with the id carried in, or the text itself when there is nothing to add. */
function bodyWithId(text: string, request: Request, id: string): string {
  try {
    return carryInMessage(text, id, clientOf(request.headers.get("x-scry-client"))) ?? text;
  } catch {
    return text; // not JSON: the transport rejects it exactly as before
  }
}

/**
 * The request handed downstream: `x-scry-request-id` overwritten with the minted id and, for a JSON-RPC POST
 * on `/mcp` or `/sse/message`, the id and client carried in the message (see carryInMessage). Any failure
 * forwards the request as it was (body re-created from the text already read).
 */
async function forwarded(request: Request, id: string): Promise<Request> {
  let text: string | undefined;
  try {
    const headers = new Headers(request.headers);
    headers.set(REQUEST_ID_HEADER, id);
    if (!carriesMessage(request)) return new Request(request, { headers });
    text = await request.text();
    const body = bodyWithId(text, request, id);
    if (headers.has("content-length")) headers.set("content-length", String(new TextEncoder().encode(body).byteLength));
    return new Request(request.url, { method: request.method, headers, body });
  } catch {
    if (text !== undefined) {
      try {
        return new Request(request.url, { method: request.method, headers: request.headers, body: text });
      } catch {
        // fall through
      }
    }
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
        response = await inner.call(handler, await forwarded(request, id), env, ctx);
      } catch (err) {
        logRequest(env, request, id, 500, start);
        throw err;
      }
      logRequest(env, request, id, response.status, start);
      return stamp(response, id);
    },
  };
}
