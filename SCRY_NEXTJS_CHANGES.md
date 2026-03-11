# Scry-NextJS Changes Required for MCP Integration

The scry-mcp server calls three endpoints on the scry-nextjs API. Here's what exists, what's missing, and what needs to change.

---

## Status Overview

| Endpoint | Status | Work Required |
|----------|--------|---------------|
| `POST /api/search` | Ready | None — fully implemented, matches MCP contract |
| `GET /api/image/[...path]` | Ready | None — works via CDN Worker proxy |
| `POST /api/image/presign` | **Missing** | New route (~80 lines) |
| API authentication | **Missing** | Bearer token validation on all 3 endpoints |

---

## 1. `POST /api/image/presign` — New Endpoint

**File to create**: `app/api/image/presign/route.ts`

**What it does**: Accepts a screenshot path/URL from the MCP server, extracts the R2 object key, and returns a time-limited presigned URL that requires no auth to access.

**Request contract** (what the MCP server sends):

```json
POST /api/image/presign
Authorization: Bearer <SCRY_SEARCH_API_KEY>

{
  "path": "screenshots/project-123/button.png",
  "expires_in": 3600
}
```

- `path` (string, required): Screenshot path or full URL from search results
- `expires_in` (number, optional): TTL in seconds. Default 3600, max 86400.

**Response contract** (what the MCP server expects):

```json
{
  "url": "https://scry-component-snapshot-bucket.f54b...r2.cloudflarestorage.com/screenshots/...?X-Amz-...",
  "expires_at": "2026-03-11T19:30:00.000Z"
}
```

**Implementation approach**:

1. Validate the `Authorization: Bearer` header
2. Parse the request body, validate `path` and `expires_in`
3. Extract the R2 object key from `path` using `extractStorageKey()` from `lib/storage-utils.ts`
4. Create an S3Client pointing at the R2 endpoint (credentials already in env)
5. Use `getSignedUrl()` from `@aws-sdk/s3-request-presigner` with `GetObjectCommand`
6. Return the presigned URL and expiration timestamp

**Reference code**: `scripts/generate-presigned-url.cjs` already has the full presigning logic.

**Environment variables needed** (all already configured):

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_ACCESS_KEY_ID`
- `CLOUDFLARE_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`

**Dependencies needed** (all already installed):

- `@aws-sdk/client-s3` (v3.879.0)
- `@aws-sdk/s3-request-presigner` (v3.879.0)

---

## 2. API Authentication — New Middleware

**Problem**: All three API routes are currently open. The MCP server sends `Authorization: Bearer <key>` and `X-User-Id` headers, but nothing validates them.

**Approach**: Add a shared auth helper that each route calls, rather than global middleware (keeps it simple, avoids affecting the rest of the app).

**File to create**: `app/api/_lib/auth.ts`

```typescript
// Validates the API key from the Authorization header.
// Returns the API key on success, throws on failure.
export function validateApiKey(request: Request): string {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Response("Missing or invalid Authorization header", { status: 401 });
  }
  const token = authHeader.slice(7);
  if (token !== process.env.SCRY_API_KEY) {
    throw new Response("Invalid API key", { status: 403 });
  }
  return token;
}
```

**New environment variable**:

- `SCRY_API_KEY`: The API key that the MCP server uses to authenticate. Set this to the same value as the MCP server's `SCRY_SEARCH_API_KEY`.

**Routes to update**:

1. `app/api/search/route.ts` — Add auth check at top of POST handler
2. `app/api/image/[...path]/route.ts` — Add auth check at top of GET handler
3. `app/api/image/presign/route.ts` — Add auth check (build it in from the start)

**Decision**: Use a simple shared API key rather than per-user Firebase token validation. The MCP server already handles user authentication via Firebase — it just needs a service-level API key to call the search backend. The `X-User-Id` header is passed through for logging/audit purposes, not for auth.

---

## 3. `POST /api/search` — No Changes Needed

The existing implementation fully matches the MCP contract:

- Accepts `text`, `image`, `page`, `limit`, `project_id`, `dense_weight`, `sparse_weight`
- Returns `results[]` with `id`, `score`, `component_name`, `searchable_text`, `json_content`, `screenshot_url`, `project_id`
- Returns `pagination` with `page`, `limit`, `total`, `total_pages`, `has_next`, `has_prev`
- Input validation via Zod
- Jina v4 embeddings + Milvus hybrid search

No changes required.

---

## 4. `GET /api/image/[...path]` — No Changes Needed

The existing implementation works for the MCP server's needs:

- Accepts catch-all path parameter
- Validates path (prevents traversal attacks)
- Fetches from CDN Worker with auth token
- Returns binary image data with correct `Content-Type`
- Includes caching headers

The MCP server calls it as `GET /api/image/{imagePath}` with a `Bearer` token. The route currently doesn't validate that Bearer token (see item 2 above), but the image fetching logic itself is correct.

No functional changes required beyond adding auth validation.

---

## Implementation Order

### Step 1: Create the auth helper
- File: `app/api/_lib/auth.ts`
- Add `SCRY_API_KEY` to `.env` and Vercel environment variables
- Simple Bearer token validation

### Step 2: Create the presign endpoint
- File: `app/api/image/presign/route.ts`
- Use `scripts/generate-presigned-url.cjs` as reference
- Use `lib/storage-utils.ts` for URL parsing
- Include auth validation from step 1

### Step 3: Add auth to existing routes
- Update `app/api/search/route.ts`
- Update `app/api/image/[...path]/route.ts`
- Add the `validateApiKey()` call at the top of each handler

### Step 4: Test the integration
- Start scry-nextjs locally (`npm run dev`)
- Start scry-mcp locally (`npx wrangler dev`)
- Point scry-mcp's `SCRY_SEARCH_API_URL` at `http://localhost:3000`
- Test each tool via MCP Inspector

---

## Environment Variables Summary

**Already configured** (no action needed):

| Variable | Purpose |
|----------|---------|
| `JINA_API_KEY` | Jina embeddings API |
| `MILVUS_ADDRESS` | Milvus/Zilliz endpoint |
| `MILVUS_TOKEN` | Milvus auth |
| `CLOUDFLARE_ACCOUNT_ID` | R2 presigning |
| `CLOUDFLARE_ACCESS_KEY_ID` | R2 presigning |
| `CLOUDFLARE_SECRET_ACCESS_KEY` | R2 presigning |
| `R2_BUCKET_NAME` | R2 presigning |
| `CDN_WORKER_URL` | Image proxy |
| `CDN_AUTH_TOKEN` | Image proxy |

**New variable to add**:

| Variable | Purpose | Value |
|----------|---------|-------|
| `SCRY_API_KEY` | Authenticate MCP server requests | Must match MCP server's `SCRY_SEARCH_API_KEY` |
