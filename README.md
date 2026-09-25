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
| `generate_image` | Gemini image generation (fast / quality), billed in AI credits; routed through Cloudflare AI Gateway when `LLM_GATEWAY_URL` is set |
| `whoami` | Returns the authenticated user's info |

### Issue resolution tools (stage; `ISSUE_TOOLS_ENABLED="1"`)

Design-drift issues a human has promoted in the dashboard, resolvable in code or in Figma.
All six call the dashboard's `/api/agent/issues/*` with a signed `X-Scry-Caller`
(audience `scry-dashboard-agent`, claims `sub` = uid and `agent_client` = the MCP client's
name); the dashboard checks membership and role and records `actor_kind: "agent"`. Needs
`SCRY_DASHBOARD_API_URL`, `SCRY_AGENT_ASSERTION_SECRET` (a secret shared only with the
dashboard, separate from the search secret; unset = `SERVER_MISCONFIGURED`) and, for the protected stage
dashboard, the `SCRY_DASHBOARD_BYPASS_TOKEN` secret. Writes are capped at 30/min/user on top
of the 60 req/min limit.

| Tool | Description |
|------|-------------|
| `list_design_issues` | Promoted issues in a project, filterable by link, Figma node, story, fix side, status, side status, severity, assignee, `changed_since` |
| `get_design_issue` | One issue with both crops, Figma file key + node id, story + source files, expected value, tracks, last re-check, how to fix |
| `claim_design_issue` | Claim (15-min lease) or release the code or design side |
| `mark_design_issue_fixed` | Record a fix with a PR URL / commit / Figma version |
| `request_verify` | Re-check now (free, 20/project/hour, 200/day) or `rediff: true` (10 credits) |
| `comment_design_issue` | Timeline comment, optionally proposing a fix side |

## Usage analytics

Each tool handler invocation records one Workers Analytics Engine data point for
use by the dashboard's staff-only KPI page. The only recorded values are the tool
name (`blob1`), environment (`blob2`), and Firebase uid (`blob3` and `index1`), plus
`double1 = 1` for counting. Missing environment/uid values become `unknown` and
`anonymous`. No query text, prompts, image data, tokens, or other tool data is sent
to Analytics Engine. Internal diagnostic logs do not add usage points. Missing or
failing analytics bindings never affect tool responses.

The `MCP_USAGE` binding writes to `scry_mcp_usage` in production and
`scry_mcp_usage_staging` in staging. Query production with the Analytics Engine SQL
API (substitute the staging dataset name for staging):

```sql
SELECT blob1 AS tool, count() AS n FROM scry_mcp_usage WHERE timestamp > NOW() - INTERVAL '30' DAY GROUP BY tool
```

## Project Structure

```
scry-mcp/
├── src/
│   ├── index.ts                # Entry point — OAuthProvider wrapper
│   ├── firebase-handler.ts     # Auth handler — login UI + Firebase verification
│   ├── mcp.ts                  # MCP server — 5 tools (search, screenshot, generate_image, whoami)
│   ├── credits.ts / wallet.ts  # AI-credits hold/settle against the diff-service ledger
│   ├── llm-gateway.ts          # Cloudflare AI Gateway routing for Gemini
│   ├── telemetry/              # Langfuse spans -> TELEMETRY_QUEUE producer
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
| `stage` | staging | https://mcp-stage.scrymore.com | `--env staging` |
| `main` | production | https://mcp.scrymore.com | top-level (no `--env`) |

The connector URL is `https://mcp.scrymore.com/mcp` (staging:
`https://mcp-stage.scrymore.com/mcp`). The `*.epinnock.workers.dev` names are the
same workers and still resolve; they are not being retired. Each scrymore.com
hostname is a Workers custom domain **and** an explicit `<host>/*` route, because
`scry-cdn-service` owns a `*.scrymore.com/*` route that otherwise answers for
every proxied hostname in the zone. Full table and wiring rules:
`scry-management/ENDPOINTS.md`.

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

CI reuses the repository's existing
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. GitHub deployment environments
are `staging` and `production`, with their respective worker URLs. The existing
`staging-OAUTH_KV` namespace is reused, and Wrangler applies migration `v1` to the
new worker's `ScryMCP` Durable Object; no KV creation or manual DO migration is
needed.

Phase 1 health and OAuth smoke checks work without worker secrets: health reads
only stamp vars, the provider builds metadata from the request origin and endpoint
configuration, and missing bearer auth returns 401 before accessing KV or services.
Firebase sign-in, search and image generation need Phase 2 configuration:

- Add staging `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, and `FIREBASE_PROJECT_ID`
  for `scry-dev-dashboard-stage`.
- Set `SCRY_SEARCH_API_URL` to `https://search-stage.scrymore.com` (production uses
  `https://search.scrymore.com`) and `SCRY_SEARCH_API_KEY` to its stage-only API key. Store that key on Vercel as a
  plain encrypted Preview variable, not a sensitive one: sensitive values cannot
  be read back, and the promotion smoke check (`scry-management/smoke-search.py`)
  pulls it with `vercel env pull`.
- Set `SCRY_SEARCH_API_BYPASS_TOKEN` to the scry-nextjs project's Protection Bypass
  for Automation token. The stage search host is behind Vercel Deployment Protection
  and answers a bare worker request with a login page (its custom domain does not
  change that: a branch-assigned domain serves a preview deployment, and per-domain
  exceptions need a paid plan); the worker sends the token as
  `x-vercel-protection-bypass` only when this secret exists. Production has no such
  secret and sends no header.
- Set `SCRY_CALLER_ASSERTION_SECRET` to the same value as the scry-nextjs Preview
  deployment's `SCRY_CALLER_ASSERTION_SECRET` (`wrangler secret put
  SCRY_CALLER_ASSERTION_SECRET --env staging`; production is top-level,
  `wrangler secret put SCRY_CALLER_ASSERTION_SECRET`). Generate a distinct value
  per environment with `openssl rand -base64 48`. Set it on scry-nextjs first,
  with its `ALLOW_LEGACY_USER_HEADER=true` transition flag on, then deploy the
  worker, then turn the flag off.
- Set `SCRY_AGENT_ASSERTION_SECRET` (issue tools only) to the same value as the
  dashboard's `SCRY_AGENT_ASSERTION_SECRET` for that environment (`wrangler secret
  put SCRY_AGENT_ASSERTION_SECRET --env staging`; production top-level). It must
  differ from `SCRY_CALLER_ASSERTION_SECRET` and between stage and production.
- Add a staging `COOKIE_ENCRYPTION_KEY`, `GEMINI_API_KEY` for image generation,
  and optionally `SENTRY_DSN` for error reporting. In Phase 2, use
  `wrangler secret put <NAME> --env staging`; production secrets remain top-level.
- AI credits (`generate_image` holds 40 fast / 150 quality credits on the caller's
  wallet in the scry-diff-service ledger): set `CREDITS_API_TOKEN` to that
  environment's diff-service `SERVICE_AUTH_TOKEN` (`wrangler secret put
  CREDITS_API_TOKEN --env staging`). `CREDITS_MODE` (vars) is `off` | `shadow` |
  `enforce`: shadow writes the ledger but never refuses; enforce returns
  `INSUFFICIENT_CREDITS` (no Gemini call) and fails closed with
  `CREDITS_UNAVAILABLE` when the ledger cannot be reached. Staging is `enforce`,
  production `enforce` since 2026-09-24 (the shadow week was skipped).
  `CREDITS_API_URL` (the diff-service ledger) and `CREDITS_PAGE_URL` (dashboard
  `/credits`, linked from the refusal message) are vars in `wrangler.jsonc`. The wallet is the caller's org (`org:<users/{uid}.activeOrgId>`
  if they are in its `memberIds`, else `org:personal_<uid>`), read from Firestore
  with the Firebase Admin service account: set `FIREBASE_CLIENT_EMAIL` and
  `FIREBASE_PRIVATE_KEY` (secrets) from that environment's service-account JSON.
- LLM telemetry: `LLM_GATEWAY_URL` (vars) routes Gemini through the
  authenticated AI Gateway (`scry-stage` / `scry-prod`) and needs the `CF_AIG_TOKEN`
  secret; delete the var to call Google directly (kill switch). `LANGFUSE_ENABLED`
  / `LANGFUSE_SAMPLE_RATE` control Langfuse spans, which are enqueued on the
  `TELEMETRY_QUEUE` producer (`scry-telemetry-staging` / `-production`); the
  consumer is scry-diff-service, which archives to R2 and delivers to Langfuse.
  Sampling is adaptive: when telemetry is on, the Worker reads its rate
  (`rates.mcp`) from the diff-service unit-budget job at
  `GET $CREDITS_API_URL/api/telemetry/sampling` (bearer `CREDITS_API_TOKEN`, the
  same service credentials as credits; no extra secret), cached per isolate for
  the response's `ttl_s` (default 300 s). On a timeout (1.5 s), error, non-200 or
  `rates: null` it falls back to `LANGFUSE_SAMPLE_RATE` (failures are cached for
  60 s). Set `LANGFUSE_DYNAMIC_SAMPLING=0` to use the env var only. The sampling
  decision stays deterministic per run id.
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
        "https://mcp.scrymore.com/mcp"
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

Restart Claude Desktop. On first launch, a browser window opens for Firebase sign-in. After authenticating, the 5 tools appear in Claude's tool picker.

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

## MCP Registry

`server.json` publishes the server to the MCP registry as
`io.github.epinnock/scry-mcp` (remote: streamable HTTP at
`https://mcp.scrymore.com/mcp`).

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
