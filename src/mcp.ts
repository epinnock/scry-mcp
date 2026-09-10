import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { extractResultMetadata } from "./utils/result-metadata.js";
import { CROSS_PROJECT_WARNING, withScopeNotice } from "./utils/scope-notice.js";
import { isPresignedUrl, presignedExpiry } from "./utils/presigned-url.js";
import { classifySearchApiError, upstreamErrorCode } from "./utils/search-errors.js";
import { CALLER_ASSERTION_HEADER, CallerAssertionCache } from "./utils/caller-assertion.js";
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

// --- Constants ---
const REQUEST_TIMEOUT_MS = 30_000; // 30s timeout for upstream API calls
const RATE_LIMIT_RPM = 60;         // max requests per user per minute
const MAX_QUERY_LENGTH = 500;      // max characters for text queries
const MAX_PROJECT_ID_LENGTH = 128; // max characters for project_id filter
const SEARCH_SCOPES = ["project", "org"] as const; // explicit scope; "project" never widens
const MAX_IMAGE_BASE64_BYTES = 10 * 1024 * 1024; // 10MB max for base64 image input
const MAX_PROMPT_LENGTH = 4000;                  // max characters for image generation prompt
const IMAGE_GENERATION_TIMEOUT_MS = 60_000;      // 60s timeout — Gemini image gen takes 10-30s

// Gemini image generation config
const VALID_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9"] as const;
const VALID_QUALITY_PRESETS = ["fast", "quality"] as const;
const GEMINI_MODELS: Record<string, string> = {
  fast: "gemini-3.1-flash-image-preview",
  quality: "gemini-3-pro-image-preview",
};

// MCP Apps widget resource URIs
const SEARCH_RESULTS_WIDGET_URI = "ui://scry/search-results-widget.html";
const SCREENSHOT_WIDGET_URI = "ui://scry/screenshot-widget.html";
const GENERATED_IMAGE_WIDGET_URI = "ui://scry/generated-image-widget.html";

// R2 domain for presigned screenshot URLs — needed for widget CSP
const R2_SCREENSHOT_DOMAIN = "https://scry-component-snapshot-bucket.f54b9c10de9d140756dbf449aa124f1e.r2.cloudflarestorage.com";
const R2_SCREENSHOT_DOMAIN_PATH_STYLE = "https://f54b9c10de9d140756dbf449aa124f1e.r2.cloudflarestorage.com";

export type AuthProps = {
  firebaseUid: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
};

/** Convert ArrayBuffer to base64 without spread operator to avoid call stack overflow */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Fetch compiled widget HTML from the ASSETS binding */
async function loadHtml(assets: Fetcher, path: string): Promise<string> {
  const request = new Request(new URL(path, "https://assets.invalid").toString());
  const response = await assets.fetch(request);
  return response.text();
}

export class ScryMCP extends McpAgent<Env, unknown, AuthProps> {
  server = new McpServer({
    name: "scry",
    version: "1.0.0",
  });

  // --- Rate limiting (sliding window, per Durable Object instance = per user) ---
  private requestTimestamps: number[] = [];

  private checkRateLimit(): boolean {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(t => t > now - 60_000);
    if (this.requestTimestamps.length >= RATE_LIMIT_RPM) return false;
    this.requestTimestamps.push(now);
    return true;
  }

  // --- Caller identity for the search API (ISSUES.md #45) ---
  // One Durable Object instance serves one user, so a per-instance cache of
  // the short-lived assertion is per-user by construction.
  private callerAssertion = new CallerAssertionCache();

  /**
   * Headers that tell the search API who this request is for.
   *
   * `X-Scry-Caller` is a signed, 60-second assertion of the Firebase uid, and
   * the only identity channel: the search API no longer reads the unsigned
   * `X-User-Id` header, so this assertion is what it verifies before it trusts
   * the subject. Throws when the signing secret is missing — sending nothing
   * would make every search anonymous (public projects only) and hide the
   * misconfiguration behind plausible-looking results.
   */
  private async callerHeaders(): Promise<Record<string, string>> {
    const assertion = await this.callerAssertion.get(
      this.env.SCRY_CALLER_ASSERTION_SECRET,
      this.props.firebaseUid,
    );
    return {
      [CALLER_ASSERTION_HEADER]: assertion,
    };
  }

  // --- Structured logging ---
  private log(tool: string, data: Record<string, unknown>) {
    console.log(JSON.stringify({
      tool,
      userId: this.props?.firebaseUid,
      timestamp: new Date().toISOString(),
      ...data,
    }));
  }

  // --- Structured error responses ---
  // Returns a JSON object so the LLM can reason about whether to retry.
  private toolError(code: string, message: string, retryable = false) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: code, message, retryable }) }],
      isError: true,
    };
  }

  // --- Fetch with timeout ---
  // Wraps fetch with an AbortController timeout to prevent hanging on slow upstreams.
  private async fetchWithTimeout(
    url: string,
    options: RequestInit = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Get a time-limited presigned URL for a screenshot.
   * Calls POST /api/image/presign on the Scry Next.js API.
   * The returned URL is publicly accessible (no auth required) until it expires.
   */
  private async getPresignedUrl(screenshotUrl: string): Promise<{ url: string; expiresAt: string } | null> {
    // search_components returns presigned URLs in its structuredContent, and the
    // tool description tells callers to feed a search result's screenshot_url
    // back in here. Signing an already-signed URL fails, so an agent following
    // the documented flow got SCREENSHOT_FETCH_FAILED (ISSUES.md #5). Pass those
    // straight through — they are already fetchable.
    if (isPresignedUrl(screenshotUrl)) {
      return { url: screenshotUrl, expiresAt: presignedExpiry(screenshotUrl) };
    }

    try {
      // The presign route derives the owning project from the key and checks
      // the caller against it, so it needs to know who the caller is.
      const response = await this.fetchWithTimeout(
        `${this.env.SCRY_SEARCH_API_URL}/api/image/presign`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.env.SCRY_SEARCH_API_KEY}`,
            ...(await this.callerHeaders()),
          },
          body: JSON.stringify({ path: screenshotUrl, expires_in: 3600 }),
        }
      );

      if (!response.ok) {
        this.log("getPresignedUrl", { status: response.status, success: false });
        return null;
      }

      const data = (await response.json()) as { url: string; expires_at: string };
      return { url: data.url, expiresAt: data.expires_at };
    } catch (err) {
      // Includes a missing SCRY_CALLER_ASSERTION_SECRET: presigning is
      // best-effort for thumbnails, but the cause must reach the logs.
      this.log("getPresignedUrl", { error: String(err), success: false });
      return null;
    }
  }

  /**
   * Call the Gemini REST API to generate an image from a text prompt.
   * Uses direct fetch() instead of the @google/genai SDK (incompatible with CF Workers).
   */
  private async generateImageViaGemini(
    prompt: string,
    options: { aspectRatio?: string; quality?: string; referenceImages?: string[] } = {},
  ): Promise<{ base64: string; mimeType: string; model: string }> {
    const quality = options.quality || "fast";
    const model = GEMINI_MODELS[quality] || GEMINI_MODELS.fast;

    // Build content parts — reference images first, then text prompt
    const parts: Array<Record<string, unknown>> = [];
    if (options.referenceImages) {
      for (const refImage of options.referenceImages) {
        const mimeMatch = refImage.match(/^data:(image\/\w+);base64,/);
        const refMimeType = mimeMatch?.[1] || "image/png";
        const raw = refImage.replace(/^data:image\/\w+;base64,/, "");
        parts.push({
          inlineData: {
            mimeType: refMimeType,
            data: raw,
          },
        });
      }
    }
    parts.push({ text: prompt });

    const generationConfig: Record<string, unknown> = {
      responseModalities: ["TEXT", "IMAGE"],
    };

    // Gemini uses snake_case for aspect_ratio in generation_config
    if (options.aspectRatio) {
      generationConfig.aspect_ratio = options.aspectRatio;
    }

    const requestBody: Record<string, unknown> = {
      contents: [{ parts }],
      generationConfig,
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.env.GEMINI_API_KEY}`;

    const response = await this.fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      },
      IMAGE_GENERATION_TIMEOUT_MS,
    );

    if (!response.ok) {
      const errorText = await response.text();
      // Log full error server-side but do NOT expose to client (may contain API key or sensitive details)
      this.log("generateImageViaGemini", { status: response.status, error: errorText });
      throw Object.assign(
        new Error(`Gemini API error (HTTP ${response.status}). Check server logs for details.`),
        { code: "GEMINI_API_ERROR", statusCode: response.status },
      );
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
            inlineData?: { mimeType: string; data: string };
          }>;
        };
        finishReason?: string;
      }>;
    };

    // Check for safety blocks
    const candidate = data.candidates?.[0];
    if (!candidate || candidate.finishReason === "SAFETY") {
      throw Object.assign(
        new Error("Image generation was blocked by safety filters. Try rephrasing your prompt."),
        { code: "SAFETY_FILTERED" },
      );
    }

    // Find the image part in the response
    const imagePart = candidate.content?.parts?.find(p => p.inlineData);
    if (!imagePart?.inlineData) {
      throw new Error("Gemini API returned no image data in response.");
    }

    return {
      base64: imagePart.inlineData.data,
      mimeType: imagePart.inlineData.mimeType || "image/png",
      model,
    };
  }

  /**
   * Upload a generated image to R2 via the Scry Next.js API.
   * Returns the R2 key on success, null on failure (non-fatal).
   */
  private async uploadToR2(
    base64: string,
    mimeType: string,
    key: string,
  ): Promise<string | null> {
    try {
      const response = await this.fetchWithTimeout(
        `${this.env.SCRY_SEARCH_API_URL}/api/image/upload`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.env.SCRY_SEARCH_API_KEY}`,
          },
          body: JSON.stringify({ key, data: base64, mimeType }),
        },
      );

      if (!response.ok) {
        this.log("uploadToR2", { status: response.status, key, success: false });
        return null;
      }

      this.log("uploadToR2", { key, success: true });
      return key;
    } catch (err) {
      this.log("uploadToR2", { error: String(err), key, success: false });
      return null;
    }
  }

  /** Helper to call the Scry search API and return both text content and structuredContent for widgets */
  private async callSearchAPI(body: Record<string, unknown>) {
    const start = Date.now();

    let callerHeaders: Record<string, string>;
    try {
      callerHeaders = await this.callerHeaders();
    } catch (err) {
      // Fail closed and say why. Searching without an identity would return
      // public projects only, which looks like "no results" to the agent and
      // hides a missing secret indefinitely.
      this.log("callSearchAPI", { error: String(err), success: false });
      return this.toolError(
        "SERVER_MISCONFIGURED",
        "The Scry MCP server cannot sign its caller assertion (SCRY_CALLER_ASSERTION_SECRET is not set). Ask the operator to configure it.",
        false,
      );
    }

    const response = await this.fetchWithTimeout(
      `${this.env.SCRY_SEARCH_API_URL}/api/search`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.env.SCRY_SEARCH_API_KEY}`,
          ...callerHeaders,
        },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      this.log("callSearchAPI", { status: response.status, latencyMs: Date.now() - start, success: false });

      const { code: statusCode, retryable } = classifySearchApiError(response.status);
      // Prefer the API's own code (INVALID_SCOPE, PROJECT_HAS_NO_ORG,
      // PROJECT_REQUIRED, INVALID_CALLER_ASSERTION, ...) so the agent can
      // branch on the cause rather than on a bare status.
      const errorCode = upstreamErrorCode(errorText) ?? statusCode;

      return this.toolError(
        errorCode,
        `Search API returned ${response.status}: ${errorText}`,
        retryable,
      );
    }

    const data = (await response.json()) as {
      results: Array<{
        id: string;
        score: number;
        component_name?: string;
        searchable_text?: string;
        json_content?: Record<string, unknown>;
        screenshot_url?: string;
        project_id?: string;
        /** Set by the search API when the hit came from a different project. */
        crossProject?: boolean;
      }>;
      pagination: { page: number; limit: number; total: number; total_pages?: number };
      /** The scope that answered — always the one requested. Absent without project_id. */
      scope?: string;
      /** True only when scope was "org" and rows from other projects are present. */
      widenedToOrg?: boolean;
      /** Sibling projects left out of an org search, as counts only. */
      excluded?: { not_discoverable?: number; unauthorised?: number };
    };

    this.log("callSearchAPI", {
      resultCount: data.results.length,
      total: data.pagination.total,
      latencyMs: Date.now() - start,
      success: true,
    });

    // Extract screenshot URLs for presigning (for widget thumbnails)
    const screenshotUrls = data.results.map(r => {
      const jc = r.json_content as Record<string, unknown> | undefined;
      return r.screenshot_url || (jc?.screenshotR2Url as string | undefined);
    });

    // Batch-generate presigned URLs in parallel for all results with screenshots
    const presignResults = await Promise.all(
      screenshotUrls.map(url => url ? this.getPresignedUrl(url) : Promise.resolve(null))
    );

    // Format results for readability in Claude (text content, backward compat)
    const formatted = data.results.map((r, i) => {
      const jc = r.json_content as Record<string, unknown> | undefined;
      const meta = extractResultMetadata(jc);

      const lines = [`${i + 1}. **${r.component_name || r.id}** (score: ${r.score?.toFixed(3)})`];
      if (meta.description) lines.push(`   ${meta.description}`);
      else if (r.searchable_text) lines.push(`   ${r.searchable_text}`);
      // Source path is what makes a result actionable — an agent cannot import
      // the component without it, so keep it directly under the name.
      if (meta.sourcePath) lines.push(`   Source: ${meta.sourcePath}`);
      if (meta.storyPath && meta.storyPath !== meta.sourcePath) {
        lines.push(`   Story file: ${meta.storyPath}`);
      }
      if (meta.storyTitle) {
        lines.push(meta.variant
          ? `   Story: ${meta.storyTitle} / ${meta.variant}`
          : `   Story: ${meta.storyTitle}`);
      }
      if (meta.figmaUrl) lines.push(`   Figma: ${meta.figmaUrl}`);
      if (meta.githubUrl) lines.push(`   GitHub: ${meta.githubUrl}`);
      if (meta.storybookUrl) lines.push(`   Storybook: ${meta.storybookUrl}`);
      if (meta.tags?.length) lines.push(`   Tags: ${meta.tags.join(", ")}`);
      const screenshotUrl = r.screenshot_url || meta.screenshotUrl;
      if (screenshotUrl) lines.push(`   Screenshot: ${screenshotUrl}`);
      if (r.project_id) lines.push(`   Project: ${r.project_id}`);
      // A bare project id tells an agent nothing about whether the component is
      // reachable from the repo it is editing. Say it outright: a component in
      // another team's app is findable but not necessarily importable, and a
      // confident import of one produces a build error, not a missing feature.
      if (r.crossProject) lines.push(CROSS_PROJECT_WARNING);
      return lines.join("\n");
    });

    const summary = withScopeNotice(
      `Found ${data.pagination.total} results (page ${data.pagination.page}/${data.pagination.total_pages || 1})`,
      {
        scope: data.scope,
        widenedToOrg: data.widenedToOrg,
        crossProjectCount: data.results.filter(r => r.crossProject).length,
        resultCount: data.results.length,
        excluded: data.excluded,
      },
    );

    // Build structuredContent for widget rendering — use presigned URLs for images
    const widgetResults = data.results.map((r, i) => {
      const meta = extractResultMetadata(r.json_content as Record<string, unknown> | undefined);
      return {
        name: r.component_name || r.id,
        score: r.score,
        screenshotUrl: presignResults[i]?.url,
        searchableText: r.searchable_text,
        description: meta.description,
        sourcePath: meta.sourcePath,
        storyPath: meta.storyPath,
        storyTitle: meta.storyTitle,
        variant: meta.variant,
        figmaUrl: meta.figmaUrl,
        githubUrl: meta.githubUrl,
        storybookUrl: meta.storybookUrl,
        tags: meta.tags,
        projectId: r.project_id,
        crossProject: r.crossProject === true,
      };
    });

    return {
      content: [{ type: "text" as const, text: `${summary}\n\n${formatted.join("\n\n")}` }],
      structuredContent: {
        results: widgetResults,
        summary,
        scope: data.scope,
        widenedToOrg: data.widenedToOrg === true,
      },
    };
  }

  async init() {
    // --- Register widget resources (MCP Apps UI) ---
    // Matching the mcp-app-workers-template pattern: server.registerResource() directly,
    // CSP only on the read response, not on the registration config.
    const csp = {
      resourceDomains: [R2_SCREENSHOT_DOMAIN, R2_SCREENSHOT_DOMAIN_PATH_STYLE, "data:"],
      connectDomains: [R2_SCREENSHOT_DOMAIN, R2_SCREENSHOT_DOMAIN_PATH_STYLE],
      "img-src": [R2_SCREENSHOT_DOMAIN, R2_SCREENSHOT_DOMAIN_PATH_STYLE, "data:"],
    };

    this.server.registerResource(
      "Search Results Widget",
      SEARCH_RESULTS_WIDGET_URI,
      { mimeType: RESOURCE_MIME_TYPE },
      async (uri) => {
        const html = await loadHtml(this.env.ASSETS, "/search-results-widget.html");
        return {
          contents: [{
            uri: uri.href,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: { ui: { csp } },
          }],
        };
      }
    );

    this.server.registerResource(
      "Screenshot Widget",
      SCREENSHOT_WIDGET_URI,
      { mimeType: RESOURCE_MIME_TYPE },
      async (uri) => {
        const html = await loadHtml(this.env.ASSETS, "/screenshot-widget.html");
        return {
          contents: [{
            uri: uri.href,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: { ui: { csp } },
          }],
        };
      }
    );

    this.server.registerResource(
      "Generated Image Widget",
      GENERATED_IMAGE_WIDGET_URI,
      { mimeType: RESOURCE_MIME_TYPE },
      async (uri) => {
        const html = await loadHtml(this.env.ASSETS, "/generated-image-widget.html");
        return {
          contents: [{
            uri: uri.href,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: { ui: { csp } },
          }],
        };
      }
    );

    // --- search_components: text-based search over the Scry component vector DB ---
    registerAppTool(
      this.server,
      "search_components",
      {
        description: [
          "Search for UI components by text query.",
          "Uses semantic (dense) and keyword (BM25 sparse) hybrid search across the Scry component database.",
          "Returns component names, relevance scores, metadata, Figma/GitHub/Storybook links, and screenshot URLs.",
          "",
          "",
          "Scope — read this before searching:",
          "- Pass project_id whenever you know it. Results are then only that project's components.",
          "- You can usually find it without asking: look in the repository for",
          "  .scry/config.json, .storybook-deployer.json, or a SCRY_PROJECT_ID entry in .env",
          "  or CI config. Prefer reading it from the repo over asking the user for an ID.",
          "- scope: 'project' (default) searches only project_id and NEVER widens — an empty",
          "  result means this project has no match, not that the search fell back elsewhere.",
          "- scope: 'org' also returns components from other projects in the same organisation,",
          "  but only from projects whose owners opted in to discovery AND that this account can",
          "  read. Those results are marked ⚠ and may not be importable from this repo. Use it",
          "  deliberately, e.g. 'does this already exist anywhere in our design system?'.",
          "- WITHOUT project_id the search is NOT limited to the current project. It spans",
          "  every project readable by the authenticated account, so results may come from",
          "  unrelated codebases and are not safe to import from. Only omit it deliberately,",
          "  when the intent is to search broadly. scope: 'org' requires project_id.",
          "- Check the projectId on each result before acting on it.",
          "",
          "Constraints:",
          "- Query must be 1–500 characters",
          "- Returns max 50 results per page",
          "- Use get_component_screenshot to view a result's screenshot image",
          "- sourcePath is the component to import; storyPath is the .stories file it was captured from",
          "",
          "Failure modes:",
          "- RATE_LIMITED: Too many requests. Wait and retry.",
          "- SEARCH_API_5xx: Upstream error. Retry once.",
          "- VALIDATION_ERROR / INVALID_SCOPE: Bad input. Fix parameters and retry.",
          "- PROJECT_HAS_NO_ORG: scope 'org' on a project with no organisation. Use scope 'project'.",
          "- PROJECT_REQUIRED: scope 'org' without project_id. Supply project_id.",
          "- ACCESS_DENIED: the account cannot read project_id. Do not retry with other ids.",
          "- SERVER_MISCONFIGURED / INVALID_CALLER_ASSERTION: server-side identity problem. Report it; do not retry.",
        ].join("\n"),
        inputSchema: {
          query: z.string().min(1).max(MAX_QUERY_LENGTH).describe("Text search query (e.g. 'primary button', 'date picker', 'navigation bar')"),
          limit: z.number().min(1).max(50).default(10).describe("Max results to return (1–50)"),
          page: z.number().min(1).default(1).describe("Page number for pagination"),
          project_id: z.string().max(MAX_PROJECT_ID_LENGTH).optional().describe(
            "Restrict results to one project. Look for it in the repository " +
            "(.scry/config.json, .storybook-deployer.json, SCRY_PROJECT_ID) rather than " +
            "asking the user. Omitting this searches EVERY project the account can read, " +
            "not just the current one."
          ),
          scope: z.enum(SEARCH_SCOPES).default("project").describe(
            "'project' (default): only project_id, never widens. 'org': also include other " +
            "projects in the same organisation that opted in to discovery and that you can read; " +
            "their results are marked crossProject. Requires project_id."
          ),
        },
        _meta: {
          ui: { resourceUri: SEARCH_RESULTS_WIDGET_URI },
        },
      },
      async ({ query, limit, page, project_id, scope }) => {
        if (!this.checkRateLimit()) {
          this.log("search_components", { rateLimited: true });
          return this.toolError("RATE_LIMITED", "Too many requests. Please wait a moment and try again.", true);
        }

        this.log("search_components", { queryLength: query.length, limit, page, hasProjectId: !!project_id, scope });

        return this.callSearchAPI({
          text: query,
          limit,
          page,
          project_id,
          scope,
        });
      }
    );

    // --- search_by_image: image-based visual similarity search ---
    registerAppTool(
      this.server,
      "search_by_image",
      {
        description: [
          "Search for visually similar UI components by providing a base64-encoded image.",
          "Uses image embeddings for visual similarity matching via Jina Embeddings v4.",
          "Can be combined with a text query for hybrid (text + visual) search.",
          "",
          "Scope: same rules as search_components — scope 'project' (default) searches only",
          "project_id and never widens; scope 'org' also returns opted-in, readable sibling",
          "projects' components, marked ⚠. scope 'org' requires project_id.",
          "",
          "Constraints:",
          "- Image must be base64-encoded PNG or JPG, under 10MB",
          "- Can include data URI prefix (data:image/png;base64,...) or raw base64",
          "- Returns max 50 results per page",
          "",
          "Failure modes:",
          "- RATE_LIMITED: Too many requests. Wait and retry.",
          "- VALIDATION_ERROR: Image too large or invalid format.",
          "- INVALID_SCOPE / PROJECT_HAS_NO_ORG / PROJECT_REQUIRED: fix scope or project_id.",
          "- SEARCH_API_5xx: Upstream error. Retry once.",
        ].join("\n"),
        inputSchema: {
          image: z.string().describe("Base64-encoded image (PNG/JPG, max 10MB). Can include data URI prefix or raw base64."),
          query: z.string().max(MAX_QUERY_LENGTH).optional().describe("Optional text query to combine with image search for hybrid results"),
          limit: z.number().min(1).max(50).default(10).describe("Max results to return (1–50)"),
          page: z.number().min(1).default(1).describe("Page number for pagination"),
          project_id: z.string().max(MAX_PROJECT_ID_LENGTH).optional().describe("Filter results to a specific project ID"),
          scope: z.enum(SEARCH_SCOPES).default("project").describe(
            "'project' (default): only project_id, never widens. 'org': also include opted-in, " +
            "readable sibling projects; their results are marked crossProject. Requires project_id."
          ),
        },
        _meta: {
          ui: { resourceUri: SEARCH_RESULTS_WIDGET_URI },
        },
      },
      async ({ image, query, limit, page, project_id, scope }) => {
        if (!this.checkRateLimit()) {
          this.log("search_by_image", { rateLimited: true });
          return this.toolError("RATE_LIMITED", "Too many requests. Please wait a moment and try again.", true);
        }

        // Validate image size (base64 is ~33% larger than binary, so 10MB base64 ≈ 7.5MB image)
        if (image.length > MAX_IMAGE_BASE64_BYTES) {
          return this.toolError("VALIDATION_ERROR", `Image too large (${(image.length / 1024 / 1024).toFixed(1)}MB). Max 10MB base64.`, false);
        }

        this.log("search_by_image", { imageSize: image.length, hasQuery: !!query, limit, page, scope });

        return this.callSearchAPI({
          image,
          text: query,
          limit,
          page,
          project_id,
          scope,
        });
      }
    );

    // --- get_component_screenshot: fetch a component screenshot as an image ---
    // Returns BOTH an MCP image content block (for clients that support it, e.g. Claude)
    // AND a presigned URL as text (for clients that don't support image blocks, e.g. ChatGPT).
    // This dual-return strategy ensures the tool works across all MCP clients.
    registerAppTool(
      this.server,
      "get_component_screenshot",
      {
        description: [
          "Fetch a component screenshot image so you can see it.",
          "Use this after search_components or search_by_image to view the actual screenshot of a specific result.",
          "Returns the image directly (as an image content block) plus a temporary presigned URL.",
          "",
          "Constraints:",
          "- The screenshot_url must come from a search result's screenshot_url field",
          "- Presigned URLs expire after 1 hour",
          "",
          "Failure modes:",
          "- SCREENSHOT_FETCH_FAILED: Could not fetch the image or generate URL. The screenshot may not exist.",
          "- RATE_LIMITED: Too many requests. Wait and retry.",
        ].join("\n"),
        inputSchema: {
          screenshot_url: z.string().min(1).describe("The screenshot_url value from a search result"),
          component_name: z.string().optional().describe("Component name (for labeling the response)"),
        },
        _meta: {
          ui: { resourceUri: SCREENSHOT_WIDGET_URI },
        },
      },
      async ({ screenshot_url, component_name }) => {
        if (!this.checkRateLimit()) {
          this.log("get_component_screenshot", { rateLimited: true });
          return this.toolError("RATE_LIMITED", "Too many requests. Please wait a moment and try again.", true);
        }

        const start = Date.now();

        // Get a presigned R2 URL, then fetch image bytes from it
        const presignResult = await this.getPresignedUrl(screenshot_url);

        if (!presignResult) {
          this.log("get_component_screenshot", { hasImage: false, hasPresignedUrl: false, latencyMs: Date.now() - start });
          return this.toolError(
            "SCREENSHOT_FETCH_FAILED",
            `Could not generate presigned URL for: ${screenshot_url}`,
            true,
          );
        }

        // Fetch image bytes from the presigned URL for inline display
        let imageResult: { base64: string; mimeType: string } | null = null;
        try {
          const response = await this.fetchWithTimeout(presignResult.url);
          if (response.ok) {
            const buffer = await response.arrayBuffer();
            const mimeType = response.headers.get("content-type") || "image/png";
            const base64 = arrayBufferToBase64(buffer);
            imageResult = { base64, mimeType };
          }
        } catch (err) {
          this.log("get_component_screenshot", { imageError: String(err) });
          // Image fetch failed — still return the presigned URL
        }

        this.log("get_component_screenshot", {
          hasImage: !!imageResult,
          hasPresignedUrl: true,
          latencyMs: Date.now() - start,
        });

        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];

        // Label
        if (component_name) {
          content.push({ type: "text", text: `Screenshot of **${component_name}**:` });
        }

        // Image content block (works in Claude Desktop and other clients with image support)
        if (imageResult) {
          content.push({
            type: "image",
            data: imageResult.base64,
            mimeType: imageResult.mimeType,
          });
        }

        // Presigned URL as text (works in all clients — URL is accessible without auth)
        content.push({
          type: "text",
          text: `Screenshot URL (expires ${presignResult.expiresAt}): ${presignResult.url}`,
        });

        return {
          content,
          structuredContent: {
            screenshot: {
              url: presignResult.url,
              componentName: component_name,
              mimeType: imageResult?.mimeType || "image/png",
            },
          },
        };
      }
    );

    // --- generate_image: AI image generation via Gemini ---
    // Generates an image from a text prompt, persists to R2, returns dual-format response.
    // Follows the same pattern as get_component_screenshot: base64 + presigned URL + structuredContent.
    registerAppTool(
      this.server,
      "generate_image",
      {
        description: [
          "Generate a UI image from a text prompt using AI (Google Gemini).",
          "Returns the generated image directly (as an image content block) plus a persistent presigned URL.",
          "Use this to create UI mockups, icons, buttons, or any visual asset described in text.",
          "Supports multiple reference images via reference_images array.",
          "",
          "Constraints:",
          "- Prompt must be 1–4000 characters",
          "- Reference image(s) must each be under 10MB base64",
          "- Generation takes 10–30 seconds",
          "",
          "Failure modes:",
          "- RATE_LIMITED: Too many requests. Wait and retry.",
          "- SAFETY_FILTERED: Prompt was blocked by safety filters. Rephrase and retry.",
          "- GEMINI_API_ERROR: Upstream error. Retry once for 5xx errors.",
          "- VALIDATION_ERROR: Bad input. Fix parameters and retry.",
        ].join("\n"),
        inputSchema: {
          prompt: z.string().min(1).max(MAX_PROMPT_LENGTH).describe("Description of the image to generate (e.g. 'A blue primary button with rounded corners')"),
          aspect_ratio: z.enum(VALID_ASPECT_RATIOS).optional().describe("Image aspect ratio (default: 1:1)"),
          quality: z.enum(VALID_QUALITY_PRESETS).optional().describe("Generation quality: 'fast' (Gemini 3.1 Flash) or 'quality' (Gemini 3 Pro)"),
          reference_image: z.string().optional().describe("(Deprecated) Single base64 reference image. Use reference_images instead."),
          reference_images: z.array(z.string()).optional().describe("Array of base64 reference images for img2img style transfer"),
        },
        _meta: {
          ui: { resourceUri: GENERATED_IMAGE_WIDGET_URI },
        },
      },
      async ({ prompt, aspect_ratio, quality, reference_image, reference_images }) => {
        if (!this.checkRateLimit()) {
          this.log("generate_image", { rateLimited: true });
          return this.toolError("RATE_LIMITED", "Too many requests. Please wait a moment and try again.", true);
        }

        // Merge reference_image (deprecated) + reference_images into a single deduplicated array
        const mergedImages: string[] = [];
        const seen = new Set<string>();
        for (const img of [...(reference_images || []), ...(reference_image ? [reference_image] : [])]) {
          if (!seen.has(img)) {
            seen.add(img);
            mergedImages.push(img);
          }
        }

        // Validate each reference image size individually
        for (let i = 0; i < mergedImages.length; i++) {
          if (mergedImages[i].length > MAX_IMAGE_BASE64_BYTES) {
            return this.toolError(
              "VALIDATION_ERROR",
              `Reference image ${i + 1} too large (${(mergedImages[i].length / 1024 / 1024).toFixed(1)}MB). Max 10MB base64 per image.`,
              false,
            );
          }
        }

        const start = Date.now();
        this.log("generate_image", {
          promptLength: prompt.length,
          aspectRatio: aspect_ratio,
          quality: quality || "fast",
          referenceImageCount: mergedImages.length,
        });

        // Step 1: Generate image via Gemini
        let genResult: { base64: string; mimeType: string; model: string };
        try {
          genResult = await this.generateImageViaGemini(prompt, {
            aspectRatio: aspect_ratio,
            quality,
            referenceImages: mergedImages.length > 0 ? mergedImages : undefined,
          });
        } catch (err) {
          const error = err as Error & { code?: string; statusCode?: number };
          this.log("generate_image", { error: error.message, latencyMs: Date.now() - start });

          if (error.code === "SAFETY_FILTERED") {
            return this.toolError("SAFETY_FILTERED", error.message, false);
          }
          const retryable = error.statusCode !== undefined && error.statusCode >= 500;
          return this.toolError("GEMINI_API_ERROR", error.message, retryable);
        }

        // Step 2: Upload to R2 (non-fatal)
        const ext = (genResult.mimeType.split("/")[1] || "png").replace(/[^a-zA-Z0-9]/g, "");
        const promptHash = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(prompt)))
        ).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
        const r2Key = `generated/${this.props.firebaseUid}/${Date.now()}-${promptHash}.${ext}`;

        const uploadedKey = await this.uploadToR2(genResult.base64, genResult.mimeType, r2Key);

        // Step 3: Get presigned URL if upload succeeded
        let presignResult: { url: string; expiresAt: string } | null = null;
        if (uploadedKey) {
          presignResult = await this.getPresignedUrl(uploadedKey);
        }

        this.log("generate_image", {
          model: genResult.model,
          uploaded: !!uploadedKey,
          hasPresignedUrl: !!presignResult,
          latencyMs: Date.now() - start,
        });

        // Step 4: Build dual-format response
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
        const truncatedPrompt = prompt.length > 100 ? prompt.slice(0, 100) + "..." : prompt;

        if (presignResult) {
          content.push({ type: "text", text: `Generated image for prompt: "${truncatedPrompt}"` });
        } else {
          content.push({ type: "text", text: `Generated image for prompt: "${truncatedPrompt}" (inline only — storage unavailable)` });
        }

        // Image content block (works in Claude and image-capable clients)
        content.push({
          type: "image",
          data: genResult.base64,
          mimeType: genResult.mimeType,
        });

        // Presigned URL as text (works in all clients)
        if (presignResult) {
          content.push({
            type: "text",
            text: `Image URL (expires ${presignResult.expiresAt}): ${presignResult.url}`,
          });
        }

        const generatedAt = new Date().toISOString();
        const structuredImage: Record<string, unknown> = {
          prompt,
          aspectRatio: aspect_ratio || "1:1",
          quality: quality || "fast",
          model: genResult.model,
          mimeType: genResult.mimeType,
          generatedAt,
        };

        if (presignResult) {
          structuredImage.url = presignResult.url;
        } else {
          structuredImage.base64 = genResult.base64;
        }

        return {
          content,
          structuredContent: {
            generatedImage: structuredImage,
          },
        };
      }
    );

    // --- whoami: authenticated user info ---
    this.server.tool(
      "whoami",
      "Get the currently authenticated user's info (uid, email, display name). No parameters required.",
      {},
      async () => {
        this.log("whoami", {});
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  uid: this.props.firebaseUid,
                  email: this.props.email,
                  displayName: this.props.displayName,
                  emailVerified: this.props.emailVerified,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );
  }
}
