/**
 * The six issue-resolution tools (feature issue-resolution, delivery item 6).
 *
 * An agent lists drift issues a human has promoted, reads one with everything
 * it needs for either arena (Figma node or source files), claims a side, records
 * a fix (PR URL or Figma version) and asks Scry to verify. All calls go to the
 * dashboard's `/api/agent/issues/*`, which checks membership and role and writes
 * the audit fields (`actor_kind: "agent"`, `agent_client`, `who`) itself.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiResult, DashboardAgentClient, SlidingWindowLimiter } from "./client";
import { formatIssue, formatList, formatVerify, formatWrite, mapApiError } from "./format";

export const ISSUE_WRITE_RATE_LIMIT_RPM = 30;
const MAX_INLINE_IMAGE_BYTES = 3 * 1024 * 1024;

export interface IssueToolContext {
  /** Null when the dashboard URL or signing secret is not configured. */
  client: () => DashboardAgentClient | null;
  /** The existing 60 req/min/user limiter; true when the call may proceed. */
  checkRateLimit: () => boolean;
  /** 30 writes/min/user. */
  writeLimiter: SlidingWindowLimiter;
  log: (tool: string, data: Record<string, unknown>) => void;
  fetchImpl?: typeof fetch;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function errorResult(code: string, message: string, retryable: boolean, detail: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: code, message, retryable, ...detail }) }], isError: true };
}

const SIDE = z.enum(["code", "design"]);
const ISSUE_ID = z.number().int().positive().describe("Scry issue id (issue_id from list_design_issues, not the #number).");
const PROJECT_ID = z.string().min(1).max(128);

const ERRORS_DOC = [
  "Errors (JSON {error, message, retryable}): NOT_FOUND (no such promoted issue in a project you can access),",
  "FORBIDDEN (viewer role), FORBIDDEN_FOR_AGENTS, CLAIMED (another holder; includes claimed_by, claim_expires_at),",
  "FIX_SIDE_UNDECIDED, SIDE_NOT_REQUIRED, CONFLICT, RATE_LIMITED / WRITE_RATE_LIMITED (retry later).",
].join(" ");

export function registerIssueTools(server: McpServer, ctx: IssueToolContext): void {
  /** Shared guard + call + error mapping. */
  async function run(
    tool: string,
    write: boolean,
    call: (c: DashboardAgentClient) => Promise<ApiResult>,
    render: (data: Record<string, unknown>) => Promise<ToolResult> | ToolResult,
    logData: Record<string, unknown>,
  ): Promise<ToolResult> {
    ctx.log(tool, logData);
    if (!ctx.checkRateLimit()) return errorResult("RATE_LIMITED", "Too many requests. Please wait a moment and try again.", true);
    if (write && !ctx.writeLimiter.take()) {
      return errorResult("WRITE_RATE_LIMITED", `At most ${ISSUE_WRITE_RATE_LIMIT_RPM} issue writes per minute per user. Wait and retry.`, true, { retry_after_seconds: ctx.writeLimiter.retryAfterSeconds() });
    }
    const client = ctx.client();
    if (!client) {
      return errorResult("SERVER_MISCONFIGURED", "The Scry MCP server is not configured for issue tools (SCRY_DASHBOARD_API_URL or SCRY_AGENT_ASSERTION_SECRET missing). Ask the operator.", false);
    }
    const start = Date.now();
    let res: ApiResult;
    try {
      res = await call(client);
    } catch (err) {
      const timeout = err instanceof Error && err.name === "AbortError";
      ctx.log(`${tool}:error`, { error: timeout ? "timeout" : String(err), latencyMs: Date.now() - start });
      if (String(err).includes("SCRY_AGENT_ASSERTION_SECRET")) {
        return errorResult("SERVER_MISCONFIGURED", "The Scry MCP server cannot sign its caller assertion (SCRY_AGENT_ASSERTION_SECRET is not set). Ask the operator.", false);
      }
      return errorResult(timeout ? "TIMEOUT" : "DASHBOARD_UNREACHABLE", timeout ? "The Scry dashboard did not answer in time." : "Could not reach the Scry dashboard.", true);
    }
    if (!res.ok) {
      ctx.log(`${tool}:error`, { status: res.status, upstream: res.body.error, latencyMs: Date.now() - start });
      const m = mapApiError(res.status, res.body);
      return errorResult(m.code, m.message, m.retryable, m.detail);
    }
    return render(res.data);
  }

  const text = (t: string, data: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text: t }], structuredContent: data });

  // --- list_design_issues ---
  server.registerTool(
    "list_design_issues",
    {
      title: "List design drift issues",
      description: [
        "List design-drift issues (Figma vs Storybook mismatches) that a human has already promoted in a Scry project.",
        "Returns issue_id, #number, severity, status (open | fixed_awaiting_verify | closed), fix_side (code | design | both | undecided: where a human decided the fix belongs),",
        "per-side resolution status (todo | in_progress | fixed | verified; * = claimed), the screen/link, story id and Figma node.",
        "Unpromoted AI candidates and dismissed issues are never returned. Typical loop: list with status=[\"open\"] and fix_side=[\"code\"] (or design),",
        "then get_design_issue(issue_id), claim_design_issue, fix, mark_design_issue_fixed, request_verify.",
        "Use assignee=\"me\" for issues assigned to you, changed_since (ISO time) to poll for changes, cursor for the next page.",
        ERRORS_DOC,
      ].join(" "),
      inputSchema: {
        project_id: PROJECT_ID.describe("Scry project id."),
        link_id: z.string().max(128).optional().describe("Only issues on this Figma↔Storybook link (screen)."),
        figma_file_key: z.string().max(128).optional(),
        figma_node_id: z.string().max(128).optional(),
        story_id: z.string().max(256).optional(),
        fix_side: z.array(z.enum(["code", "design", "both", "undecided"])).max(4).optional(),
        status: z.array(z.enum(["open", "fixed_awaiting_verify", "closed"])).max(3).optional().describe("Default: all promoted statuses."),
        side_status: z.array(z.enum(["todo", "in_progress", "fixed", "verified"])).max(4).optional(),
        severity: z.array(z.string().max(32)).max(8).optional(),
        assignee: z.literal("me").optional(),
        changed_since: z.string().datetime({ offset: true }).optional(),
        cursor: z.string().max(128).optional(),
        limit: z.number().int().min(1).max(100).optional().describe("Default 50, max 100."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => run(
      "list_design_issues", false,
      c => c.list({ ...args, limit: args.limit ?? 50 }),
      data => text(formatList(data), data),
      { project_id: args.project_id },
    ),
  );

  // --- get_design_issue ---
  server.registerTool(
    "get_design_issue",
    {
      title: "Get a design drift issue",
      description: [
        "Everything an agent needs to fix one promoted drift issue, in either arena.",
        "Returns: the note, severity, status, fix_side and the AI hint; per-side tracks (status, claim, ref, last verdict);",
        "design: figma_file_key, figma_node_id, node name, Figma deep link, file version, layer subtree, Figma crop + box;",
        "code: story id/title, component_file, story_file, repository, build id/sha/branch, Storybook URL, Storybook crop + box;",
        "expected vs actual value when known; last re-check verdict; recent timeline; and how to fix each side.",
        "images: crops (default) inlines both crops, full inlines both full screenshots, none returns text only.",
        "Code fix: edit the files in your checkout and open a PR. Design fix: use Figma's own MCP with the file key and node id (Scry never writes to Figma).",
        "Pass issue_id, or project_id + number (#number shown in the dashboard).",
        ERRORS_DOC,
      ].join(" "),
      inputSchema: {
        issue_id: ISSUE_ID.optional(),
        project_id: PROJECT_ID.optional(),
        number: z.number().int().positive().optional().describe("The issue #number within project_id."),
        images: z.enum(["none", "crops", "full"]).optional(),
        max_width: z.number().int().min(64).max(2048).optional().describe("Resize inlined images to at most this width."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      if (!args.issue_id && !(args.project_id && args.number)) {
        return errorResult("INVALID_ARGUMENT", "Pass issue_id, or project_id and number.", false);
      }
      const images = args.images ?? "crops";
      return run(
        "get_design_issue", false,
        c => args.issue_id
          ? c.get(args.issue_id, { images, max_width: args.max_width })
          : c.getByNumber(args.project_id!, args.number!, { images, max_width: args.max_width }),
        async data => {
          const out: ToolResult = { content: [{ type: "text", text: formatIssue(data) }], structuredContent: data };
          if (images !== "none") out.content.push(...(await inlineImages(data, ctx.fetchImpl ?? fetch)));
          return out;
        },
        { issue_id: args.issue_id, project_id: args.project_id, number: args.number, images },
      );
    },
  );

  // --- claim_design_issue ---
  server.registerTool(
    "claim_design_issue",
    {
      title: "Claim one side of a drift issue",
      description: [
        "Claim the code or design side of a promoted issue before working on it, so other agents and people see it is taken.",
        "Moves that side to in_progress for a 15-minute lease; call again to renew while you work, or release: true to give it back.",
        "Fails with CLAIMED (claimed_by, claim_expires_at) when someone else holds it, FIX_SIDE_UNDECIDED when no human chose code/design yet,",
        "SIDE_NOT_REQUIRED when the issue does not need that side. Returns the issue status and all tracks.",
        ERRORS_DOC,
      ].join(" "),
      inputSchema: { issue_id: ISSUE_ID, side: SIDE, release: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => run(
      "claim_design_issue", true,
      c => c.claim(args.issue_id, { side: args.side, ...(args.release ? { release: true } : {}) }),
      data => text(formatWrite(args.release ? `Released the ${args.side} side` : `Claimed the ${args.side} side (15-min lease)`, data), data),
      { issue_id: args.issue_id, side: args.side, release: !!args.release },
    ),
  );

  // --- mark_design_issue_fixed ---
  server.registerTool(
    "mark_design_issue_fixed",
    {
      title: "Record a fix for one side",
      description: [
        "Record that you fixed the code or design side of a promoted issue. The side becomes fixed (awaiting verify) and your claim is cleared;",
        "it does not close the issue — Scry verifies it by re-checking the next input (code: next Storybook build; design: next Figma render).",
        "Code: ref_url = the pull request URL (ref_kind pr, default) or ref_kind commit with a commit sha.",
        "Design: ref_url = Figma version link (ref_kind figma_version, default), a numeric Figma version id, or ref_kind synced with no URL.",
        "Returns the tracks and a verify_hint saying what will verify it. Then call request_verify to re-check now.",
        ERRORS_DOC,
      ].join(" "),
      inputSchema: {
        issue_id: ISSUE_ID,
        side: SIDE,
        ref_url: z.string().max(500).optional().describe("PR URL, commit sha, Figma version link or id."),
        ref_kind: z.enum(["pr", "commit", "figma_version", "synced", "other"]).optional(),
        note: z.string().max(2000).optional().describe("What you changed, shown on the issue timeline."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      if (!args.ref_url && args.ref_kind !== "synced") {
        return errorResult("INVALID_ARGUMENT", "A fix needs a reference: ref_url (PR URL, commit sha, Figma version) or ref_kind \"synced\" for a design side.", false);
      }
      return run(
        "mark_design_issue_fixed", true,
        c => c.markFixed(args.issue_id, { side: args.side, ref_url: args.ref_url, ref_kind: args.ref_kind, note: args.note }),
        data => text(formatWrite(`Marked the ${args.side} side fixed`, data), data),
        { issue_id: args.issue_id, side: args.side, ref_kind: args.ref_kind },
      );
    },
  );

  // --- request_verify ---
  server.registerTool(
    "request_verify",
    {
      title: "Ask Scry to verify a fix",
      description: [
        "Ask Scry to re-check an issue (issue_id) or every open issue on one screen (project_id + link_id) against the newest inputs.",
        "side design: Scry pulls the node's current render from Figma first (when the file version moved). side code: re-checks if a Storybook build newer than the fix exists.",
        "Returns verdicts (matches | still_drifts with a reason), which tracks moved (matches → verified; still_drifts → back to todo),",
        "what is still waiting for new input, and the remaining quota. A re-check is free but capped at 20 per project per hour and 200 per day (VERIFY_RATE_LIMITED).",
        "rediff: true runs a full new comparison instead: 10 AI credits from the project's organisation wallet (INSUFFICIENT_CREDITS when short). Use it only when asked.",
        "When nothing new can be judged it returns ran: false and spends no quota.",
        ERRORS_DOC,
      ].join(" "),
      inputSchema: {
        issue_id: ISSUE_ID.optional(),
        project_id: PROJECT_ID.optional(),
        link_id: z.string().max(128).optional(),
        side: SIDE.optional(),
        rediff: z.boolean().optional().describe("Full re-diff, 10 credits. Default false (free re-check)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      if (!args.issue_id && !(args.project_id && args.link_id)) {
        return errorResult("INVALID_ARGUMENT", "Pass issue_id, or project_id and link_id.", false);
      }
      const body = { ...(args.side ? { side: args.side } : {}), ...(args.rediff ? { rediff: true } : {}) };
      return run(
        "request_verify", true,
        c => args.issue_id
          ? c.requestVerify(args.issue_id, body)
          : c.requestVerifyLink({ project_id: args.project_id!, link_id: args.link_id!, ...body }),
        data => text(formatVerify(data), data),
        { issue_id: args.issue_id, link_id: args.link_id, side: args.side, rediff: !!args.rediff },
      );
    },
  );

  // --- comment_design_issue ---
  server.registerTool(
    "comment_design_issue",
    {
      title: "Comment on a drift issue",
      description: [
        "Add a comment to a promoted issue's timeline (shown as your agent acting for you).",
        "propose_fix_side (code | design | both) suggests where the fix belongs when a human has not decided or you think the decision is wrong; it does not change fix_side — a human does.",
        "Use it to explain a fix, report why you could not fix it, or ask a question. Returns the stored event.",
        ERRORS_DOC,
      ].join(" "),
      inputSchema: {
        issue_id: ISSUE_ID,
        body: z.string().min(1).max(4000),
        propose_fix_side: z.enum(["code", "design", "both"]).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => run(
      "comment_design_issue", true,
      c => c.comment(args.issue_id, { body: args.body, ...(args.propose_fix_side ? { propose_fix_side: args.propose_fix_side } : {}) }),
      data => text(`Comment added to issue_id ${args.issue_id}${args.propose_fix_side ? ` (proposed fix side: ${args.propose_fix_side})` : ""}.`, data),
      { issue_id: args.issue_id, propose: args.propose_fix_side },
    ),
  );
}

/** Inline the design/code images the dashboard returned (base64 data, or a short-lived https URL). */
export async function inlineImages(
  data: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>> {
  const out: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  for (const [label, sideKey] of [["Figma (design)", "design"], ["Storybook (code)", "code"]] as const) {
    const side = data[sideKey] as Record<string, unknown> | undefined;
    const img = side?.image as Record<string, unknown> | undefined;
    if (!img) continue;
    if (typeof img.data === "string" && img.data) {
      out.push({ type: "text", text: `${label} image:` }, { type: "image", data: img.data, mimeType: typeof img.mime_type === "string" ? img.mime_type : "image/png" });
      continue;
    }
    if (typeof img.url !== "string" || !img.url.startsWith("https://")) continue;
    try {
      const res = await fetchImpl(img.url, { signal: AbortSignal.timeout(10_000) });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !type.startsWith("image/")) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_INLINE_IMAGE_BYTES) continue;
      out.push({ type: "text", text: `${label} image:` }, { type: "image", data: toBase64(buf), mimeType: type.split(";")[0] });
    } catch {
      // The URL is already in the text; a failed inline is not an error.
    }
  }
  return out;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
