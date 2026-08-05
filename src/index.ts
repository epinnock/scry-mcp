import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { ScryMCP } from "./mcp";
import { FirebaseAuthHandler } from "./firebase-handler";

export { ScryMCP };

export default new OAuthProvider({
  apiHandlers: {
    "/sse": ScryMCP.serveSSE("/sse"),
    "/mcp": ScryMCP.serve("/mcp"),
    // --- Health / readiness endpoint ---
    // Returns server version and status. Useful for uptime monitoring,
    // deploy verification, and client capability checks.
    "/health": {
      fetch: async () =>
        Response.json({
          status: "ok",
          server: "scry-mcp",
          version: "1.0.0",
          timestamp: new Date().toISOString(),
        }),
    } as ExportedHandler<Env> & Pick<Required<ExportedHandler<Env>>, "fetch">,
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
});
