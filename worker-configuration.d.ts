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
    GEMINI_API_KEY: string;        // Google Gemini API key for image generation
    COOKIE_ENCRYPTION_KEY: string;
    DEV_BYPASS_AUTH?: string;
    /** Optional. When unset, Sentry initialises as a no-op rather than failing. */
    SENTRY_DSN?: string;
    ASSETS: Fetcher;
  }
}

interface Env extends Cloudflare.Env {}
