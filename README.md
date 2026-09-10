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
| `search_components` | Text-based semantic + keyword hybrid search over UI components. `scope: "project"` (default) never widens; `scope: "org"` also returns opted-in, readable sibling projects' rows, marked `crossProject` |
| `search_by_image` | Visual similarity search using base64 image input; same `scope` semantics |
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

- Node.js v22+
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
SCRY_CALLER_ASSERTION_SECRET=same-value-as-scry-nextjs-SCRY_CALLER_ASSERTION_SECRET
COOKIE_ENCRYPTION_KEY=any-random-string-for-dev
```

`SCRY_SEARCH_API_KEY` is transport auth: it proves a request came from this
worker. `SCRY_CALLER_ASSERTION_SECRET` signs the short-lived `X-Scry-Caller`
JWT that tells the search API *which user* the worker is acting for; it is the
only channel that carries the uid, and the search API verifies it with the same
secret before it trusts the uid. Without the secret the search tools return
`SERVER_MISCONFIGURED` rather than searching anonymously.

### 3. KV configuration

The production and staging KV namespaces already exist and are configured in
`wrangler.jsonc`. Local development uses Wrangler's local KV emulator; no cloud
namespace creation is needed.

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

The shared workflow is `.github/workflows/deploy.yml`, using Node 22 and Wrangler
4.72.0 (the lockfile version). PRs targeting `stage` or `main` run typecheck,
lint, widget build and tests without deploying. Feature PRs target `stage`;
promotion advances `main` to the tested staging commit.

| Branch | Environment | Worker URL | Wrangler target |
|--------|-------------|------------|-----------------|
| `stage` | staging | https://scry-mcp-staging.epinnock.workers.dev | `--env staging` |
| `main` | production | https://scry-mcp.epinnock.workers.dev | top-level (no `--env`) |

Pushes to these branches deploy after checks pass; Markdown and `docs/**` changes
alone do not trigger push CI. Use the workflow's `environment` choice for a manual
run, selecting the branch whose commit should deploy. Deployments are serialized
per ref and include the Phase 0 commit, branch, build time, run ID, actor and Sentry
release stamps. The smoke gate retries `/healthz` six times at 10-second intervals
until its commit matches the run SHA, then requires unauthenticated `/mcp` to return
401 and `/.well-known/oauth-authorization-server` to return 200.

For an authorized manual deploy, `npm run deploy:staging` selects staging and
`npm run deploy:production` (or `npm run deploy`) retains the existing production
worker and stamp flags. Production intentionally has no `env.production` block;
use a top-level deploy/dry-run, not `--env production`.

After this Phase 1 change merges, create `stage` from the updated `main` and push
it to trigger the first staging deploy. CI reuses the repository's existing
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. GitHub deployment environments
are `staging` and `production`, with their respective worker URLs. The existing
`staging-OAUTH_KV` namespace is reused, and Wrangler applies migration `v1` to the
new worker's `ScryMCP` Durable Object; no KV creation or manual DO migration is
needed. Staging uses workers.dev and has no custom routes.

Phase 1 health and OAuth smoke checks work without worker secrets: health reads
only stamp vars, the provider builds metadata from the request origin and endpoint
configuration, and missing bearer auth returns 401 before accessing KV or services.
Firebase sign-in, search and image generation need Phase 2 configuration:

- Add staging `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, and `FIREBASE_PROJECT_ID`
  for `scry-dev-dashboard-stage`.
- Set `SCRY_SEARCH_API_URL` to the scry-nextjs stable stage alias and
  `SCRY_SEARCH_API_KEY` to its stage-only API key.
- Set `SCRY_CALLER_ASSERTION_SECRET` to the same value as the scry-nextjs Preview
  deployment's `SCRY_CALLER_ASSERTION_SECRET` (`wrangler secret put
  SCRY_CALLER_ASSERTION_SECRET --env staging`; production is top-level,
  `wrangler secret put SCRY_CALLER_ASSERTION_SECRET`). Generate a distinct value
  per environment with `openssl rand -base64 48`. Set it on scry-nextjs first,
  with its `ALLOW_LEGACY_USER_HEADER=true` transition flag on, then deploy the
  worker, then turn the flag off.
- Add a staging `COOKIE_ENCRYPTION_KEY`, `GEMINI_API_KEY` for image generation,
  and optionally `SENTRY_DSN` for error reporting. In Phase 2, use
  `wrangler secret put <NAME> --env staging`; production secrets remain top-level.
- In the staging Firebase console, authorize
  `scry-mcp-staging.epinnock.workers.dev` and enable the intended sign-in providers
  (Google and email/password alongside GitHub).

Do not enable `DEV_BYPASS_AUTH` on deployed workers. Full authenticated staging
verification follows in Phase 2 after those secrets and Firebase settings exist.

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
- **Presigned URLs**: Time-limited (1 hour), generated server-side. R2 credentials never leave the Next.js service. The presign request carries the caller assertion, so the Next.js service signs only keys the user may read.
- **Caller identity**: the worker sends `X-Scry-Caller`, an HS256 JWT over `SCRY_CALLER_ASSERTION_SECRET` (`{sub: uid, aud: "scry-search", iat, exp ≤ 60s}`), so the shared `SCRY_SEARCH_API_KEY` cannot be used to impersonate a user. This assertion is the only identity channel: the search API's transition flag is gone, the unsigned `X-User-Id` header is no longer read there, and the worker no longer sends it.
- **Search scope**: explicit `scope` on both search tools, default `project`, which never widens. `org` returns another project's rows only when that project opted in (`discoverableByOrg`) and the user can read it.

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start local dev server |
| `npm run deploy` / `npm run deploy:production` | Stamped production deploy |
| `npm run deploy:staging` | Stamped staging deploy |
| `npm run typecheck` | TypeScript type checking |
| `npm run lint` | ESLint |
| `npm test` | Run unit + integration tests |
| `npm run test:e2e` | Run E2E tests (needs dev server) |
| `npm run test:coverage` | Tests with coverage report |
| `npm run verify` | Full check: typecheck + lint + tests |
