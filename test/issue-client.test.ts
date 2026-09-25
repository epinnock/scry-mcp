import { describe, expect, it } from "vitest";
import { SlidingWindowLimiter, agentClientLabel } from "../src/issues/client";
import { mapApiError } from "../src/issues/format";

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
