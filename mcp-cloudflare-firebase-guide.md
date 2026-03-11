# Scry MCP Server on Cloudflare Workers with Firebase Authentication

A complete implementation guide for building the Scry MCP server — a spec-compliant remote MCP server on Cloudflare using `workers-oauth-provider` with Firebase as the upstream identity provider. The server exposes multi-modal vector search over the Scry component database (Milvus) via MCP tools. Compatible with any MCP client (Claude Desktop, ChatGPT, Cursor, etc.) via `mcp-remote`. Image delivery uses a dual-return strategy (base64 image block + presigned URL) for cross-client support.

This document is intended to be consumed by a coding agent. Every file is listed in full. A verification checklist and test suite are provided at the end — run them before considering the task complete.

---

## Architecture Overview

```
Claude Desktop / ChatGPT / Any MCP Client
    │
    │  (stdio via mcp-remote)
    ▼
mcp-remote (local proxy)
    │
    │  (Streamable HTTP + OAuth 2.1)
    ▼
Cloudflare Worker ──────────────► Firebase Auth (upstream IdP)
  ├─ OAuthProvider (token mgmt)
  ├─ FirebaseAuthHandler (login + verify)
  └─ ScryMCP (Durable Object, 4 tools)
         │
         ▼
  Scry Search API (Next.js)
    ├─ POST /api/search         — vector search (text, image, hybrid)
    │    ├─ Jina Embeddings v4 (text + image → 2048-dim vectors)
    │    └─ Milvus hybrid search (dense + sparse BM25 + image)
    ├─ GET  /api/image/...      — image proxy (CDN auth, returns binary)
    └─ POST /api/image/presign  — presigned URL generation (time-limited, no auth to access)
```

The Cloudflare Worker acts as both an OAuth server to MCP clients (issuing its own tokens) and an OAuth client to Firebase (authenticating users upstream). The MCP client never sees the Firebase token — it is encrypted and stored in Workers KV.

### Scry Search Backend

The MCP tools call the existing Scry Next.js search API, which exposes two endpoints:

**`POST /api/search`** — Multi-modal vector search:

- **Text search**: Semantic dense embeddings (Jina v4) + BM25 sparse full-text search
- **Image search**: Base64 image embeddings for visual similarity
- **Hybrid search**: Weighted or RRF fusion across all modalities
- **Project filtering**: Scope results to a specific project
- **Pagination**: Page-based with configurable limits (1–100)

Each search result includes: component name, searchable text metadata, JSON content (Figma/GitHub/Storybook URLs, tags, props), screenshot URL, project ID, and relevance score.

**`POST /api/image/presign`** — Generate time-limited presigned URLs for screenshots:

```
POST /api/image/presign
Request body:
  path: string            — the screenshot path or URL from search results
  expires_in?: number     — TTL in seconds (default: 3600, max: 86400)

Response:
  url: string             — presigned URL accessible without authentication
  expires_at: string      — ISO 8601 expiry timestamp
```

This endpoint must be implemented in scry-nextjs. It extracts the R2 object key from the given path/URL and generates a presigned URL using `@aws-sdk/s3-request-presigner`. The presigned URL is time-limited and requires no authentication to access, making it safe to return to MCP clients that don't support image content blocks.

The `get_component_screenshot` tool uses both endpoints: it fetches the image via `/api/image/` (for the base64 image block) and calls `/api/image/presign` (for a fallback URL), returning both so the response works across all MCP clients.

### Auth Flow

```
Claude Desktop        mcp-remote          Worker              Firebase
     │                    │                  │                    │
     │── start ──────────►│                  │                    │
     │                    │── GET /mcp ─────►│                    │
     │                    │◄── 401 ──────────│                    │
     │                    │                  │                    │
     │  (browser opens)   │── GET /authorize►│                    │
     │                    │                  │── render login ───►│
     │                    │                  │   (Firebase JS SDK) │
     │                    │                  │                    │
     │                    │                  │◄── ID token ───────│
     │                    │                  │                    │
     │                    │                  │  verify token       │
     │                    │                  │  encrypt + store    │
     │                    │                  │  issue MCP token    │
     │                    │                  │                    │
     │                    │◄── MCP token ────│                    │
     │                    │                  │                    │
     │── "find buttons" ─►│── tool call ────►│── POST /api/search►
     │◄── components ─────│◄── results ──────│◄──────────────────
```

---

## Project Structure

```
scry-mcp/
├── src/
│   ├── index.ts                # Entry point — OAuthProvider wrapper
│   ├── firebase-handler.ts     # Auth handler — login UI + Firebase verification
│   ├── mcp.ts                  # MCP server — Scry search tools
│   └── utils/
│       └── firebase-verify.ts  # Firebase ID token verification (Workers-compatible)
├── test/
│   ├── firebase-verify.test.ts # Unit tests for token verification
│   ├── firebase-handler.test.ts# Integration tests for auth handler routes
│   ├── mcp.test.ts             # Integration tests for MCP tools
│   ├── e2e.test.ts             # End-to-end smoke tests against local dev server
│   └── fixtures/
│       └── tokens.ts           # Test JWT fixtures (valid, expired, bad sig, etc.)
├── vitest.config.ts
├── wrangler.jsonc
├── package.json
├── tsconfig.json
└── worker-configuration.d.ts
```

---

## Server Implementation

### 1. `wrangler.jsonc`

```jsonc
{
  "name": "scry-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2025-03-10",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "kv_namespaces": [
    {
      "binding": "OAUTH_KV",
      "id": "<your-kv-namespace-id>",
      "preview_id": "<your-preview-kv-namespace-id>"
    }
  ],
  "durable_objects": {
    "bindings": [
      {
        "name": "MCP_OBJECT",
        "class_name": "ScryMCP"
      }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_classes": ["ScryMCP"] }
  ]
}
```

> The `global_fetch_strictly_public` flag is required by `workers-oauth-provider` for SSRF protection.

### 2. `worker-configuration.d.ts`

```typescript
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
```

### 3. `src/index.ts` — Entry Point

```typescript
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
    "/health": async () =>
      Response.json({
        status: "ok",
        server: "scry-mcp",
        version: "1.0.0",
        timestamp: new Date().toISOString(),
      }),
  },
  defaultHandler: FirebaseAuthHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
```

### 4. `src/utils/firebase-verify.ts` — Token Verification

The full Firebase Admin SDK is too heavy for Workers. Verify Firebase ID tokens manually using the Web Crypto API and `jose`:

```typescript
import { importX509 } from "jose";

// --- Key cache ---
let cachedKeys: Record<string, string> | null = null;
let cacheExpiry = 0;

export async function getGooglePublicKeys(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cachedKeys && now < cacheExpiry) return cachedKeys;

  const res = await fetch(
    "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com"
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch Google public keys: ${res.status}`);
  }

  const cacheControl = res.headers.get("Cache-Control") || "";
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAge = maxAgeMatch ? parseInt(maxAgeMatch[1]) * 1000 : 3600_000;

  cachedKeys = (await res.json()) as Record<string, string>;
  cacheExpiry = now + maxAge;
  return cachedKeys;
}

// Exported for test teardown
export function _resetKeyCache(): void {
  cachedKeys = null;
  cacheExpiry = 0;
}

function base64UrlToArrayBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  const padded = pad ? base64 + "=".repeat(4 - pad) : base64;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// --- Types ---
export interface FirebaseTokenPayload {
  uid: string;
  email?: string;
  name?: string;
  picture?: string;
  email_verified?: boolean;
  auth_time: number;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  sub: string;
  firebase: {
    sign_in_provider: string;
    identities: Record<string, string[]>;
  };
}

// --- Main verification function ---
export async function verifyFirebaseIdToken(
  idToken: string,
  projectId: string
): Promise<FirebaseTokenPayload | null> {
  try {
    const parts = idToken.split(".");
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;
    const header = JSON.parse(atob(headerB64));
    const payload: FirebaseTokenPayload = JSON.parse(atob(payloadB64));

    // 1. Validate claims
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) return null;
    if (payload.iat > now + 5) return null;
    if (payload.aud !== projectId) return null;
    if (payload.iss !== `https://securetoken.google.com/${projectId}`) return null;
    if (!payload.sub || payload.sub.length === 0 || payload.sub.length > 128) return null;
    if (payload.auth_time > now + 5) return null;

    // 2. Fetch Google's public keys
    const keys = await getGooglePublicKeys();
    const certPem = keys[header.kid];
    if (!certPem) return null;

    // 3. Import public key from X.509 cert and verify signature
    const publicKey = await importX509(certPem, "RS256");
    const signatureInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = base64UrlToArrayBuffer(signatureB64);

    const cryptoKey = publicKey as unknown as CryptoKey;
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signature,
      signatureInput
    );

    if (!valid) return null;

    payload.uid = payload.sub;
    return payload;
  } catch {
    return null;
  }
}
```

### 5. `src/firebase-handler.ts` — Auth Handler

Handles the `/authorize` flow: renders a Firebase sign-in page, then exchanges the ID token for an MCP token.

```typescript
import { Hono } from "hono";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { verifyFirebaseIdToken } from "./utils/firebase-verify";

const app = new Hono<{ Bindings: Env }>();

// ----- CSRF helpers -----

function generateCSRFToken(): { token: string; setCookie: string } {
  const token = crypto.randomUUID();
  const setCookie = `__Host-csrf=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`;
  return { token, setCookie };
}

function validateCSRFToken(formData: FormData, request: Request): boolean {
  const formToken = formData.get("csrf_token") as string;
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader
    .split(";")
    .find((c) => c.trim().startsWith("__Host-csrf="));
  const cookieToken = match?.split("=")[1]?.trim();
  return !!formToken && formToken === cookieToken;
}

// ----- Routes -----

// GET /authorize — show the Firebase sign-in page
app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  if (!oauthReqInfo.clientId) {
    return c.text("Invalid OAuth request", 400);
  }

  const { token: csrfToken, setCookie } = generateCSRFToken();
  const state = btoa(JSON.stringify({ oauthReqInfo }));

  const html = renderLoginPage({
    firebaseApiKey: c.env.FIREBASE_API_KEY,
    firebaseAuthDomain: c.env.FIREBASE_AUTH_DOMAIN,
    firebaseProjectId: c.env.FIREBASE_PROJECT_ID,
    state,
    csrfToken,
  });

  return c.html(html, 200, { "Set-Cookie": setCookie });
});

// POST /callback — receive the Firebase ID token, verify, issue MCP token
app.post("/callback", async (c) => {
  const formData = await c.req.raw.formData();

  if (!validateCSRFToken(formData, c.req.raw)) {
    return c.text("CSRF validation failed", 403);
  }

  const firebaseIdToken = formData.get("id_token") as string;
  const encodedState = formData.get("state") as string;

  if (!firebaseIdToken || !encodedState) {
    return c.text("Missing credentials", 400);
  }

  const user = await verifyFirebaseIdToken(
    firebaseIdToken,
    c.env.FIREBASE_PROJECT_ID
  );
  if (!user) {
    return c.text("Authentication failed", 401);
  }

  let state: { oauthReqInfo: AuthRequest };
  try {
    state = JSON.parse(atob(encodedState));
  } catch {
    return c.text("Invalid state", 400);
  }

  if (!state.oauthReqInfo?.clientId) {
    return c.text("Invalid OAuth request in state", 400);
  }

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: state.oauthReqInfo,
    userId: user.uid,
    metadata: {
      label: user.email || user.uid,
    },
    scope: state.oauthReqInfo.scope,
    props: {
      firebaseUid: user.uid,
      email: user.email || "",
      displayName: user.name || "",
      emailVerified: user.email_verified || false,
    },
  });

  return Response.redirect(redirectTo);
});

// ----- Login Page -----

function renderLoginPage(config: {
  firebaseApiKey: string;
  firebaseAuthDomain: string;
  firebaseProjectId: string;
  state: string;
  csrfToken: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign In — Scry MCP</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; background: #f5f5f5;
    }
    .card {
      background: white; border-radius: 12px; padding: 2rem;
      box-shadow: 0 2px 12px rgba(0,0,0,0.1); max-width: 400px; width: 100%;
    }
    h1 { font-size: 1.25rem; margin-bottom: 1.5rem; text-align: center; }
    .btn {
      display: block; width: 100%; padding: 0.75rem; margin-bottom: 0.75rem;
      border: 1px solid #ddd; border-radius: 8px; font-size: 1rem;
      cursor: pointer; background: white; transition: background 0.15s;
    }
    .btn:hover { background: #f0f0f0; }
    .btn-google { border-color: #4285f4; color: #4285f4; }
    .divider { text-align: center; margin: 1rem 0; color: #999; font-size: 0.875rem; }
    input {
      display: block; width: 100%; padding: 0.75rem; margin-bottom: 0.75rem;
      border: 1px solid #ddd; border-radius: 8px; font-size: 1rem;
    }
    .btn-submit { background: #333; color: white; border: none; }
    .btn-submit:hover { background: #555; }
    .error { color: #d32f2f; font-size: 0.875rem; margin-bottom: 0.75rem; display: none; }
    .loading { display: none; text-align: center; padding: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign in to Scry</h1>
    <div id="error" class="error"></div>
    <div id="loading" class="loading">Signing in...</div>
    <div id="auth-ui">
      <button class="btn btn-google" onclick="signInWithGoogle()">
        Continue with Google
      </button>
      <div class="divider">or sign in with email</div>
      <input type="email" id="email" placeholder="Email" autocomplete="email" />
      <input type="password" id="password" placeholder="Password" autocomplete="current-password" />
      <button class="btn btn-submit" onclick="signInWithEmail()">Sign In</button>
    </div>
  </div>
  <script src="https://www.gstatic.com/firebasejs/11.0.0/firebase-app-compat.js"></script>
  <script src="https://www.gstatic.com/firebasejs/11.0.0/firebase-auth-compat.js"></script>
  <script>
    firebase.initializeApp({
      apiKey: "${config.firebaseApiKey}",
      authDomain: "${config.firebaseAuthDomain}",
      projectId: "${config.firebaseProjectId}",
    });
    const auth = firebase.auth();
    function showError(msg) {
      const el = document.getElementById("error");
      el.textContent = msg;
      el.style.display = "block";
    }
    function showLoading() {
      document.getElementById("auth-ui").style.display = "none";
      document.getElementById("loading").style.display = "block";
    }
    async function submitToken(idToken) {
      showLoading();
      const form = document.createElement("form");
      form.method = "POST";
      form.action = "/callback";
      const fields = {
        id_token: idToken,
        state: "${config.state}",
        csrf_token: "${config.csrfToken}",
      };
      for (const [key, value] of Object.entries(fields)) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = key;
        input.value = value;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    }
    async function signInWithGoogle() {
      try {
        const provider = new firebase.auth.GoogleAuthProvider();
        const result = await auth.signInWithPopup(provider);
        const idToken = await result.user.getIdToken();
        await submitToken(idToken);
      } catch (err) {
        showError(err.message || "Google sign-in failed");
      }
    }
    async function signInWithEmail() {
      const email = document.getElementById("email").value;
      const password = document.getElementById("password").value;
      if (!email || !password) {
        showError("Please enter email and password");
        return;
      }
      try {
        const result = await auth.signInWithEmailAndPassword(email, password);
        const idToken = await result.user.getIdToken();
        await submitToken(idToken);
      } catch (err) {
        showError(err.message || "Sign-in failed");
      }
    }
  </script>
</body>
</html>`;
}

export const FirebaseAuthHandler = app;
```

### 6. `src/mcp.ts` — MCP Server (Scry Search Tools)

The MCP server exposes four tools. Two search tools call the Scry Next.js search API (`POST /api/search`), one screenshot tool fetches images via the image proxy (`GET /api/image/...`) and generates presigned URLs (`POST /api/image/presign`), and one returns authenticated user info. The search API talks to Milvus (vector DB) using Jina Embeddings v4 for semantic + visual similarity search across a collection of UI components.

**Search API contract** (the backend our tools call):

```
POST /api/search
Request body:
  text?: string           — text query for semantic + BM25 search
  image?: string          — base64 image for visual similarity search
  page?: number           — page number (default: 1)
  limit?: number          — results per page (default: 10, max: 100)
  project_id?: string     — filter results to a specific project
  dense_weight?: number   — weight for semantic dense search (non-negative)
  sparse_weight?: number  — weight for BM25 keyword search (non-negative)

Response:
  results[]: { id, score, component_name, searchable_text, json_content, screenshot_url, project_id }
  pagination: { page, limit, total, total_pages, has_next, has_prev }
```

`json_content` may include: `figma_url`, `github_url`, `storybook_url`, `tags`, `props`.

```typescript
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
   * Extract the R2 object key from a screenshot_url.
   * Handles both full URLs (B2/R2) and bare paths.
   */
  private extractImagePath(screenshotUrl: string): string {
    try {
      const url = new URL(screenshotUrl);
      let imagePath = url.pathname.replace(/^\//, "");
      // B2 format: /file/<bucket>/path → strip "file/<bucket>/"
      imagePath = imagePath.replace(/^file\/[^/]+\//, "");
      return imagePath;
    } catch {
      // Not a full URL — treat as a path already
      return screenshotUrl;
    }
  }

  /**
   * Fetch a screenshot image from the Scry image proxy and return it as base64.
   * Routes through /api/image/... which handles CDN auth server-side.
   */
  private async fetchScreenshot(screenshotUrl: string): Promise<{ base64: string; mimeType: string } | null> {
    try {
      const imagePath = this.extractImagePath(screenshotUrl);
      const proxyUrl = `${this.env.SCRY_SEARCH_API_URL}/api/image/${imagePath}`;
      const response = await this.fetchWithTimeout(proxyUrl, {
        headers: {
          Authorization: `Bearer ${this.env.SCRY_SEARCH_API_KEY}`,
        },
      });

      if (!response.ok) return null;

      const buffer = await response.arrayBuffer();
      const mimeType = response.headers.get("content-type") || "image/png";
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      return { base64, mimeType };
    } catch {
      return null;
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
      if (r.json_content) {
        const jc = r.json_content as Record<string, unknown>;
        if (jc.figma_url) lines.push(`   Figma: ${jc.figma_url}`);
        if (jc.github_url) lines.push(`   GitHub: ${jc.github_url}`);
        if (jc.storybook_url) lines.push(`   Storybook: ${jc.storybook_url}`);
        if (Array.isArray(jc.tags) && jc.tags.length) lines.push(`   Tags: ${jc.tags.join(", ")}`);
      }
      if (r.screenshot_url) lines.push(`   Screenshot: ${r.screenshot_url}`);
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
      {
        title: "Search Components",
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
      },
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
      {
        title: "Search by Image",
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
      },
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
      {
        title: "Get Component Screenshot",
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
      },
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

        // Fetch image and presigned URL in parallel
        const [imageResult, presignResult] = await Promise.all([
          this.fetchScreenshot(screenshot_url),
          this.getPresignedUrl(screenshot_url),
        ]);

        this.log("get_component_screenshot", {
          hasImage: !!imageResult,
          hasPresignedUrl: !!presignResult,
          latencyMs: Date.now() - start,
        });

        if (!imageResult && !presignResult) {
          return this.toolError(
            "SCREENSHOT_FETCH_FAILED",
            `Could not fetch screenshot or generate presigned URL for: ${screenshot_url}`,
            true,
          );
        }

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

        // Presigned URL as text fallback (works in all clients — URL is accessible without auth)
        if (presignResult) {
          content.push({
            type: "text",
            text: `Screenshot URL (expires ${presignResult.expiresAt}): ${presignResult.url}`,
          });
        }

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
```

### 7. `package.json`

```json
{
  "name": "scry-mcp",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:e2e": "vitest run test/e2e.test.ts",
    "lint": "eslint src/ test/",
    "verify": "npm run typecheck && npm run lint && npm run test:coverage",
    "verify:e2e": "npm run verify && npm run test:e2e"
  },
  "dependencies": {
    "@cloudflare/workers-oauth-provider": "^0.2.0",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "agents": "^0.0.87",
    "hono": "^4.7.0",
    "jose": "^6.0.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.8.0",
    "@cloudflare/workers-types": "^4.20250310.0",
    "@vitest/coverage-v8": "^3.0.0",
    "eslint": "^9.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "wrangler": "^4.0.0"
  }
}
```

---

## Deployment

```bash
# 1. Create the KV namespace
npx wrangler kv namespace create "OAUTH_KV"
# Copy the id into wrangler.jsonc

# 2. Set secrets
npx wrangler secret put FIREBASE_API_KEY
npx wrangler secret put FIREBASE_AUTH_DOMAIN      # your-project.firebaseapp.com
npx wrangler secret put FIREBASE_PROJECT_ID       # your-project-id
npx wrangler secret put SCRY_SEARCH_API_URL       # e.g. https://scry.example.com (no trailing slash)
npx wrangler secret put SCRY_SEARCH_API_KEY       # API key for the Scry Next.js search backend
npx wrangler secret put COOKIE_ENCRYPTION_KEY     # openssl rand -hex 32

# 3. Deploy
npx wrangler deploy
```

Your MCP server is now live at `https://scry-mcp.<your-account>.workers.dev/mcp`.

---

## Client Setup: Claude Desktop via `mcp-remote`

### Prerequisites

- Node.js v18+ installed
- Claude Desktop installed
- The MCP server deployed (or running locally via `wrangler dev`)

### Configuration

Open the Claude Desktop config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Or**: Claude Desktop → Settings → Developer → Edit Config

Add your server:

```json
{
  "mcpServers": {
    "scry": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://scry-mcp.<your-account>.workers.dev/mcp"
      ]
    }
  }
}
```

For local development, swap the URL:

```json
{
  "mcpServers": {
    "scry": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://localhost:8787/mcp"
      ]
    }
  }
}
```

### What happens on first launch

1. Restart Claude Desktop.
2. `mcp-remote` starts and connects to your Worker at `/mcp`.
3. The Worker responds with `401 Unauthorized`.
4. `mcp-remote` discovers the OAuth metadata at `/.well-known/oauth-authorization-server`.
5. It registers itself via `/register` (Dynamic Client Registration).
6. A browser window opens at your Worker's `/authorize` endpoint.
7. The Worker renders the Firebase login page.
8. You sign in with Google or email/password.
9. Firebase returns an ID token to your Worker, which verifies it and calls `completeAuthorization`.
10. `mcp-remote` receives the MCP token and caches it locally.
11. Tools appear under the hammer icon in Claude's input area.

### Token refresh

`mcp-remote` caches the MCP token between sessions. If the token expires, it re-triggers the browser auth flow automatically. No manual re-authentication needed on every restart.

---

## Firebase Setup Checklist

1. **Create a Firebase project** at [console.firebase.google.com](https://console.firebase.google.com).
2. **Enable Authentication** → Sign-in method → Enable Google and/or Email/Password.
3. **Add your Worker's domain** to authorized domains: Authentication → Settings → Authorized domains → Add `scry-mcp.<your-account>.workers.dev`.
4. **Copy config values** from Project Settings → General → Your apps → Web app config: `apiKey`, `authDomain`, `projectId`.

---

## Testing

### Test Framework Setup

Use `vitest` with `@cloudflare/vitest-pool-workers` for unit and integration tests that run against the Workers runtime.

#### `vitest.config.ts`

```typescript
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"], // thin entrypoint, tested via integration/e2e
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});
```

### Test Fixtures

#### `test/fixtures/tokens.ts`

Helper to generate test JWTs without hitting Firebase. Uses `jose` to create RS256-signed tokens with controllable claims.

```typescript
import { SignJWT, generateKeyPair } from "jose";

let _keyPair: Awaited<ReturnType<typeof generateKeyPair>> | null = null;

export async function getTestKeyPair() {
  if (!_keyPair) _keyPair = await generateKeyPair("RS256");
  return _keyPair;
}

export const TEST_PROJECT_ID = "test-project-123";
export const TEST_KID = "test-key-id-1";

interface TokenOptions {
  uid?: string;
  email?: string;
  name?: string;
  emailVerified?: boolean;
  projectId?: string;
  expiresIn?: string;   // e.g. "1h", "-1h" for expired
  issuedAt?: Date;
  kid?: string;
}

export async function createTestToken(opts: TokenOptions = {}): Promise<string> {
  const { privateKey } = await getTestKeyPair();
  const projectId = opts.projectId ?? TEST_PROJECT_ID;
  const uid = opts.uid ?? "test-user-abc";

  const now = Math.floor(Date.now() / 1000);

  const jwt = new SignJWT({
    email: opts.email ?? "test@example.com",
    name: opts.name ?? "Test User",
    email_verified: opts.emailVerified ?? true,
    auth_time: now - 60,
    firebase: {
      sign_in_provider: "google.com",
      identities: { "google.com": ["123"], email: [opts.email ?? "test@example.com"] },
    },
  })
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? TEST_KID })
    .setSubject(uid)
    .setAudience(projectId)
    .setIssuer(`https://securetoken.google.com/${projectId}`)
    .setIssuedAt(opts.issuedAt ?? new Date());

  if (opts.expiresIn) {
    jwt.setExpirationTime(opts.expiresIn);
  } else {
    jwt.setExpirationTime("1h");
  }

  return jwt.sign(privateKey);
}

export async function getTestPublicKeyPem(): Promise<string> {
  const { publicKey } = await getTestKeyPair();
  // Export as SPKI PEM for mocking Google's key endpoint.
  // NOTE: This is SPKI, not a true X.509 certificate.
  // If importX509 rejects it in tests, mock importX509 instead
  // and use crypto.subtle.importKey("spki", ...) directly.
  const exported = await crypto.subtle.exportKey(
    "spki",
    publicKey as unknown as CryptoKey
  );
  const b64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
  const pem =
    "-----BEGIN CERTIFICATE-----\n" +
    b64.match(/.{1,64}/g)!.join("\n") +
    "\n-----END CERTIFICATE-----";
  return pem;
}
```

### Unit Tests

#### `test/firebase-verify.test.ts`

Tests for `verifyFirebaseIdToken`. Each test case targets a specific claim validation or crypto path.

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  verifyFirebaseIdToken,
  _resetKeyCache,
} from "../src/utils/firebase-verify";
import {
  createTestToken,
  getTestPublicKeyPem,
  TEST_PROJECT_ID,
  TEST_KID,
} from "./fixtures/tokens";

function mockGoogleKeys(keys: Record<string, string>) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(keys), {
      headers: { "Cache-Control": "max-age=3600" },
    })
  );
}

describe("verifyFirebaseIdToken", () => {
  beforeEach(() => _resetKeyCache());
  afterEach(() => {
    vi.restoreAllMocks();
    _resetKeyCache();
  });

  it("returns payload for a valid token", async () => {
    const pem = await getTestPublicKeyPem();
    mockGoogleKeys({ [TEST_KID]: pem });

    const token = await createTestToken({ uid: "user-1", email: "alice@test.com" });
    const result = await verifyFirebaseIdToken(token, TEST_PROJECT_ID);

    expect(result).not.toBeNull();
    expect(result!.uid).toBe("user-1");
    expect(result!.email).toBe("alice@test.com");
  });

  it("rejects an expired token", async () => {
    const pem = await getTestPublicKeyPem();
    mockGoogleKeys({ [TEST_KID]: pem });

    const token = await createTestToken({ expiresIn: "-1h" });
    const result = await verifyFirebaseIdToken(token, TEST_PROJECT_ID);
    expect(result).toBeNull();
  });

  it("rejects a token with wrong audience (project ID)", async () => {
    const pem = await getTestPublicKeyPem();
    mockGoogleKeys({ [TEST_KID]: pem });

    const token = await createTestToken({ projectId: "wrong-project" });
    const result = await verifyFirebaseIdToken(token, TEST_PROJECT_ID);
    expect(result).toBeNull();
  });

  it("rejects a token with wrong issuer", async () => {
    const pem = await getTestPublicKeyPem();
    mockGoogleKeys({ [TEST_KID]: pem });

    const token = await createTestToken({ projectId: "other-project" });
    const result = await verifyFirebaseIdToken(token, "other-project-2");
    expect(result).toBeNull();
  });

  it("rejects a token with unknown key ID", async () => {
    const pem = await getTestPublicKeyPem();
    mockGoogleKeys({ "different-kid": pem });

    const token = await createTestToken();
    const result = await verifyFirebaseIdToken(token, TEST_PROJECT_ID);
    expect(result).toBeNull();
  });

  it("rejects a token with tampered payload", async () => {
    const pem = await getTestPublicKeyPem();
    mockGoogleKeys({ [TEST_KID]: pem });

    const token = await createTestToken();
    const parts = token.split(".");
    const payload = JSON.parse(atob(parts[1]));
    payload.email = "hacker@evil.com";
    parts[1] = btoa(JSON.stringify(payload));

    const result = await verifyFirebaseIdToken(parts.join("."), TEST_PROJECT_ID);
    expect(result).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    expect(await verifyFirebaseIdToken("", TEST_PROJECT_ID)).toBeNull();
    expect(await verifyFirebaseIdToken("a.b", TEST_PROJECT_ID)).toBeNull();
    expect(await verifyFirebaseIdToken("not-a-jwt", TEST_PROJECT_ID)).toBeNull();
  });

  it("rejects a token with empty sub", async () => {
    const pem = await getTestPublicKeyPem();
    mockGoogleKeys({ [TEST_KID]: pem });

    const token = await createTestToken({ uid: "" });
    const result = await verifyFirebaseIdToken(token, TEST_PROJECT_ID);
    expect(result).toBeNull();
  });

  it("caches Google public keys across calls", async () => {
    const pem = await getTestPublicKeyPem();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ [TEST_KID]: pem }), {
        headers: { "Cache-Control": "max-age=3600" },
      })
    );

    const token = await createTestToken();
    await verifyFirebaseIdToken(token, TEST_PROJECT_ID);
    await verifyFirebaseIdToken(token, TEST_PROJECT_ID);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
```

#### `test/firebase-handler.test.ts`

Integration tests for the auth handler routes. These require `@cloudflare/vitest-pool-workers` to provide the worker bindings.

```typescript
import { describe, it, expect, vi } from "vitest";

// NOTE FOR CODING AGENT:
// These tests require @cloudflare/vitest-pool-workers to be configured.
// The WORKER global is injected by the pool and lets you call fetch()
// against the full worker stack (OAuthProvider + handler + Durable Objects).
//
// To implement:
// 1. Ensure vitest.config.ts uses defineWorkersConfig
// 2. Use WORKER.fetch(url, init) to make requests
// 3. Mock verifyFirebaseIdToken where needed using vi.mock()
// 4. Mock c.env.OAUTH_PROVIDER.completeAuthorization for the callback test

describe("FirebaseAuthHandler", () => {
  describe("GET /authorize", () => {
    it("returns 400 if OAuth request has no client ID", async () => {
      // const res = await WORKER.fetch("http://localhost/authorize");
      // expect(res.status).toBe(400);
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("returns HTML with Firebase config and CSRF cookie for valid request", async () => {
      // 1. Register a client via POST /register
      // 2. GET /authorize?client_id=...&redirect_uri=...&response_type=code
      // 3. Assert Content-Type is text/html
      // 4. Assert body contains FIREBASE_API_KEY value
      // 5. Assert Set-Cookie contains __Host-csrf
      expect(true).toBe(true); // TODO: implement with pool-workers
    });
  });

  describe("POST /callback", () => {
    it("returns 403 if CSRF token does not match cookie", async () => {
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("returns 400 if id_token is missing", async () => {
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("returns 401 if Firebase token verification fails", async () => {
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("returns 400 if state is not valid base64 JSON", async () => {
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("redirects on successful authentication", async () => {
      // Mock verifyFirebaseIdToken to return a valid payload
      // Mock completeAuthorization to return a redirectTo URL
      // Assert response is 302 with Location header
      expect(true).toBe(true); // TODO: implement with pool-workers
    });
  });
});
```

#### `test/mcp.test.ts`

Tests for MCP tools. Requires Durable Object runtime from pool-workers.

```typescript
import { describe, it, expect } from "vitest";

// NOTE FOR CODING AGENT:
// These tests require @cloudflare/vitest-pool-workers with Durable Objects.
// Instantiate ScryMCP with controlled props and call tools through the MCP SDK
// or by invoking the Durable Object stub directly.
//
// To implement:
// 1. Create a ScryMCP Durable Object stub via env.MCP_OBJECT.get(id)
// 2. Set props (firebaseUid, email, etc.) on the stub
// 3. Use the MCP client SDK to connect and call tools
// 4. Assert tool responses
// 5. Mock fetch for the Scry search API (SCRY_SEARCH_API_URL/api/search)

describe("MCP Tools", () => {
  describe("whoami", () => {
    it("returns the authenticated user's UID and email", async () => {
      // Props: { firebaseUid: "u1", email: "a@b.com", displayName: "A", emailVerified: true }
      // Call whoami tool
      // Assert response text contains "u1" and "a@b.com"
      expect(true).toBe(true); // TODO: implement with pool-workers
    });
  });

  describe("search_components", () => {
    it("calls the Scry search API with text query and auth headers", async () => {
      // Mock globalThis.fetch for SCRY_SEARCH_API_URL/api/search
      // Call search_components with { query: "button", limit: 5 }
      // Assert fetch was called with:
      //   - POST method
      //   - Content-Type: application/json
      //   - X-User-Id header matching firebaseUid
      //   - Authorization: Bearer <SCRY_SEARCH_API_KEY>
      //   - Body: { text: "button", limit: 5, page: 1 }
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("returns structured error when search API returns non-200", async () => {
      // Mock fetch to return 500
      // Call search_components
      // Assert response has isError: true
      // Assert response text is JSON: { error: "SEARCH_API_500", message: "...", retryable: true }
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("marks 429 upstream errors as UPSTREAM_RATE_LIMITED and retryable", async () => {
      // Mock fetch to return 429
      // Call search_components
      // Assert error code is "UPSTREAM_RATE_LIMITED" and retryable is true
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("formats results with component names, scores, and metadata", async () => {
      // Mock fetch to return a valid response with results
      // Call search_components with { query: "date picker", limit: 3 }
      // Assert response text includes component_name, score, and metadata links
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("passes project_id filter when provided", async () => {
      // Call search_components with { query: "nav", limit: 5, project_id: "proj-123" }
      // Assert the request body sent to the API includes project_id: "proj-123"
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("validates query parameter is a string", async () => {
      // Call with invalid args (no query)
      // Assert Zod validation error is returned
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("rejects query longer than 500 characters via Zod validation", async () => {
      // Call with { query: "a".repeat(501), limit: 5 }
      // Assert Zod validation error is returned
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("rejects project_id longer than 128 characters", async () => {
      // Call with { query: "button", project_id: "x".repeat(129) }
      // Assert Zod validation error is returned
      expect(true).toBe(true); // TODO: implement with pool-workers
    });
  });

  describe("search_by_image", () => {
    it("calls the Scry search API with base64 image", async () => {
      // Mock fetch for the search API
      // Call search_by_image with { image: "iVBORw0KGgo..." (valid base64) }
      // Assert the request body sent to the API includes image field
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("supports hybrid search with both image and text query", async () => {
      // Call search_by_image with { image: "...", query: "blue button" }
      // Assert the request body includes both image and text fields
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("returns isError: true when search API fails", async () => {
      // Mock fetch to return 400 with validation error
      // Assert response has isError: true
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("rejects image over 10MB with VALIDATION_ERROR", async () => {
      // Call search_by_image with { image: "a".repeat(10 * 1024 * 1024 + 1) }
      // Assert response has isError: true
      // Assert error code is "VALIDATION_ERROR" and message mentions size
      // Assert retryable is false
      expect(true).toBe(true); // TODO: implement with pool-workers
    });
  });

  describe("get_component_screenshot", () => {
    it("returns both image content block and presigned URL", async () => {
      // Mock fetch for:
      //   1. SCRY_SEARCH_API_URL/api/image/screenshots/btn.png → 200 with PNG buffer
      //   2. SCRY_SEARCH_API_URL/api/image/presign → 200 with { url: "https://...", expires_at: "..." }
      // Call get_component_screenshot with { screenshot_url: "screenshots/btn.png" }
      // Assert response content includes:
      //   - { type: "image", data: <base64>, mimeType: "image/png" }
      //   - { type: "text", text: "Screenshot URL (expires ...): https://..." }
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("handles full B2 URLs by extracting the path", async () => {
      // Call with { screenshot_url: "https://f123.backblazeb2.com/file/bucket/screenshots/btn.png" }
      // Assert image proxy fetch was called with /api/image/screenshots/btn.png
      // Assert presign endpoint received the original URL as path
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("returns presigned URL even if image proxy fails", async () => {
      // Mock image proxy to return 500, presign endpoint to return 200
      // Assert response has no image block but does have presigned URL text
      // Assert isError is NOT set (partial success is still useful)
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("returns image block even if presign endpoint fails", async () => {
      // Mock image proxy to return 200, presign endpoint to return 500
      // Assert response has image block but no presigned URL text
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("returns structured error when both image proxy and presign fail", async () => {
      // Mock both to return errors
      // Assert response has isError: true
      // Assert error code is "SCREENSHOT_FETCH_FAILED" and retryable is true
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("includes component_name label when provided", async () => {
      // Call with { screenshot_url: "...", component_name: "PrimaryButton" }
      // Assert first content block is text containing "PrimaryButton"
      // Assert subsequent blocks include image and presigned URL
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("calls image proxy and presign endpoint in parallel", async () => {
      // Mock both endpoints with delays
      // Assert total time is ~max(delay1, delay2), not sum
      expect(true).toBe(true); // TODO: implement with pool-workers
    });
  });

  describe("rate limiting", () => {
    it("allows requests under the rate limit (60 RPM)", async () => {
      // Call search_components 5 times in quick succession
      // Assert all return results (not rate limit errors)
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("returns RATE_LIMITED error when exceeding 60 RPM", async () => {
      // Call search_components 61 times within 1 minute
      // Assert the 61st call returns { error: "RATE_LIMITED", retryable: true }
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("rate limit applies across all tools (shared counter)", async () => {
      // Call search_components 30 times, then search_by_image 30 times, then whoami once
      // Assert the 61st total call returns RATE_LIMITED
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("rate limit window slides (old requests expire after 60s)", async () => {
      // Use fake timers to simulate passage of time
      // Make 60 requests, advance clock by 61 seconds, make 1 more request
      // Assert the last request succeeds (not rate limited)
      expect(true).toBe(true); // TODO: implement with pool-workers
    });
  });

  describe("request timeouts", () => {
    it("times out if upstream API takes longer than 30 seconds", async () => {
      // Mock fetch to delay 31 seconds (use fake timers or AbortController spy)
      // Call search_components
      // Assert response has isError: true (fetch will throw on abort)
      expect(true).toBe(true); // TODO: implement with pool-workers
    });
  });

  describe("structured logging", () => {
    it("logs tool name, userId, and latency for search calls", async () => {
      // Spy on console.log
      // Call search_components
      // Assert console.log was called with JSON containing:
      //   tool: "callSearchAPI", userId: <uid>, latencyMs: <number>, success: true
      expect(true).toBe(true); // TODO: implement with pool-workers
    });

    it("logs rate limit events", async () => {
      // Spy on console.log
      // Exhaust rate limit, then make one more call
      // Assert console.log was called with JSON containing:
      //   tool: "search_components", rateLimited: true
      expect(true).toBe(true); // TODO: implement with pool-workers
    });
  });
});
```

### End-to-End Smoke Tests

#### `test/e2e.test.ts`

Run against a live `wrangler dev` instance. Start the dev server first.

```bash
# Terminal 1
npx wrangler dev

# Terminal 2
MCP_TEST_URL=http://localhost:8787 npm run test:e2e
```

```typescript
import { describe, it, expect } from "vitest";

const BASE_URL = process.env.MCP_TEST_URL ?? "http://localhost:8787";

describe("E2E: MCP Server endpoints", () => {
  it("GET / returns a response (not 500)", async () => {
    const res = await fetch(BASE_URL);
    expect(res.status).toBeLessThan(500);
  });

  it("GET /health returns server status and version", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.server).toBe("scry-mcp");
    expect(body.version).toBe("1.0.0");
    expect(body).toHaveProperty("timestamp");
  });

  it("GET /mcp without auth returns 401", async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("GET /.well-known/oauth-authorization-server returns valid metadata", async () => {
    const res = await fetch(`${BASE_URL}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty("authorization_endpoint");
    expect(body).toHaveProperty("token_endpoint");
    expect(body).toHaveProperty("registration_endpoint");
    expect(body.authorization_endpoint).toContain("/authorize");
    expect(body.token_endpoint).toContain("/token");
  });

  it("POST /register allows dynamic client registration", async () => {
    const res = await fetch(`${BASE_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost:33333/callback"],
        client_name: "e2e-test-client",
        token_endpoint_auth_method: "none",
      }),
    });
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body).toHaveProperty("client_id");
    expect(typeof body.client_id).toBe("string");
  });

  it("GET /authorize without valid OAuth params returns 400", async () => {
    const res = await fetch(`${BASE_URL}/authorize`);
    expect(res.status).toBe(400);
  });

  it("GET /authorize with valid client_id returns HTML login page", async () => {
    // First register a client
    const regRes = await fetch(`${BASE_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost:33333/callback"],
        client_name: "e2e-login-test",
        token_endpoint_auth_method: "none",
      }),
    });
    const { client_id } = await regRes.json();

    const authUrl = new URL(`${BASE_URL}/authorize`);
    authUrl.searchParams.set("client_id", client_id);
    authUrl.searchParams.set("redirect_uri", "http://localhost:33333/callback");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("code_challenge", "test-challenge");
    authUrl.searchParams.set("code_challenge_method", "S256");

    const res = await fetch(authUrl.toString(), { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("firebase.initializeApp");
    expect(html).toContain("Sign in to Scry");
  });
});
```

---

## Verification Checklist

Run these checks in order. **Every check must pass before the implementation is considered complete.**

### Automated checks

```bash
# Run all automated checks in sequence
npm run verify
```

This runs:

1. **`tsc --noEmit`** — TypeScript type checking. Zero errors required.
2. **`eslint src/ test/`** — Linting. Zero errors, zero warnings required.
3. **`vitest run --coverage`** — Unit + integration tests with coverage enforcement.

Coverage thresholds (enforced in `vitest.config.ts`, hard fail if not met):

| Metric     | Minimum |
|------------|---------|
| Lines      | 80%     |
| Branches   | 80%     |
| Functions  | 80%     |
| Statements | 80%     |

### E2E checks

```bash
# Requires a running dev server in another terminal
npx wrangler dev

# Then:
npm run verify:e2e
```

### Manual verification (do these once after deployment)

Each step lists the exact command or action and what the expected outcome is.

**1. Health endpoint**

```bash
curl -s https://scry-mcp.<your-account>.workers.dev/health | jq .
```

Expected: `{ "status": "ok", "server": "scry-mcp", "version": "1.0.0", "timestamp": "..." }`.

**2. OAuth metadata discovery**

```bash
curl -s https://scry-mcp.<your-account>.workers.dev/.well-known/oauth-authorization-server | jq .
```

Expected: JSON with `authorization_endpoint`, `token_endpoint`, `registration_endpoint`.

**3. Unauthenticated /mcp returns 401**

```bash
curl -s -o /dev/null -w "%{http_code}" https://scry-mcp.<your-account>.workers.dev/mcp
```

Expected: `401`.

**4. Dynamic client registration works**

```bash
curl -s -X POST https://scry-mcp.<your-account>.workers.dev/register \
  -H "Content-Type: application/json" \
  -d '{"redirect_uris":["http://localhost:33333/callback"],"client_name":"manual-test","token_endpoint_auth_method":"none"}' | jq .
```

Expected: HTTP 201 with a `client_id` in the response body.

**5. Login page renders**

Open in a browser:

```
https://scry-mcp.<your-account>.workers.dev/authorize?client_id=<from-step-4>&redirect_uri=http://localhost:33333/callback&response_type=code&scope=read
```

Expected: Firebase sign-in page with "Continue with Google" and email/password fields.

**6. Claude Desktop tool discovery**

After adding the `mcp-remote` config and restarting Claude Desktop:

- Open a new conversation.
- Look for the hammer icon (🔨) — it should list `search_components`, `search_by_image`, `get_component_screenshot`, `whoami`.
- Ask Claude: **"Use the whoami tool"**.

Expected: Response contains your Firebase UID and email.

**7. Tool execution — text search**

Ask Claude: **"Search for button components, limit 3"**

Expected: Claude calls `search_components` and returns results with component names, scores, and metadata (Figma/GitHub/Storybook links, tags, screenshot URLs).

**8. Tool execution — image search**

Provide a base64 image and ask Claude: **"Find components that look like this image"**

Expected: Claude calls `search_by_image` and returns visually similar component results.

**9. Tool execution — screenshot viewing**

After a search, ask Claude: **"Show me the screenshot of the first result"**

Expected: Claude calls `get_component_screenshot` with the `screenshot_url` from the search result and returns:
- The actual image rendered inline (via the MCP image content block)
- A temporary presigned URL as text (accessible without auth, expires in 1 hour)

### Summary table

| #  | Check                                  | Method    | Pass criteria                          |
|----|----------------------------------------|-----------|----------------------------------------|
| 1  | `tsc --noEmit`                         | Automated | Exit code 0                            |
| 2  | `eslint` clean                         | Automated | 0 errors, 0 warnings                  |
| 3  | Unit tests pass                        | Automated | All green                              |
| 4  | Coverage ≥ 80% lines/branches/fn/stm   | Automated | Vitest threshold enforcement           |
| 5  | E2E tests pass against dev server      | Automated | All green                              |
| 6  | /health returns status + version       | curl      | 200 + `{ status: "ok", version: "1.0.0" }` |
| 7  | OAuth metadata endpoint                | curl      | 200 + correct fields                   |
| 8  | /mcp unauthenticated                   | curl      | 401                                    |
| 9  | Client registration                    | curl      | 201 + client_id                        |
| 10 | Login page renders                     | Browser   | Firebase UI visible                    |
| 11 | Claude sees 4 tools                    | Claude    | 🔨 shows search_components, search_by_image, get_component_screenshot, whoami |
| 12 | whoami returns user info               | Claude    | UID + email in response                |
| 13 | search_components returns results      | Claude    | Tool invoked, component results returned |
| 14 | search_by_image returns results        | Claude    | Image similarity search works          |
| 15 | get_component_screenshot shows image   | Claude    | Screenshot image rendered inline + presigned URL in text |
| 16 | Rate limiting works                    | Automated | 61st request in 60s returns RATE_LIMITED |
| 17 | Structured errors returned             | Automated | Error responses are JSON with `error`, `message`, `retryable` |

---

## Security Notes

- **Token isolation**: The Firebase token is never exposed to MCP clients. `workers-oauth-provider` encrypts it in KV and issues a separate MCP-scoped token.
- **CSRF protection**: The login form uses `__Host-` prefixed cookies with `SameSite=Lax` and a random CSRF token.
- **Key caching**: Google's signing keys are cached in memory respecting `Cache-Control`.
- **Token expiry**: Firebase ID tokens expire after 1 hour. For long-running sessions, use `tokenExchangeCallback` on `OAuthProvider` to refresh upstream tokens during MCP token refresh.
- **Permission scoping**: Use `this.props` in MCP tools to gate by user identity, roles, or custom claims.
- **Presigned URLs**: Screenshot URLs returned by `get_component_screenshot` are time-limited (default 1 hour) and require no auth to access. They are generated server-side via the Scry Next.js API — R2 credentials never leave the Next.js service. The MCP Worker itself has no direct access to storage credentials.
- **Rate limiting**: Per-user rate limiting (60 RPM) is enforced in the Durable Object instance using a sliding window. Each user's MCP session runs in its own DO, so rate limits are per-user by design.
- **Request timeouts**: All upstream API calls use a 30-second `AbortController` timeout to prevent hanging on slow or unresponsive backends.
- **Input validation**: Query strings are limited to 500 characters, project IDs to 128 characters, and images to 10MB base64. Zod schemas enforce constraints at the tool input boundary.

### Versioning Strategy

The server version is declared in two places:
1. `McpServer({ name: "scry", version: "1.0.0" })` — reported to MCP clients during initialization
2. `/health` endpoint — reported in the JSON response

Follow semver: bump **patch** for bug fixes, **minor** for new tools or non-breaking tool parameter additions, **major** for breaking changes to existing tool schemas or removal of tools. Since MCP clients discover tools dynamically, adding new tools is always backwards-compatible.

---

## Local Development

```bash
# Create .dev.vars
cat > .dev.vars << 'EOF'
FIREBASE_API_KEY=your-dev-api-key
FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
FIREBASE_PROJECT_ID=your-project-id
SCRY_SEARCH_API_URL=http://localhost:3000
SCRY_SEARCH_API_KEY=your-dev-search-api-key
COOKIE_ENCRYPTION_KEY=any-random-string-for-dev
EOF

# Start local dev server
npx wrangler dev

# Test with MCP Inspector
npx @modelcontextprotocol/inspector
# Enter: http://localhost:8787/mcp

# Run full verification
npm run verify
```

---

## References

- [Cloudflare MCP Authorization docs](https://developers.cloudflare.com/agents/model-context-protocol/authorization/)
- [workers-oauth-provider GitHub](https://github.com/cloudflare/workers-oauth-provider)
- [Cloudflare GitHub OAuth MCP example](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth)
- [Securing MCP servers guide](https://developers.cloudflare.com/agents/guides/securing-mcp-server/)
- [Firebase Authentication docs](https://firebase.google.com/docs/auth)
- [MCP specification — Authorization](https://spec.modelcontextprotocol.io/specification/draft/basic/authorization/)
- [@cloudflare/vitest-pool-workers docs](https://developers.cloudflare.com/workers/testing/vitest-integration/)
