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
 */
import { scrubBreadcrumb, scrubEvent } from "./sentry-scrub";

export interface SentryEnv {
  SENTRY_DSN?: string;
  SENTRY_RELEASE?: string;
  SCRY_ENV?: string;
}

export function sentryOptions(env: SentryEnv) {
  return {
    dsn: env.SENTRY_DSN || undefined,
    release: env.SENTRY_RELEASE,
    environment: env.SCRY_ENV || "unknown",
    sendDefaultPii: false,
    dataCollection: { userInfo: false, httpBodies: [] as never[] },
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
    initialScope: { tags: { service: "scry-mcp" } },
  };
}
