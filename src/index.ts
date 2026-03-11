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
});
