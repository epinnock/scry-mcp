/**
 * Mapping from an upstream search API status to the error code and retry hint
 * returned to the model.
 *
 * The code and the retryable flag are the entire basis on which an agent
 * decides whether to give up, re-authenticate, or try again — so getting 429
 * or 503 wrong means agents either hammer a struggling upstream or abandon a
 * request that would have worked.
 */
export interface SearchApiError {
  code: string;
  retryable: boolean;
}

export function classifySearchApiError(status: number): SearchApiError {
  if (status === 401) return { code: "AUTH_REQUIRED", retryable: false };
  if (status === 403) return { code: "ACCESS_DENIED", retryable: false };
  if (status === 429) return { code: "UPSTREAM_RATE_LIMITED", retryable: true };
  // 5xx is transient by assumption; every other 4xx is the caller's fault and
  // will fail again identically.
  return { code: `SEARCH_API_${status}`, retryable: status >= 500 };
}

/**
 * The search API now returns machine-readable codes alongside its message
 * (`{error, code}` — e.g. `project_has_no_org`, `invalid_scope`,
 * `project_required`, `invalid_caller_assertion`). Surface them verbatim, in
 * this server's UPPER_SNAKE convention, so an agent can branch on them
 * instead of on a generic SEARCH_API_400.
 *
 * Returns undefined for a body that is not JSON, has no `code`, or whose code
 * is not a plain identifier — the status-derived code then stands.
 */
export function upstreamErrorCode(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as { code?: unknown };
    const code = parsed?.code;
    if (typeof code !== "string") return undefined;
    if (!/^[a-z][a-z0-9_]{0,63}$/i.test(code)) return undefined;
    return code.toUpperCase();
  } catch {
    return undefined;
  }
}
