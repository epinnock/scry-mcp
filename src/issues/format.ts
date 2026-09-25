/**
 * Text rendering for the issue tools. Agents read `content[0].text`, so every
 * id, status and next step the agent needs has to be in the text itself; the
 * same data is also returned as `structuredContent` for programmatic clients.
 */

type Json = Record<string, unknown>;

const s = (v: unknown): string | undefined => (typeof v === "string" && v.length ? v : typeof v === "number" ? String(v) : undefined);
const obj = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(x => x && typeof x === "object") as Json[] : []);

/** Map a dashboard error onto the tool error shape `{error, message, retryable, ...detail}`. */
export function mapApiError(status: number, body: Json): { code: string; message: string; retryable: boolean; detail: Json } {
  const upstream = s(body.error) ?? "";
  const detail: Json = {};
  for (const k of ["claimed_by", "claimed_kind", "claimed_name", "claim_expires_at", "side_status", "allowed_from", "retry_after_seconds", "window", "limit", "quota", "needed", "available", "stage"]) {
    if (body[k] !== undefined) detail[k] = body[k];
  }
  const said = s(body.detail) ?? s(body.message);
  const tail = said ? ` (${said})` : "";
  switch (status) {
    case 400:
      return { code: "INVALID_ARGUMENT", message: `Scry rejected the request: ${upstream || "bad request"}${tail}.`, retryable: false, detail };
    case 401:
      return { code: "SERVER_MISCONFIGURED", message: "The dashboard did not accept this MCP server's caller assertion. Ask the Scry operator to check SCRY_AGENT_ASSERTION_SECRET on both services.", retryable: false, detail };
    case 402:
      return { code: "INSUFFICIENT_CREDITS", message: `The project's organisation does not have enough AI credits for a full re-diff (10 credits)${tail}. Run request_verify without rediff (free) or top up credits.`, retryable: false, detail };
    case 403:
      return upstream === "forbidden_for_agents"
        ? { code: "FORBIDDEN_FOR_AGENTS", message: `Agents cannot do this; a human decides it in the Scry dashboard${tail}. You can propose a change with comment_design_issue.`, retryable: false, detail }
        : { code: "FORBIDDEN", message: `Your role on this project does not allow this (viewers are read-only)${tail}.`, retryable: false, detail };
    case 404:
      return { code: "NOT_FOUND", message: "No such issue in a project you can access. Agents only see issues a human has promoted (open, awaiting verify or closed).", retryable: false, detail };
    case 409: {
      if (upstream === "claimed") {
        // The holder is a uid; a claim by your own user (in the dashboard or another agent session) is never CLAIMED.
        const who = s(body.claimed_name) ?? "another user";
        return { code: "CLAIMED", message: `This side is claimed by ${who} (${s(body.claimed_kind) === "agent" ? "their agent" : "in the dashboard"}) until ${s(body.claim_expires_at) ?? "the lease expires"}. Pick another issue or try after the lease ends.`, retryable: true, detail };
      }
      if (upstream === "fix_side_undecided") {
        return { code: "FIX_SIDE_UNDECIDED", message: "No human has decided whether this is fixed in code or in design yet. Propose a side with comment_design_issue(propose_fix_side) and wait for a human.", retryable: false, detail };
      }
      if (upstream === "side_not_required") {
        return { code: "SIDE_NOT_REQUIRED", message: "This issue does not need a fix on that side. Check fix_side with get_design_issue.", retryable: false, detail };
      }
      return { code: "CONFLICT", message: `The issue is not in a state that allows this: ${upstream || "conflict"}${tail}. Re-read it with get_design_issue.`, retryable: false, detail };
    }
    case 429: {
      const after = s(body.retry_after_seconds);
      return { code: upstream === "verify_rate_limited" ? "VERIFY_RATE_LIMITED" : "UPSTREAM_RATE_LIMITED", message: `Verification limit reached for this project (20 per hour, 200 per day)${after ? `; retry in ${after}s` : ""}.`, retryable: true, detail };
    }
    default:
      return { code: `DASHBOARD_API_${status}`, message: `The Scry dashboard returned ${status}${upstream ? ` ${upstream}` : ""}.`, retryable: status >= 500, detail };
  }
}

const COMMIT_PATH = /\/(?:-\/)?commits?\/[0-9a-f]{7,40}(?:\/|$)/i;
const PR_PATH = /\/(?:pull|pulls|pull-requests)\/\d+(?:\/|$)|\/-\/merge_requests\/\d+(?:\/|$)/i;

/**
 * What a fix reference opens: "PR" | "Commit" | "Figma version" | "Synced" | "Link".
 * From the URL first, so a commit URL stored as "pr" (before the diff-service
 * fix) still reads "Commit". The dashboard's ref_label_kind wins when present.
 */
export function refLabelKind(url: string | undefined, kind: string | undefined, given?: string): string | undefined {
  if (given) return given;
  if (kind === "synced") return "Synced";
  if (!url) return undefined;
  if (kind === "figma_version") return "Figma version";
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return /^[0-9a-f]{7,40}$/i.test(url) || kind === "commit" ? "Commit" : "Link";
  }
  if (COMMIT_PATH.test(path)) return "Commit";
  if (PR_PATH.test(path)) return "PR";
  return "Link";
}

function trackLine(t: Json): string {
  const parts = [`${s(t.side) ?? "?"}: ${s(t.status) ?? "?"}`];
  if (s(t.claimed_by)) {
    parts.push(`claimed by ${s(t.claimed_name) ?? "a user"}${s(t.claimed_kind) === "agent" ? " (agent)" : " (dashboard)"} until ${s(t.claim_expires_at) ?? "?"}`);
  }
  const refKind = refLabelKind(s(t.ref_url), s(t.ref_kind), s(t.ref_label_kind));
  if (refKind === "Synced") parts.push("ref Synced from Scry Link");
  else if (s(t.ref_url)) parts.push(`ref ${refKind ?? "Link"} ${s(t.ref_url)}`);
  if (s(t.last_verdict)) parts.push(`last verdict ${s(t.last_verdict)}${s(t.last_verdict_reason) ? ` — ${s(t.last_verdict_reason)}` : ""}`);
  return parts.join(" · ");
}

export function tracksText(resolution: unknown): string {
  const ts = arr(resolution);
  return ts.length ? ts.map(t => `  - ${trackLine(t)}`).join("\n") : "  - none (fix side undecided: legacy single-status issue)";
}

export function formatList(data: Json): string {
  const issues = arr(data.issues);
  const lines = [`${issues.length} issue(s)${s(data.next_cursor) ? ` · more with cursor=${s(data.next_cursor)}` : ""}`];
  for (const i of issues) {
    const where = [s(i.pair_name) && `screen "${s(i.pair_name)}"`, s(i.link_id) && `link ${s(i.link_id)}`, s(i.story_id) && `story ${s(i.story_id)}`, s(i.figma_node_id) && `Figma ${s(i.figma_file_key) ?? "?"}:${s(i.figma_node_id)}`].filter(Boolean).join(", ");
    const sides = arr(i.resolution).map(t => `${s(t.side)}=${s(t.status)}${s(t.claimed_by) ? "*" : ""}`).join(" ");
    lines.push(`- issue_id ${s(i.id) ?? s(i.issue_id)} (#${s(i.number) ?? "?"}) [${s(i.severity) ?? "no severity"}] ${s(i.status)} · fix in ${s(i.fix_side) ?? "undecided"}${sides ? ` · ${sides}` : ""}\n  ${(s(i.note) ?? "").slice(0, 200)}${where ? `\n  ${where}` : ""}`);
  }
  if (issues.length) lines.push("(* = side claimed) Next: get_design_issue(issue_id) for crops, files, Figma node and how to fix.");
  return lines.join("\n");
}

export const HOW_TO_FIX = {
  code: "Fix in code: open component_file / story_file in your own checkout of the repository, change the code so the Storybook render matches the Figma crop, open a pull request, then call mark_design_issue_fixed(side: \"code\", ref_url: <PR URL>). Scry verifies on the next Storybook upload for this project (a PR preview build counts); request_verify(side: \"code\") re-checks now if a newer build already exists.",
  design: "Fix in design: use Figma's own MCP / plugin API (e.g. use_figma) on figma_file_key + figma_node_id to change the node to the expected value (Scry never writes to Figma), then call mark_design_issue_fixed(side: \"design\", ref_url: <Figma version link> or ref_kind: \"synced\") and request_verify(side: \"design\"): Scry pulls the new render from Figma and re-checks.",
};

export function formatIssue(data: Json): string {
  const issue = obj(data.issue) ?? {};
  const design = obj(data.design) ?? {};
  const code = obj(data.code) ?? {};
  const expected = obj(data.expected);
  const last = obj(data.last_recheck);
  const hint = obj(data.verify_hint);
  const fixSide = s(issue.fix_side) ?? "undecided";
  const out: string[] = [];
  out.push(`Issue #${s(issue.number) ?? "?"} (issue_id ${s(issue.id) ?? "?"}) · ${s(issue.status)} · severity ${s(issue.severity) ?? "none"} · fix in ${fixSide}`);
  if (s(issue.note)) out.push(`Note: ${s(issue.note)}`);
  if (s(issue.suggested_fix_side)) out.push(`AI hint (not authoritative): ${s(issue.suggested_fix_side)}${s(issue.suggested_fix_side_reason) ? ` — ${s(issue.suggested_fix_side_reason)}` : ""}`);
  if (expected) out.push(`Expected (from ${s(expected.from) ?? "?"}): ${s(expected.property) ?? "?"} = ${s(expected.value) ?? "?"}${s(expected.actual) ? `; actual ${s(expected.actual)}` : ""}`);
  out.push(`Project ${s(data.project_id) ?? "?"} · link ${s(data.link_id) ?? "?"}${s(data.dashboard_url) ? ` · ${s(data.dashboard_url)}` : ""}`);
  out.push(`Resolution tracks:\n${tracksText(data.resolution)}`);
  if (hint) out.push(`Verify: ${Object.entries(hint).map(([k, v]) => `${k} — ${s(v) ?? JSON.stringify(v)}`).join("; ")}`);
  if (last) out.push(`Last re-check: ${s(last.verdict)}${s(last.reason) ? ` — ${s(last.reason)}` : ""}${s(last.at) ? ` (${s(last.at)})` : ""}`);

  const box = (img: Json | undefined) => { const b = obj(img?.box); return b ? ` box {x:${s(b.x)}, y:${s(b.y)}, w:${s(b.w)}, h:${s(b.h)}} (0..1 of the full image)` : ""; };
  const dImg = obj(design.image);
  out.push([
    "Design (Figma):",
    design.actionable === false ? `  not actionable: ${s(design.reason) ?? "no Figma file key"}` : undefined,
    s(design.figma_file_key) && `  figma_file_key ${s(design.figma_file_key)} · figma_node_id ${s(design.figma_node_id) ?? "?"}${s(design.node_name) ? ` ("${s(design.node_name)}")` : ""}${s(design.page) ? ` on page ${s(design.page)}` : ""}`,
    s(design.figma_url) && `  ${s(design.figma_url)}`,
    s(design.figma_version) && `  file version ${s(design.figma_version)}`,
    dImg && `  crop:${box(dImg)}${s(dImg.url) ? ` ${s(dImg.url)}` : ""}`,
    design.layer_subtree != null && `  layer subtree: ${JSON.stringify(design.layer_subtree).slice(0, 4000)}`,
  ].filter(Boolean).join("\n"));
  const cImg = obj(code.image);
  out.push([
    "Code (Storybook):",
    s(code.story_id) && `  story ${s(code.story_id)}${s(code.story_title) ? ` ("${s(code.story_title)}")` : ""}`,
    s(code.component_file) && `  component_file ${s(code.component_file)}`,
    s(code.story_file) && `  story_file ${s(code.story_file)}`,
    s(code.repository) && `  repository ${s(code.repository)}`,
    (s(code.build_id) || s(code.build_sha)) && `  build ${[s(code.build_id), s(code.build_sha) && `sha ${s(code.build_sha)}`].filter(Boolean).join(" · ")}${s(code.branch) ? ` on ${s(code.branch)}` : ""}`,
    s(code.storybook_url) && `  ${s(code.storybook_url)}`,
    cImg && `  crop:${box(cImg)}${s(cImg.url) ? ` ${s(cImg.url)}` : ""}`,
    s(code.source_excerpt) && `  source excerpt:\n${s(code.source_excerpt)}`,
  ].filter(Boolean).join("\n"));

  const how = obj(data.how_to_fix);
  const sides = fixSide === "both" ? ["code", "design"] : fixSide === "code" || fixSide === "design" ? [fixSide] : [];
  if (sides.length) {
    out.push("How to fix:");
    for (const side of sides) out.push(`  ${s(how?.[side]) ?? HOW_TO_FIX[side as "code" | "design"]}`);
  } else {
    out.push("How to fix: a human has not decided the side yet. Propose one with comment_design_issue(propose_fix_side); claim and mark fixed only work once fix_side is set.");
  }
  const tl = arr(data.timeline);
  if (tl.length) {
    out.push("Timeline (latest last):");
    for (const e of tl.slice(-10)) {
      const a = obj(e.actor) ?? {};
      const p = obj(e.payload);
      const who = s(a.agent_client)
        ? `${s(a.agent_client)} (for ${s(p?.actor_name) ?? s(a.id) ?? "?"})`
        : s(a.name) ?? s(p?.actor_name) ?? `${s(a.kind) ?? "?"}`;
      out.push(`  ${s(e.at) ?? ""} ${s(e.type)} by ${who}`);
    }
  }
  return out.join("\n");
}

export function formatWrite(verb: string, data: Json): string {
  const issue = obj(data.issue) ?? {};
  const lines = [`${verb} · issue #${s(issue.number) ?? "?"} (issue_id ${s(issue.id) ?? "?"}) is now ${s(issue.status) ?? "?"}`, `Tracks:\n${tracksText(data.resolution)}`];
  const hint = obj(data.verify_hint);
  if (hint) lines.push(`Verify: ${Object.entries(hint).map(([k, v]) => `${k} — ${s(v) ?? JSON.stringify(v)}`).join("; ")}`);
  return lines.join("\n");
}

export function formatVerify(data: Json): string {
  const lines: string[] = [];
  if (data.ran === false) {
    // The Worker always says why (no_new_input | nothing_to_judge | no_open_issues).
    const why = [s(data.reason), s(data.reason_detail)].filter(Boolean).join(": ");
    lines.push(`No re-check ran — ${why || "no new input"} (quota not spent).`);
  } else {
    lines.push(`Re-check ran${s(data.run_id) ? ` (run ${s(data.run_id)})` : ""}.`);
    for (const v of arr(data.verdicts)) lines.push(`  - issue ${s(v.issue_id) ?? s(v.id) ?? "?"}: ${s(v.verdict)}${s(v.reason) ? ` — ${s(v.reason)}` : ""}`);
    for (const n of Array.isArray(data.notes) ? data.notes : []) if (s(n)) lines.push(`  note: ${s(n)}`);
    const moved = obj(data.tracks_moved);
    if (moved) for (const [id, m] of Object.entries(moved)) lines.push(`  - issue ${id} tracks moved: ${arr(m).map(x => `${s(x.side)}→${s(x.to)}`).join(", ")}`);
  }
  for (const w of arr(data.waiting)) lines.push(`  waiting: issue ${s(w.issue_id)} ${s(w.side) ?? ""} ${s(w.status) ?? ""}${s(w.hint) ? ` — ${s(w.hint)}` : ""}`);
  const dr = obj(data.design_refresh);
  if (dr) lines.push(`Design refresh: ${dr.refreshed ? `new Figma render (version ${s(dr.version) ?? "?"})` : `not refreshed${s(dr.reason) ? ` — ${s(dr.reason)}` : ""}`}`);
  const rd = obj(data.rediff);
  if (rd) lines.push(`Full re-diff: ${JSON.stringify(rd).slice(0, 300)}`);
  const quota = obj(data.quota);
  const hr = obj(quota?.hour);
  const day = obj(quota?.day);
  if (hr || day) lines.push(`Verify quota left: ${s(hr?.remaining) ?? "?"}/hour, ${s(day?.remaining) ?? "?"}/day`);
  if (data.resolution) lines.push(`Tracks:\n${tracksText(data.resolution)}`);
  lines.push("Scry records verdicts; an agent never declares an issue verified itself.");
  return lines.join("\n");
}
