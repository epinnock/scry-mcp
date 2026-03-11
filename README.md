# Scry MCP Server

A spec-compliant remote [MCP](https://modelcontextprotocol.io/) server on Cloudflare Workers that exposes multi-modal vector search over the Scry component database. Authenticates users via Firebase and issues its own OAuth tokens to MCP clients.

Compatible with Claude Desktop, ChatGPT, Cursor, and any MCP client via [`mcp-remote`](https://www.npmjs.com/package/mcp-remote).

## Architecture

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
  ├─ FirebaseAuthHandler (login UI + token verify)
  └─ ScryMCP (Durable Object)
         │
         ▼
  Scry Search API (Next.js)
    ├─ POST /api/search         — vector search (text, image, hybrid)
    ├─ GET  /api/image/...      — image proxy (CDN auth)
    └─ POST /api/image/presign  — presigned URL generation
```

The Worker acts as both an **OAuth server** to MCP clients (issuing its own tokens) and an **OAuth client** to Firebase (authenticating users upstream). The MCP client never sees the Firebase token.

## Tools

| Tool | Description |
|------|-------------|
| `search_components` | Text-based semantic + keyword hybrid search over UI components |
| `search_by_image` | Visual similarity search using base64 image input |
| `get_component_screenshot` | Fetch a component screenshot (returns image block + presigned URL) |
| `whoami` | Returns the authenticated user's info |

## Project Structure

```
scry-mcp/
├── src/
│   ├── index.ts                # Entry point — OAuthProvider wrapper
│   ├── firebase-handler.ts     # Auth handler — login UI + Firebase verification
│   ├── mcp.ts                  # MCP server — 4 Scry search tools
│   └── utils/
│       └── firebase-verify.ts  # Firebase ID token verification (Workers-compatible)
├── test/
│   ├── firebase-verify.test.ts # Unit tests for token verification
│   ├── firebase-handler.test.ts# Integration tests for auth handler
│   ├── mcp.test.ts             # Tests for MCP tools
│   ├── e2e.test.ts             # E2E smoke tests (requires dev server)
│   └── fixtures/
│       └── tokens.ts           # Test JWT fixtures
├── vitest.config.ts
├── wrangler.jsonc
├── package.json
├── tsconfig.json
├── eslint.config.mjs
└── worker-configuration.d.ts
```

## Prerequisites

- Node.js v20+
- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- A [Firebase project](https://console.firebase.google.com) with Authentication enabled
- The Scry Next.js search API running (provides `/api/search` and `/api/image/presign`)

## Local Development

### 1. Install dependencies

```bash
npm install
```

### 2. Create local environment file

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with your values:

```
FIREBASE_API_KEY=your-firebase-api-key
FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
FIREBASE_PROJECT_ID=your-project-id
SCRY_SEARCH_API_URL=http://localhost:3000
SCRY_SEARCH_API_KEY=your-search-api-key
COOKIE_ENCRYPTION_KEY=any-random-string-for-dev
```

### 3. Create the KV namespace

```bash
npx wrangler kv namespace create "OAUTH_KV"
npx wrangler kv namespace create "OAUTH_KV" --preview
```

Copy the returned `id` and `preview_id` into `wrangler.jsonc`.

### 4. Start the dev server

```bash
npm run dev
```

The server runs at `http://localhost:8787`.

### 5. Test with MCP Inspector

```bash
npx @modelcontextprotocol/inspector
# Enter: http://localhost:8787/mcp
```

## Running Tests

```bash
# Unit + integration tests
npm test

# With verbose output
npx vitest run --reporter=verbose

# Watch mode
npm run test:watch

# E2E tests (requires dev server running in another terminal)
npm run dev          # terminal 1
npm run test:e2e     # terminal 2

# Full verification (typecheck + lint + tests)
npm run verify
```

## Deployment

### 1. Set secrets

```bash
npx wrangler secret put FIREBASE_API_KEY
npx wrangler secret put FIREBASE_AUTH_DOMAIN
npx wrangler secret put FIREBASE_PROJECT_ID
npx wrangler secret put SCRY_SEARCH_API_URL
npx wrangler secret put SCRY_SEARCH_API_KEY
npx wrangler secret put COOKIE_ENCRYPTION_KEY    # generate with: openssl rand -hex 32
```

### 2. Deploy

```bash
npx wrangler deploy
```

Your server is live at `https://scry-mcp.<your-account>.workers.dev/mcp`.

### 3. Verify deployment

```bash
# Health check
curl https://scry-mcp.<your-account>.workers.dev/health

# OAuth metadata
curl https://scry-mcp.<your-account>.workers.dev/.well-known/oauth-authorization-server

# Should return 401
curl -s -o /dev/null -w "%{http_code}" https://scry-mcp.<your-account>.workers.dev/mcp
```

## Firebase Setup

1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable Authentication > Sign-in method > Google and/or Email/Password
3. Add your Worker's domain to authorized domains: Authentication > Settings > Authorized domains > Add `scry-mcp.<your-account>.workers.dev`
4. Copy config values from Project Settings > General > Web app config: `apiKey`, `authDomain`, `projectId`

## Client Setup (Claude Desktop)

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

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

For local development:

```json
{
  "mcpServers": {
    "scry": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:8787/mcp"]
    }
  }
}
```

Restart Claude Desktop. On first launch, a browser window opens for Firebase sign-in. After authenticating, the 4 tools appear in Claude's tool picker.

## Auth Flow

```
Claude Desktop        mcp-remote          Worker              Firebase
     │                    │                  │                    │
     │── start ──────────►│                  │                    │
     │                    │── GET /mcp ─────►│                    │
     │                    │◄── 401 ──────────│                    │
     │                    │                  │                    │
     │  (browser opens)   │── GET /authorize►│                    │
     │                    │                  │── render login ───►│
     │                    │                  │◄── ID token ───────│
     │                    │                  │  verify + issue    │
     │                    │◄── MCP token ────│                    │
     │                    │                  │                    │
     │── "find buttons" ─►│── tool call ────►│── POST /api/search►
     │◄── components ─────│◄── results ──────│◄──────────────────
```

## Security

- **Token isolation**: Firebase tokens are never exposed to MCP clients. The Worker encrypts them in KV and issues separate MCP-scoped tokens.
- **CSRF protection**: `__Host-` prefixed cookies with `HttpOnly`, `Secure`, `SameSite=Lax`.
- **Rate limiting**: 60 requests/minute per user (sliding window in Durable Object).
- **Request timeouts**: 30s `AbortController` timeout on all upstream calls.
- **Input validation**: Zod schemas enforce query length (500 chars), image size (10MB), project ID length (128 chars).
- **Presigned URLs**: Time-limited (1 hour), generated server-side. R2 credentials never leave the Next.js service.

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start local dev server |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run typecheck` | TypeScript type checking |
| `npm run lint` | ESLint |
| `npm test` | Run unit + integration tests |
| `npm run test:e2e` | Run E2E tests (needs dev server) |
| `npm run test:coverage` | Tests with coverage report |
| `npm run verify` | Full check: typecheck + lint + tests |
