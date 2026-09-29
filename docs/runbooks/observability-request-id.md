# Runbook: request ids in the MCP server

Two ids, never joined. Knowing which one you hold decides where you look.

| | Edge id | Tool id |
|---|---|---|
| Minted | once per HTTP request, at the Worker entry (`src/lib/edge-request.ts`) | once per tool call, in the tool wrapper (`src/lib/tool-request.ts`) |
| Where a user sees it | `x-scry-request-id` response header, on every response | inside the tool result (error bodies carry `"request_id"`) |
| Log line | one `msg:"request"` line, `route` = a fixed pattern (`/mcp`, `/sse/message`, `/token`, ..., `unmatched`), status, ms, `client` | one `msg:"request"` line, `route` = the tool name, status, ms, `project`, `uid_hash`; no `client` |
| Also on | nothing else | forwarded on every downstream hop (search, dashboard issue API, credits ledger), so those services log the same id |

An inbound `x-scry-request-id` is ignored for both. The edge never reads or changes a request body, so a tool call
inside an MCP request cannot learn the edge id.

## Why they are not joined

One MCP HTTP request can carry several tool calls (a JSON-RPC batch, or parallel calls on one session), and the
transport hands each message to the Durable Object over a WebSocket without the request headers. Carrying the edge
id into the message meant rewriting the request body on the core `/mcp` path, which was removed on purpose: the edge
must not touch bodies. A tool call has its own id instead.

## From a user-visible id to the trail

1. The user reports a tool id (from a tool error body or the tool result): run
   `scry-management/scripts/scry-logs.py --request-id <tool id>`. You get the tool line (tool name, status, ms,
   project, `uid_hash`) followed by the downstream search / credits lines that share that id.
2. The user reports the `x-scry-request-id` response header (for example from a failed `/token` or a 401 on `/mcp`):
   the same command returns the edge line only (route, status, ms, client). There is no tool line under that id.
3. To get from an edge line to the tool calls it carried, use time: tool lines with `uid_hash` of the caller
   whose `ts` falls inside the edge line's `ts` .. `ts + ms` window (for `/mcp` streaming the edge `ms` is time to
   response headers, so widen the window).

## Not a bug

- Two `msg:"request"` lines for one tool call (one edge line, one tool line) with different ids.
- A `client` on the edge line but not on the tool line.
- `unmatched` routes: paths outside the fixed table are never logged raw.
