import { describe, it, expect } from "vitest";
import { classifySearchApiError } from "../src/utils/search-errors";

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
