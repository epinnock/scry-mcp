import * as Sentry from "@sentry/cloudflare";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { ScryMCP } from "./mcp";
import { FirebaseAuthHandler } from "./firebase-handler";

export { ScryMCP };

/**
 * Wrapped in Sentry so unhandled failures in the MCP surface somewhere other
 * than a Workers log tail, which cannot be read after the fact.
 *
 * Bodies are deliberately not collected. Requests here carry the developer's
 * search queries, which are customer intellectual property — the component
 * names they are looking for describe their unreleased product. Error context
 * is worth having; the query text is not worth shipping to a third party.
 */
export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    release: env.SENTRY_RELEASE,
    dataCollection: { httpBodies: [] },
  }),
  new OAuthProvider({
  apiHandlers: {
    "/sse": ScryMCP.serveSSE("/sse"),
    "/mcp": ScryMCP.serve("/mcp"),
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
