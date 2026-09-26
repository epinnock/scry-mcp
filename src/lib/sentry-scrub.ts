/**
 * Redaction for anything sent to error reporting.
 *
 * Copied from scry-build-processing-service/src/sentry-scrub.ts (feature
 * observability-request-id: one scrubber shape across services), extended with
 * the header names this Worker handles: the signed caller assertion, the grant
 * token, the AI Gateway token, the Gemini key and the Vercel bypass token.
 *
 * Vendored rather than shared. There is no common package across these repos.
 */

/** Header names whose values must never be sent, compared case-insensitively. */
const SENSITIVE_HEADERS = [
  "x-api-key",
  "authorization",
  "cookie",
  "x-cleanup-token",
  "x-scry-caller",
  "x-scry-grant-token",
  "cf-aig-authorization",
  "x-goog-api-key",
  "x-vercel-protection-bypass",
];

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Presigned URLs: keep the object path, drop the query string (a signature).
  [/(https?:\/\/[^\s?]+)\?[^\s]*/g, "$1?<redacted>"],
  [/scry_proj_[A-Za-z0-9_-]+/g, "scry_proj_<redacted>"],
  [/(X-Amz-Signature=)[^&\s]+/gi, "$1<redacted>"],
  [/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1<redacted>"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-<redacted>"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "AIza<redacted>"],
  // A compact JWT (the X-Scry-Caller assertion is one).
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<redacted-jwt>"],
];

export function scrubString(value: string): string {
  return SECRET_PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), value);
}

/**
 * Strip credentials from a Sentry event before it leaves the Worker. Loosely
 * typed on purpose: the SDK's event shape shifts between versions.
 */
 
export function scrubEvent(event: any): any {
  const request = event.request as { headers?: Record<string, string>; query_string?: unknown; data?: unknown; url?: string } | undefined;

  if (request?.headers) {
    for (const name of Object.keys(request.headers)) {
      if (SENSITIVE_HEADERS.includes(name.toLowerCase())) request.headers[name] = "<redacted>";
    }
  }

  // Bodies and query strings are never needed here, and both can carry search
  // queries (customer IP) or keys.
  if (request) {
    delete request.data;
    delete request.query_string;
    if (typeof request.url === "string") request.url = scrubString(request.url);
  }

  if (typeof event.message === "string") event.message = scrubString(event.message);

  for (const entry of event.exception?.values ?? []) {
    if (typeof entry.value === "string") entry.value = scrubString(entry.value);
  }

  if (event.extra) {
    for (const [key, value] of Object.entries(event.extra)) {
      if (typeof value === "string") event.extra[key] = scrubString(value);
    }
  }

  return event;
}

/** Breadcrumbs carry console lines and fetch URLs; scrub them the same way. */
 
export function scrubBreadcrumb(crumb: any): any {
  if (typeof crumb?.message === "string") crumb.message = scrubString(crumb.message);
  if (crumb?.data && typeof crumb.data === "object") {
    for (const [key, value] of Object.entries(crumb.data)) {
      if (typeof value === "string") crumb.data[key] = scrubString(value);
    }
  }
  return crumb;
}
