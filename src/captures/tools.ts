/**
 * The four snip-capture tools (feature snip-capture, delivery item 5): latest_capture, get_capture,
 * list_captures and delete_capture. All calls go to the dashboard's `/api/agent/captures/*` with the
 * signed X-Scry-Caller of the same hop the issue tools use; the dashboard enforces who may read a
 * snip (owner, or an audience the owner turned on) and answers a bare "not found" for anything else.
 *
 * Privacy (G6): no log line here carries a capture id, note, app name or URL; the per-call request line
 * (tool-request.ts) is built from a fixed allow-list. Signed URLs exist only in the tool result.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiResult, DashboardAgentClient, SlidingWindowLimiter } from "../issues/client";
import { confirmProjectAccess } from "../lib/tool-request";
import {
  CAPTURE_AGENT_IMAGE,
  CAPTURE_WRITE_RATE_LIMIT_RPM,
  LATEST_DEFAULT_MAX_AGE_MINUTES,
  LATEST_MAX_AGE_MINUTES,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
} from "./constants";
import { CAPTURE_NOT_FOUND_MESSAGE, captureNotReady, formatCapture, formatList, mapCaptureError } from "./format";

export interface CaptureToolContext {
  /** Null when the dashboard URL or signing secret is not configured. */
  client: () => DashboardAgentClient | null;
  /** The existing 60 req/min/user limiter; true when the call may proceed. */
  checkRateLimit: () => boolean;
  /** Limits delete_capture. */
  writeLimiter: SlidingWindowLimiter;
  /** Diagnostics: fixed words, status and latency only (see the file header). */
  log: (tool: string, data: Record<string, unknown>) => void;
  fetchImpl?: typeof fetch;
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Content[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function errorResult(code: string, message: string, retryable: boolean, detail: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: code, message, retryable, ...detail }) }], isError: true };
}

const PROJECT_ID = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
/**
 * A capture id is the short `cap_xxxx` display form or the UUID the app mints. Anything else (notably
 * `latest`, which is a route of its own on the dashboard) is refused here, before any call.
 */
const CAPTURE_ID = z.string().min(4).max(64).regex(
  /^(cap_[A-Za-z0-9_-]{1,60}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
  "A capture id, as printed by Scry (for example cap_7k3f). For the newest snip call latest_capture instead.",
);

const ERRORS_DOC = [
  "Errors (JSON {error, message, retryable}): CAPTURE_NOT_FOUND (no such capture that you may see; do not retry),",
  "CAPTURE_STALE (the newest capture is older than the freshness window; ask the user), AMBIGUOUS_PROJECT (pass project_id),",
  "CAPTURE_NOT_READY (still uploading; try once more after a few seconds), CAPTURE_NOT_OWNER (delete is owner-only), RATE_LIMITED.",
].join(" ");

export function registerCaptureTools(server: McpServer, ctx: CaptureToolContext): void {
  /** Shared guard + call + error mapping. `render` may be async (it fetches the picture). */
  async function run(
    tool: string,
    write: boolean,
    call: (c: DashboardAgentClient) => Promise<ApiResult>,
    render: (data: Record<string, unknown>) => Promise<ToolResult> | ToolResult,
  ): Promise<ToolResult> {
    ctx.log(tool, {}); // one MCP_USAGE data point per call: tool, env and uid only (no capture id, no note)
    if (!ctx.checkRateLimit()) return errorResult("RATE_LIMITED", "Too many requests. Please wait a moment and try again.", true);
    if (write && !ctx.writeLimiter.take()) {
      return errorResult("WRITE_RATE_LIMITED", `At most ${CAPTURE_WRITE_RATE_LIMIT_RPM} capture deletes per minute per user. Wait and retry.`, true, { retry_after_seconds: ctx.writeLimiter.retryAfterSeconds() });
    }
    const client = ctx.client();
    if (!client) {
      return errorResult("SERVER_MISCONFIGURED", "The Scry MCP server is not configured for capture tools (SCRY_DASHBOARD_API_URL or SCRY_AGENT_ASSERTION_SECRET missing). Ask the operator.", false);
    }
    const start = Date.now();
    let res: ApiResult;
    try {
      res = await call(client);
    } catch (err) {
      const timeout = err instanceof Error && err.name === "AbortError";
      ctx.log(`${tool}:error`, { error: timeout ? "timeout" : "unreachable", latencyMs: Date.now() - start });
      if (String(err).includes("SCRY_AGENT_ASSERTION_SECRET")) {
        return errorResult("SERVER_MISCONFIGURED", "The Scry MCP server cannot sign its caller assertion (SCRY_AGENT_ASSERTION_SECRET is not set). Ask the operator.", false);
      }
      return errorResult(timeout ? "TIMEOUT" : "DASHBOARD_UNREACHABLE", timeout ? "The Scry dashboard did not answer in time." : "Could not reach the Scry dashboard.", true);
    }
    if (!res.ok) {
      ctx.log(`${tool}:error`, { status: res.status, latencyMs: Date.now() - start });
      const m = mapCaptureError(res.status, res.body);
      return errorResult(m.code, m.message, m.retryable, m.detail);
    }
    return render(res.data);
  }

  /** The dashboard enforced access, so the request line may now name the project. */
  const confirm = (capture: Record<string, unknown> | undefined) => confirmProjectAccess(capture?.projectId);

  async function captureResult(capture: Record<string, unknown>): Promise<ToolResult> {
    confirm(capture);
    if (capture.status !== "ready") {
      const m = captureNotReady();
      return errorResult(m.code, m.message, m.retryable, m.detail);
    }
    const image = await fetchAgentImage(typeof capture.agentUrl === "string" ? capture.agentUrl : undefined, ctx.fetchImpl ?? fetch);
    const { text, structured } = formatCapture(capture, { imageAttached: image.ok, imageNote: image.ok ? undefined : image.reason });
    const content: Content[] = [{ type: "text", text }];
    if (image.ok) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
    return { content, structuredContent: structured };
  }

  // --- latest_capture ---
  server.registerTool(
    "latest_capture",
    {
      title: "Get the screenshot the user just snipped",
      description: [
        "Use this when the user says they just snipped, grabbed or screenshotted something with Scry Snip (\"fix the screenshot I just took\", \"look at my snip\").",
        "Returns the caller's OWN newest capture in one project: a text block first (capture id, how old it is, who took it, size), then the picture",
        `(WebP, long edge at most ${CAPTURE_AGENT_IMAGE.maxLongEdgePx} px) and a link to the full-resolution original that expires in one hour. State the id and age back to the user so they can confirm it is the right one.`,
        `Refuses a capture older than ${LATEST_DEFAULT_MAX_AGE_MINUTES} minutes (CAPTURE_STALE, with its id and age) unless maxAgeMinutes is raised, so a stale \"latest\" is never silent.`,
        "If the caller has recent captures in several projects and gives no project_id, it returns AMBIGUOUS_PROJECT listing them.",
        "Do not call this in a loop or to poll for new snips: call it once per user request, and on CAPTURE_STALE or CAPTURE_NOT_FOUND ask the user instead of retrying.",
        "It never returns captures other people shared with the caller; use list_captures with scope shared for those.",
        "Who took it is also in structuredContent as taken_by_label (\"you\", the author's name or \"another member\"), for clients that show only structuredContent.",
        ERRORS_DOC,
      ].join(" "),
      inputSchema: {
        project_id: PROJECT_ID.optional().describe("Scry project id. Needed only when the caller snips into more than one project."),
        maxAgeMinutes: z.number().int().min(1).max(LATEST_MAX_AGE_MINUTES).optional().describe(`Accept a capture up to this many minutes old. Default ${LATEST_DEFAULT_MAX_AGE_MINUTES}; max ${LATEST_MAX_AGE_MINUTES}. Raise it only after the user confirmed an older snip is the one they mean.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => run(
      "latest_capture", false,
      c => c.captureLatest({ project_id: args.project_id, within_minutes: args.maxAgeMinutes }),
      async data => {
        const capture = data.capture as Record<string, unknown> | undefined;
        return capture ? captureResult(capture) : errorResult("DASHBOARD_API_BAD_SHAPE", "The dashboard answered without a capture.", true);
      },
    ),
  );

  // --- get_capture ---
  server.registerTool(
    "get_capture",
    {
      title: "Get one Scry capture by id",
      description: [
        "Fetch one Scry Snip capture by its id (for example from \"Look at Scry capture cap_7k3f\", from CAPTURE_STALE, or from list_captures).",
        "Works for the caller's own captures and for captures someone shared with the caller, while they stay shared.",
        "Returns a text block first (id, age, who took it, size, the note if any), then the picture (WebP, long edge at most",
        `${CAPTURE_AGENT_IMAGE.maxLongEdgePx} px) when it fits the inline budget, and a link to the full-resolution original that expires in one hour.`,
        "Who took it is also in structuredContent as taken_by_label (\"you\", the author's name or \"another member\"), for clients that show only structuredContent.",
        "A capture that does not exist and one you may not see give the same CAPTURE_NOT_FOUND; do not retry it and do not guess other ids.",
        ERRORS_DOC,
      ].join(" "),
      inputSchema: {
        capture_id: CAPTURE_ID,
        project_id: PROJECT_ID.optional().describe("Optional: the project the capture lives in (speeds up the lookup)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => run(
      "get_capture", false,
      c => c.captureGet(args.capture_id, { project_id: args.project_id }),
      async data => {
        const capture = data.capture as Record<string, unknown> | undefined;
        return capture ? captureResult(capture) : errorResult("CAPTURE_NOT_FOUND", CAPTURE_NOT_FOUND_MESSAGE, false);
      },
    ),
  );

  // --- list_captures ---
  server.registerTool(
    "list_captures",
    {
      title: "List Scry captures",
      description: [
        "List Scry Snip captures, newest first, as text (works in clients that do not show images): id, project, age, who took it, size.",
        "scope mine (default): the caller's own captures. scope shared: captures other people shared with the caller.",
        "Pass project_id to stay inside one project. Without it, shared captures are read from at most 50 of the caller's projects; when that applies",
        "the result says so (projectsTruncated and a note) and project_id reads the rest. Pages: pass before (from the result's \"More\" line) for older ones.",
        "Each structuredContent item has taken_by_label (\"you\", the author's name or \"another member\"), for clients that show only structuredContent.",
        "To see a picture call get_capture with its id; to get the newest own snip use latest_capture.",
        ERRORS_DOC,
      ].join(" "),
      inputSchema: {
        scope: z.enum(["mine", "shared"]).optional().describe("mine (default) or shared (shared with the caller by someone else)."),
        project_id: PROJECT_ID.optional(),
        limit: z.number().int().min(1).max(LIST_MAX_LIMIT).optional().describe(`Default ${LIST_DEFAULT_LIMIT}, max ${LIST_MAX_LIMIT}.`),
        before: z.number().int().min(1).optional().describe("Page cursor: the nextBefore value of the previous page."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const scope = args.scope ?? "mine";
      return run(
        "list_captures", false,
        c => c.captureList({ scope, project_id: args.project_id, limit: args.limit ?? LIST_DEFAULT_LIMIT, before: args.before }),
        data => {
          const first = (data.captures as Array<Record<string, unknown>> | undefined)?.[0];
          confirm(first);
          const { text, structured } = formatList(data, scope);
          return { content: [{ type: "text", text }], structuredContent: structured };
        },
      );
    },
  );

  // --- delete_capture ---
  server.registerTool(
    "delete_capture",
    {
      title: "Delete one of your Scry captures",
      description: [
        "Permanently delete a capture the caller took: the original, the pictures, the record and any share link are removed everywhere, and it cannot be undone.",
        "Owner only: a capture that was merely shared with the caller returns CAPTURE_NOT_OWNER and nothing changes.",
        "Only call this when the user explicitly asked to delete that capture; never to tidy up. Returns a confirmation that names the capture id.",
        ERRORS_DOC,
      ].join(" "),
      inputSchema: {
        capture_id: CAPTURE_ID,
        project_id: PROJECT_ID.optional().describe("Optional: the project the capture lives in."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => run(
      "delete_capture", true,
      c => c.captureDelete(args.capture_id, { project_id: args.project_id }),
      data => ({
        content: [{ type: "text", text: `Deleted Scry capture ${args.capture_id}. The original, its pictures and any share link are gone; it cannot be recovered.` }],
        structuredContent: { deleted: true, capture_id: args.capture_id, objects_removed: typeof data.objects === "number" ? data.objects : null },
      }),
    ),
  );
}

type ImageFetch = { ok: true; data: string; mimeType: string } | { ok: false; reason: string };

/** Fetch the stored agent rendition and inline it when it fits the budget. Never throws; a miss is just link-only. */
export async function fetchAgentImage(url: string | undefined, fetchImpl: typeof fetch): Promise<ImageFetch> {
  if (!url) return { ok: false, reason: "this capture has no agent picture yet" };
  if (!url.startsWith("https://")) return { ok: false, reason: "no https picture link" };
  const budget = CAPTURE_AGENT_IMAGE.inlineMaxBytes;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(CAPTURE_AGENT_IMAGE.fetchTimeoutMs) });
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!res.ok) return { ok: false, reason: "the picture could not be fetched" };
    if (!type.startsWith("image/")) return { ok: false, reason: "the picture could not be fetched" };
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > budget) return { ok: false, reason: tooBig() };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > budget) return { ok: false, reason: tooBig() };
    return { ok: true, data: toBase64(buf), mimeType: type };
  } catch {
    return { ok: false, reason: "the picture could not be fetched" };
  }
}

const tooBig = () => `larger than the ${Math.round(CAPTURE_AGENT_IMAGE.inlineMaxBytes / 1000)} KB inline budget`;

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
