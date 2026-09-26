import * as Sentry from "@sentry/cloudflare";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { ScryMCP as ScryMCPAgent } from "./mcp";
import { FirebaseAuthHandler } from "./firebase-handler";
import { sentryOptions } from "./lib/sentry-options";

/**
 * The Durable Object that runs the tools, instrumented so a tool call that
 * throws reaches Sentry tagged with its `request_id` (src/lib/tool-request.ts).
 * Before this, Sentry wrapped only the front Worker and never saw a tool error.
 * The binding looks the class up by this export name.
 */
export const ScryMCP = Sentry.instrumentDurableObjectWithSentry(
  (env: Env) => sentryOptions(env),
  ScryMCPAgent as never,
) as unknown as typeof ScryMCPAgent;

/**
 * Wrapped in Sentry so unhandled failures in the MCP surface somewhere other
 * than a Workers log tail, which cannot be read after the fact.
 *
 * Bodies are deliberately not collected. Requests here carry the developer's
 * search queries, which are customer intellectual property — the component
 * names they are looking for describe their unreleased product. Error context
 * is worth having; the query text is not worth shipping to a third party.
 * Options (environment = SCRY_ENV, sendDefaultPii off, scrubber) are in
 * src/lib/sentry-options.ts.
 */
export default Sentry.withSentry(
  (env: Env) => sentryOptions(env),
  new OAuthProvider({
  apiHandlers: {
    "/sse": ScryMCPAgent.serveSSE("/sse"),
    "/mcp": ScryMCPAgent.serve("/mcp"),
  },
  defaultHandler: FirebaseAuthHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  // Claude Code authenticates with a Client ID Metadata Document URL
  // (client_id=https://claude.ai/oauth/claude-code-client-metadata) rather than
  // registering dynamically. CIMD was implicit before workers-oauth-provider
  // 0.8.0 and is opt-in from 0.8.0 on; without this the client is looked up in
  // KV, never found, and /authorize fails with an opaque 500.
  // Requires the 'global_fetch_strictly_public' compatibility flag (set in wrangler.jsonc).
    clientIdMetadataDocumentEnabled: true,
  }) as unknown as ExportedHandler<Env>,
);
