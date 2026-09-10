import { describe, it, expect } from "vitest";
import { classifySearchApiError, upstreamErrorCode } from "../src/utils/search-errors";

/**
 * The code and retryable flag are the whole basis on which an agent decides to
 * give up, re-authenticate, or try again. Getting 429 or 503 wrong means agents
 * either hammer a struggling upstream or abandon a request that would have
 * worked — and mcp.test.ts asserted this with expect(true).toBe(true).
 */
describe("classifySearchApiError", () => {
  it("treats an auth failure as terminal", () => {
    expect(classifySearchApiError(401)).toEqual({
      code: "AUTH_REQUIRED",
      retryable: false,
    });
  });

  it("treats a permission failure as terminal", () => {
    expect(classifySearchApiError(403)).toEqual({
      code: "ACCESS_DENIED",
      retryable: false,
    });
  });

  it("marks upstream rate limiting retryable", () => {
    expect(classifySearchApiError(429)).toEqual({
      code: "UPSTREAM_RATE_LIMITED",
      retryable: true,
    });
  });

  it.each([500, 502, 503, 504])("marks %i retryable", (status) => {
    const { code, retryable } = classifySearchApiError(status);
    expect(code).toBe(`SEARCH_API_${status}`);
    expect(retryable).toBe(true);
  });

  // A malformed request fails identically on retry; retrying only wastes turns.
  it.each([400, 404, 422])("marks %i non-retryable", (status) => {
    const { code, retryable } = classifySearchApiError(status);
    expect(code).toBe(`SEARCH_API_${status}`);
    expect(retryable).toBe(false);
  });
});

/**
 * The search API returns its own machine-readable code beside the message
 * (ISSUES.md #45: invalid_scope, project_has_no_org, project_required,
 * invalid_caller_assertion). An agent can act on those; it cannot act on a
 * bare SEARCH_API_400.
 */
describe("upstreamErrorCode", () => {
  it("lifts the API's code into this server's UPPER_SNAKE convention", () => {
    expect(upstreamErrorCode(JSON.stringify({ error: "…", code: "project_has_no_org" }))).toBe("PROJECT_HAS_NO_ORG");
    expect(upstreamErrorCode(JSON.stringify({ code: "invalid_scope" }))).toBe("INVALID_SCOPE");
  });

  it("returns undefined when the body carries no usable code", () => {
    expect(upstreamErrorCode("Internal Server Error")).toBeUndefined();
    expect(upstreamErrorCode(JSON.stringify({ error: "nope" }))).toBeUndefined();
    expect(upstreamErrorCode(JSON.stringify({ code: 42 }))).toBeUndefined();
    expect(upstreamErrorCode("")).toBeUndefined();
  });

  // The code is interpolated into a tool error the model reads. Keep it to an
  // identifier so an upstream cannot smuggle prose or markup through it.
  it("rejects codes that are not plain identifiers", () => {
    expect(upstreamErrorCode(JSON.stringify({ code: "bad code with spaces" }))).toBeUndefined();
    expect(upstreamErrorCode(JSON.stringify({ code: "<script>" }))).toBeUndefined();
    expect(upstreamErrorCode(JSON.stringify({ code: "x".repeat(65) }))).toBeUndefined();
  });
});
