import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// --- Constants ---
const REQUEST_TIMEOUT_MS = 30_000; // 30s timeout for upstream API calls
const RATE_LIMIT_RPM = 60;         // max requests per user per minute
const MAX_QUERY_LENGTH = 500;      // max characters for text queries
const MAX_PROJECT_ID_LENGTH = 128; // max characters for project_id filter
const MAX_IMAGE_BASE64_BYTES = 10 * 1024 * 1024; // 10MB max for base64 image input

export type AuthProps = {
  firebaseUid: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
};

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

  /** Helper to call the Scry search API */
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

    // Format results for readability in Claude
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
      // Use screenshot_url if available, otherwise fall back to screenshotR2Url from json_content
      const screenshotUrl = r.screenshot_url || (jc?.screenshotR2Url as string | undefined);
      if (screenshotUrl) lines.push(`   Screenshot: ${screenshotUrl}`);
      if (r.project_id) lines.push(`   Project: ${r.project_id}`);
      return lines.join("\n");
    });

    const summary = `Found ${data.pagination.total} results (page ${data.pagination.page}/${data.pagination.total_pages || 1})`;

    return {
      content: [{ type: "text" as const, text: `${summary}\n\n${formatted.join("\n\n")}` }],
    };
  }

  async init() {
    // --- search_components: text-based search over the Scry component vector DB ---
    this.server.tool(
      "search_components",
      [
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
      {
        query: z.string().min(1).max(MAX_QUERY_LENGTH).describe("Text search query (e.g. 'primary button', 'date picker', 'navigation bar')"),
        limit: z.number().min(1).max(50).default(10).describe("Max results to return (1–50)"),
        page: z.number().min(1).default(1).describe("Page number for pagination"),
        project_id: z.string().max(MAX_PROJECT_ID_LENGTH).optional().describe("Filter results to a specific project ID"),
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
    this.server.tool(
      "search_by_image",
      [
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
      {
        image: z.string().describe("Base64-encoded image (PNG/JPG, max 10MB). Can include data URI prefix or raw base64."),
        query: z.string().max(MAX_QUERY_LENGTH).optional().describe("Optional text query to combine with image search for hybrid results"),
        limit: z.number().min(1).max(50).default(10).describe("Max results to return (1–50)"),
        page: z.number().min(1).default(1).describe("Page number for pagination"),
        project_id: z.string().max(MAX_PROJECT_ID_LENGTH).optional().describe("Filter results to a specific project ID"),
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
    this.server.tool(
      "get_component_screenshot",
      [
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
      {
        screenshot_url: z.string().min(1).describe("The screenshot_url value from a search result"),
        component_name: z.string().optional().describe("Component name (for labeling the response)"),
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
            const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
            imageResult = { base64, mimeType };
          }
        } catch {
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

        return { content };
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
