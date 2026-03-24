import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

// --- Constants ---
const REQUEST_TIMEOUT_MS = 30_000; // 30s timeout for upstream API calls
const RATE_LIMIT_RPM = 60;         // max requests per user per minute
const MAX_QUERY_LENGTH = 500;      // max characters for text queries
const MAX_PROJECT_ID_LENGTH = 128; // max characters for project_id filter
const MAX_IMAGE_BASE64_BYTES = 10 * 1024 * 1024; // 10MB max for base64 image input
const MAX_PROMPT_LENGTH = 4000;                  // max characters for image generation prompt
const IMAGE_GENERATION_TIMEOUT_MS = 60_000;      // 60s timeout — Gemini image gen takes 10-30s

// Gemini image generation config
const VALID_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9"] as const;
const VALID_QUALITY_PRESETS = ["fast", "quality"] as const;
const GEMINI_MODELS: Record<string, string> = {
  fast: "gemini-2.0-flash-exp-image-generation",
  quality: "gemini-2.0-flash-exp-image-generation",
};

// MCP Apps widget resource URIs
const SEARCH_RESULTS_WIDGET_URI = "ui://scry/search-results-widget.html";
const SCREENSHOT_WIDGET_URI = "ui://scry/screenshot-widget.html";
const GENERATED_IMAGE_WIDGET_URI = "ui://scry/generated-image-widget.html";

// R2 domain for presigned screenshot URLs — needed for widget CSP
const R2_SCREENSHOT_DOMAIN = "https://scry-component-snapshot-bucket.f54b9c10de9d140756dbf449aa124f1e.r2.cloudflarestorage.com";

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
    try {
      const response = await this.fetchWithTimeout(
        `${this.env.SCRY_SEARCH_API_URL}/api/image/presign`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.env.SCRY_SEARCH_API_KEY}`,
          },
          body: JSON.stringify({ path: screenshotUrl, expires_in: 3600 }),
        }
      );

      if (!response.ok) return null;

      const data = (await response.json()) as { url: string; expires_at: string };
      return { url: data.url, expiresAt: data.expires_at };
    } catch {
      return null;
    }
  }

  /**
   * Call the Gemini REST API to generate an image from a text prompt.
   * Uses direct fetch() instead of the @google/genai SDK (incompatible with CF Workers).
   */
  private async generateImageViaGemini(
    prompt: string,
    options: { aspectRatio?: string; quality?: string; referenceImage?: string } = {},
  ): Promise<{ base64: string; mimeType: string; model: string }> {
    const quality = options.quality || "fast";
    const model = GEMINI_MODELS[quality] || GEMINI_MODELS.fast;

    // Build content parts
    const parts: Array<Record<string, unknown>> = [];
    if (options.referenceImage) {
      // Extract MIME type from data URI prefix before stripping it
      const mimeMatch = options.referenceImage.match(/^data:(image\/\w+);base64,/);
      const refMimeType = mimeMatch?.[1] || "image/png";
      const raw = options.referenceImage.replace(/^data:image\/\w+;base64,/, "");
      parts.push({
        inlineData: {
          mimeType: refMimeType,
          data: raw,
        },
      });
    }
    parts.push({ text: prompt });

    const requestBody: Record<string, unknown> = {
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        responseMimeType: "image/png",
      },
    };

    // Add aspect ratio if specified
    if (options.aspectRatio) {
      (requestBody.generationConfig as Record<string, unknown>).aspectRatio = options.aspectRatio;
    }

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

    const response = await this.fetchWithTimeout(
      `${this.env.SCRY_SEARCH_API_URL}/api/search`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.env.SCRY_SEARCH_API_KEY}`,
          "X-User-Id": this.props.firebaseUid,
        },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      const retryable = response.status >= 500 || response.status === 429;
      this.log("callSearchAPI", { status: response.status, latencyMs: Date.now() - start, success: false });
      return this.toolError(
        response.status === 429 ? "UPSTREAM_RATE_LIMITED" : `SEARCH_API_${response.status}`,
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
      }>;
      pagination: { page: number; limit: number; total: number; total_pages?: number };
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
      const lines = [`${i + 1}. **${r.component_name || r.id}** (score: ${r.score?.toFixed(3)})`];
      if (r.searchable_text) lines.push(`   ${r.searchable_text}`);
      const jc = r.json_content as Record<string, unknown> | undefined;
      if (jc) {
        if (jc.figma_url) lines.push(`   Figma: ${jc.figma_url}`);
        if (jc.github_url) lines.push(`   GitHub: ${jc.github_url}`);
        if (jc.storybook_url) lines.push(`   Storybook: ${jc.storybook_url}`);
        if (Array.isArray(jc.tags) && jc.tags.length) lines.push(`   Tags: ${jc.tags.join(", ")}`);
      }
      const screenshotUrl = r.screenshot_url || (jc?.screenshotR2Url as string | undefined);
      if (screenshotUrl) lines.push(`   Screenshot: ${screenshotUrl}`);
      if (r.project_id) lines.push(`   Project: ${r.project_id}`);
      return lines.join("\n");
    });

    const summary = `Found ${data.pagination.total} results (page ${data.pagination.page}/${data.pagination.total_pages || 1})`;

    // Build structuredContent for widget rendering — use presigned URLs for images
    const widgetResults = data.results.map((r, i) => {
      const jc = r.json_content as Record<string, unknown> | undefined;
      return {
        name: r.component_name || r.id,
        score: r.score,
        screenshotUrl: presignResults[i]?.url,
        searchableText: r.searchable_text,
        figmaUrl: jc?.figma_url as string | undefined,
        githubUrl: jc?.github_url as string | undefined,
        storybookUrl: jc?.storybook_url as string | undefined,
        tags: Array.isArray(jc?.tags) ? jc.tags as string[] : undefined,
        projectId: r.project_id,
      };
    });

    return {
      content: [{ type: "text" as const, text: `${summary}\n\n${formatted.join("\n\n")}` }],
      structuredContent: {
        results: widgetResults,
        summary,
      },
    };
  }

  async init() {
    // --- Register widget resources (MCP Apps UI) ---
    // Matching the mcp-app-workers-template pattern: server.registerResource() directly,
    // CSP only on the read response, not on the registration config.
    const csp = {
      resourceDomains: [R2_SCREENSHOT_DOMAIN],
      connectDomains: [R2_SCREENSHOT_DOMAIN],
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
          "Constraints:",
          "- Query must be 1–500 characters",
          "- Returns max 50 results per page",
          "- Use get_component_screenshot to view a result's screenshot image",
          "",
          "Failure modes:",
          "- RATE_LIMITED: Too many requests. Wait and retry.",
          "- SEARCH_API_5xx: Upstream error. Retry once.",
          "- VALIDATION_ERROR: Bad input. Fix parameters and retry.",
        ].join("\n"),
        inputSchema: {
          query: z.string().min(1).max(MAX_QUERY_LENGTH).describe("Text search query (e.g. 'primary button', 'date picker', 'navigation bar')"),
          limit: z.number().min(1).max(50).default(10).describe("Max results to return (1–50)"),
          page: z.number().min(1).default(1).describe("Page number for pagination"),
          project_id: z.string().max(MAX_PROJECT_ID_LENGTH).optional().describe("Filter results to a specific project ID"),
        },
        _meta: {
          ui: { resourceUri: SEARCH_RESULTS_WIDGET_URI },
        },
      },
      async ({ query, limit, page, project_id }) => {
        if (!this.checkRateLimit()) {
          this.log("search_components", { rateLimited: true });
          return this.toolError("RATE_LIMITED", "Too many requests. Please wait a moment and try again.", true);
        }

        this.log("search_components", { queryLength: query.length, limit, page, hasProjectId: !!project_id });

        return this.callSearchAPI({
          text: query,
          limit,
          page,
          project_id,
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
          "Constraints:",
          "- Image must be base64-encoded PNG or JPG, under 10MB",
          "- Can include data URI prefix (data:image/png;base64,...) or raw base64",
          "- Returns max 50 results per page",
          "",
          "Failure modes:",
          "- RATE_LIMITED: Too many requests. Wait and retry.",
          "- VALIDATION_ERROR: Image too large or invalid format.",
          "- SEARCH_API_5xx: Upstream error. Retry once.",
        ].join("\n"),
        inputSchema: {
          image: z.string().describe("Base64-encoded image (PNG/JPG, max 10MB). Can include data URI prefix or raw base64."),
          query: z.string().max(MAX_QUERY_LENGTH).optional().describe("Optional text query to combine with image search for hybrid results"),
          limit: z.number().min(1).max(50).default(10).describe("Max results to return (1–50)"),
          page: z.number().min(1).default(1).describe("Page number for pagination"),
          project_id: z.string().max(MAX_PROJECT_ID_LENGTH).optional().describe("Filter results to a specific project ID"),
        },
        _meta: {
          ui: { resourceUri: SEARCH_RESULTS_WIDGET_URI },
        },
      },
      async ({ image, query, limit, page, project_id }) => {
        if (!this.checkRateLimit()) {
          this.log("search_by_image", { rateLimited: true });
          return this.toolError("RATE_LIMITED", "Too many requests. Please wait a moment and try again.", true);
        }

        // Validate image size (base64 is ~33% larger than binary, so 10MB base64 ≈ 7.5MB image)
        if (image.length > MAX_IMAGE_BASE64_BYTES) {
          return this.toolError("VALIDATION_ERROR", `Image too large (${(image.length / 1024 / 1024).toFixed(1)}MB). Max 10MB base64.`, false);
        }

        this.log("search_by_image", { imageSize: image.length, hasQuery: !!query, limit, page });

        return this.callSearchAPI({
          image,
          text: query,
          limit,
          page,
          project_id,
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
          "",
          "Constraints:",
          "- Prompt must be 1–4000 characters",
          "- Reference image (for img2img) must be under 10MB base64",
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
          quality: z.enum(VALID_QUALITY_PRESETS).optional().describe("Generation quality: 'fast' (Gemini Flash) or 'quality' (Imagen 3)"),
          reference_image: z.string().optional().describe("Optional base64 reference image for img2img style transfer"),
        },
        _meta: {
          ui: { resourceUri: GENERATED_IMAGE_WIDGET_URI },
        },
      },
      async ({ prompt, aspect_ratio, quality, reference_image }) => {
        if (!this.checkRateLimit()) {
          this.log("generate_image", { rateLimited: true });
          return this.toolError("RATE_LIMITED", "Too many requests. Please wait a moment and try again.", true);
        }

        // Validate reference image size
        if (reference_image && reference_image.length > MAX_IMAGE_BASE64_BYTES) {
          return this.toolError(
            "VALIDATION_ERROR",
            `Reference image too large (${(reference_image.length / 1024 / 1024).toFixed(1)}MB). Max 10MB base64.`,
            false,
          );
        }

        const start = Date.now();
        this.log("generate_image", {
          promptLength: prompt.length,
          aspectRatio: aspect_ratio,
          quality: quality || "fast",
          hasReferenceImage: !!reference_image,
        });

        // Step 1: Generate image via Gemini
        let genResult: { base64: string; mimeType: string; model: string };
        try {
          genResult = await this.generateImageViaGemini(prompt, {
            aspectRatio: aspect_ratio,
            quality,
            referenceImage: reference_image,
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
