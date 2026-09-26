/**
 * Sentry options for the MCP Worker and its Durable Object (feature
 * observability-request-id). One builder so the fetch handler and the Durable
 * Object report with the same environment, release and scrubbing.
 *
 * - `environment` is the tier (`SCRY_ENV`: staging | production), so stage events
 *   no longer land unlabelled next to production ones.
 * - Bodies are never collected: requests carry the developer's search queries,
 *   which describe their unreleased product.
 * - No DSN (stage until one is set) → the SDK is a no-op and nothing changes.
 * - Console lines never become breadcrumbs. Tool code runs inside the
 *   instrumented Durable Object, and its diagnostic lines carry the raw Firebase
 *   uid and upstream error text (Gemini's can quote the prompt). The request
 *   line and Workers Logs already hold what an operator needs.
 */
import { scrubBreadcrumb, scrubEvent } from "./sentry-scrub";

export interface SentryEnv {
  SENTRY_DSN?: string;
  SENTRY_RELEASE?: string;
  SCRY_ENV?: string;
}

/** Drop console breadcrumbs; scrub every other breadcrumb (fetch URLs etc.). */
export function beforeBreadcrumb(crumb: any): any {
  if (crumb?.category === "console") return null;
  return scrubBreadcrumb(crumb);
}

export function sentryOptions(env: SentryEnv) {
  return {
    dsn: env.SENTRY_DSN || undefined,
    release: env.SENTRY_RELEASE,
    environment: env.SCRY_ENV || "unknown",
    sendDefaultPii: false,
    dataCollection: { userInfo: false, httpBodies: [] as never[] },
    beforeSend: scrubEvent,
    beforeBreadcrumb,
    initialScope: { tags: { service: "scry-mcp" } },
  };
}
