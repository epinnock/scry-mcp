/**
 * Transport headers for every worker call to the search API (scry-nextjs).
 *
 * `Authorization` carries the shared service key. `x-vercel-protection-bypass`
 * is added only when `SCRY_SEARCH_API_BYPASS_TOKEN` is set: the staging search
 * API is a Vercel preview behind Deployment Protection, which answers a bare
 * server-to-server request with a login page, and Vercel's automation bypass
 * token is how a trusted client gets through. Production has no token and sends
 * no such header, so its requests are unchanged; the API's own key check and
 * the signed caller assertion apply in both environments.
 */
export interface SearchApiHeaderEnv {
  SCRY_SEARCH_API_KEY: string;
  SCRY_SEARCH_API_BYPASS_TOKEN?: string;
}

export function searchApiHeaders(
  env: SearchApiHeaderEnv,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.SCRY_SEARCH_API_KEY}`,
    ...extra,
  };
  const bypass = env.SCRY_SEARCH_API_BYPASS_TOKEN?.trim();
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  return headers;
}
