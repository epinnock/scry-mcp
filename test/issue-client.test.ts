import { describe, expect, it } from "vitest";
import { SlidingWindowLimiter, agentClientLabel } from "../src/issues/client";
import { formatVerify, formatWrite, mapApiError, refLabelKind, tracksText } from "../src/issues/format";

describe("SlidingWindowLimiter", () => {
  it("allows `limit` hits per window and reports when the next one frees up", () => {
    const l = new SlidingWindowLimiter(2, 60_000);
    expect(l.take(0)).toBe(true);
    expect(l.take(1_000)).toBe(true);
    expect(l.take(2_000)).toBe(false);
    expect(l.retryAfterSeconds(2_000)).toBe(58);
    expect(l.take(60_001)).toBe(true);
  });
});

describe("agentClientLabel", () => {
  it("prefers the title, strips control characters and caps length", () => {
    expect(agentClientLabel({ name: "claude-code", title: "Claude Code" })).toBe("Claude Code");
    expect(agentClientLabel({ name: "x\u0000y\n" })).toBe("xy");
    expect(agentClientLabel({ name: "a".repeat(200) })).toHaveLength(80);
    expect(agentClientLabel(undefined)).toBe("MCP agent");
  });
});

describe("mapApiError", () => {
  it("maps the diff-service conflict codes an agent can act on", () => {
    expect(mapApiError(409, { error: "fix_side_undecided" }).code).toBe("FIX_SIDE_UNDECIDED");
    expect(mapApiError(409, { error: "side_not_required" }).code).toBe("SIDE_NOT_REQUIRED");
    const c = mapApiError(409, { error: "use_resolution_route", side_status: "verified", allowed_from: ["todo"] });
    expect(c.code).toBe("CONFLICT");
    expect(c.detail).toEqual({ side_status: "verified", allowed_from: ["todo"] });
    expect(mapApiError(400, { error: "bad_ref", detail: "ref_url must be http(s)" }).message).toContain("ref_url must be http(s)");
    expect(mapApiError(503, {}).retryable).toBe(true);
  });
});

describe("pre-ship fixes (Gate B UAT findings 2, 4, 5)", () => {
  it("labels a commit URL as Commit even when stored as pr; PR URLs PR; other links Link", () => {
    expect(refLabelKind("https://github.com/a/b/commit/fd2ac0b9", "pr")).toBe("Commit");
    expect(refLabelKind("https://github.com/a/b/pull/12", "pr")).toBe("PR");
    expect(refLabelKind("https://gitlab.com/a/b/-/merge_requests/3", undefined)).toBe("PR");
    expect(refLabelKind("https://linear.app/a/issue/X-1", "other")).toBe("Link");
    expect(refLabelKind("a41f9c2", "commit")).toBe("Commit");
    expect(refLabelKind(undefined, "synced")).toBe("Synced");
    expect(refLabelKind("https://x.io/y", "pr", "Commit")).toBe("Commit");
    const text = tracksText([{ side: "code", status: "fixed", ref_url: "https://github.com/a/b/commit/fd2ac0b9", ref_kind: "pr" }]);
    expect(text).toContain("ref Commit https://github.com/a/b/commit/fd2ac0b9");
    expect(text).not.toContain("ref pr");
  });

  it("shows the claim holder by name, not uid", () => {
    const text = tracksText([{ side: "code", status: "in_progress", claimed_by: "uid_ana", claimed_kind: "user", claimed_name: "Ana Ruiz", claim_expires_at: "2026-09-25T10:00:00Z" }]);
    expect(text).toContain("claimed by Ana Ruiz (dashboard)");
    expect(text).not.toContain("uid_ana");
    const err = mapApiError(409, { error: "claimed", claimed_by: "uid_bo", claimed_kind: "user", claimed_name: "Bo", claim_expires_at: "t" });
    expect(err.code).toBe("CLAIMED");
    expect(err.message).toContain("claimed by Bo");
    expect(err.detail).toMatchObject({ claimed_by: "uid_bo", claimed_name: "Bo" });
    expect(formatWrite("Claimed", { issue: { id: 1, number: 2, status: "open" }, resolution: [] })).toContain("issue #2");
  });

  it("request_verify always says why nothing ran, and notes a screen-level recheck", () => {
    expect(formatVerify({ ran: false, reason: "nothing_to_judge", reason_detail: "no box and no note" })).toContain("No re-check ran — nothing_to_judge: no box and no note");
    expect(formatVerify({ ran: false })).toContain("No re-check ran — no new input");
    const ran = formatVerify({ ran: true, run_id: "r1", verdicts: [{ id: 7, verdict: "matches" }], notes: ["issue 7 has no box — screen-level recheck from its note"] });
    expect(ran).toContain("issue 7: matches");
    expect(ran).toContain("note: issue 7 has no box — screen-level recheck");
  });
});
