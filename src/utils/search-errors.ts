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
