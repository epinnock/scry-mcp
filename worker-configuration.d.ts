declare namespace Cloudflare {
  interface Env {
    OAUTH_KV: KVNamespace;
    OAUTH_PROVIDER: OAuthProvider;
    MCP_OBJECT: DurableObjectNamespace;
    MCP_USAGE?: AnalyticsEngineDataset;
    FIREBASE_API_KEY: string;
    FIREBASE_AUTH_DOMAIN: string;
    FIREBASE_PROJECT_ID: string;
    SCRY_SEARCH_API_URL: string;   // Base URL for the Scry Next.js search API (e.g. https://scry.example.com)
    SCRY_SEARCH_API_KEY: string;   // API key for authenticating to the search API
    SCRY_SEARCH_API_BYPASS_TOKEN?: string; // Optional. Vercel automation bypass token for a protected (staging) search API; unset in production
    /**
     * Secret shared with scry-nextjs (its SCRY_CALLER_ASSERTION_SECRET) that
     * signs the X-Scry-Caller assertion carrying the user's uid. Optional in the
     * type because a worker can be deployed without it; the search tools then
     * fail closed with SERVER_MISCONFIGURED rather than searching anonymously.
     */
    SCRY_CALLER_ASSERTION_SECRET?: string;
    GEMINI_API_KEY: string;        // Google Gemini API key for image generation (sent as x-goog-api-key)
    /** Cloudflare AI Gateway root (https://gateway.ai.cloudflare.com/v1/<account>/<gateway>). Unset = direct to the provider (kill switch). */
    LLM_GATEWAY_URL?: string;
    /** AI Gateway Run token for the authenticated gateway (secret). Required when LLM_GATEWAY_URL is set. */
    CF_AIG_TOKEN?: string;
    /** "1" = enqueue full traces for Langfuse on TELEMETRY_QUEUE. */
    LANGFUSE_ENABLED?: string;
    /** 0..1 share of calls traced (default 1). Adaptive sampling steps it down. */
    LANGFUSE_SAMPLE_RATE?: string;
    /** Producer for the diff-service telemetry queue (scry-telemetry-<env>). */
    TELEMETRY_QUEUE?: Queue<import("./src/telemetry/producer").SpansMessage>;
    /** R2 bucket the search API stores generated images in (for scry-r2:// refs). Defaults by SCRY_ENV. */
    SCREENSHOT_BUCKET_NAME?: string;
    COOKIE_ENCRYPTION_KEY: string;
    DEV_BYPASS_AUTH?: string;
    SCRY_ENV?: "staging" | "production" | "dev";
    SCRY_COMMIT?: string;
    SCRY_BRANCH?: string;
    SCRY_BUILD_TIME?: string;
    SCRY_DEPLOY_ID?: string;
    SCRY_ACTOR?: string;
    /** Optional. When unset, Sentry initialises as a no-op rather than failing. */
    SENTRY_DSN?: string;
    SENTRY_RELEASE?: string;
    ASSETS: Fetcher;
  }
}

interface Env extends Cloudflare.Env {}
