declare namespace Cloudflare {
  interface Env {
    OAUTH_KV: KVNamespace;
    OAUTH_PROVIDER: OAuthProvider;
    MCP_OBJECT: DurableObjectNamespace;
    FIREBASE_API_KEY: string;
    FIREBASE_AUTH_DOMAIN: string;
    FIREBASE_PROJECT_ID: string;
    SCRY_SEARCH_API_URL: string;   // Base URL for the Scry Next.js search API (e.g. https://scry.example.com)
    SCRY_SEARCH_API_KEY: string;   // API key for authenticating to the search API
    COOKIE_ENCRYPTION_KEY: string;
  }
}

interface Env extends Cloudflare.Env {}
