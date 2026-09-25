/**
 * Client for the dashboard's agent issue API (`/api/agent/issues/*`, feature
 * issue-resolution item 5). Contract:
 * scry-management/features/issue-resolution/agent-api-contract.md.
 *
 * The MCP never talks to the diff-service for issues: the dashboard is the only
 * enforcement point (membership, role, D1 promoted-only, actor overwrite). This
 * client proves who the user is with a signed `X-Scry-Caller` assertion for the
 * `scry-dashboard-agent` audience, carrying the MCP client's name as the signed
 * `agent_client` claim the dashboard records on every event.
 */

export type ApiResult<T = Record<string, unknown>> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; body: Record<string, unknown> };

export interface DashboardAgentClientOptions {
  baseUrl: string;
  /** Vercel automation bypass for the protected stage deployment; unset in production. */
  bypassToken?: string;
  /** Returns the `X-Scry-Caller` value for this request (throws when the secret is missing). */
  assertion: () => Promise<string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ListQuery {
  project_id: string;
  link_id?: string;
  figma_file_key?: string;
  figma_node_id?: string;
  story_id?: string;
  fix_side?: string[];
  status?: string[];
  side_status?: string[];
  severity?: string[];
  assignee?: string;
  changed_since?: string;
  cursor?: string;
  limit?: number;
}

export interface ImageQuery {
  images?: "none" | "crops" | "full";
  max_width?: number;
}

export class DashboardAgentClient {
  private readonly baseUrl: string;
  constructor(private readonly opts: DashboardAgentClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiResult> {
    const headers: Record<string, string> = {
      "X-Scry-Caller": await this.opts.assertion(),
      Accept: "application/json",
    };
    const bypass = this.opts.bypassToken?.trim();
    if (bypass) headers["x-vercel-protection-bypass"] = bypass;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let parsed: Record<string, unknown>;
    try {
      const v = text ? JSON.parse(text) : {};
      parsed = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
    } catch {
      // A non-JSON body (Vercel login page, HTML error) must not leak into the
      // agent's context verbatim; keep a short marker only.
      parsed = { error: "non_json_response", detail: text.slice(0, 120) };
    }
    return res.ok ? { ok: true, status: res.status, data: parsed } : { ok: false, status: res.status, body: parsed };
  }

  list(q: ListQuery): Promise<ApiResult> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) {
        if (v.length) params.set(k, v.join(","));
      } else params.set(k, String(v));
    }
    return this.request("GET", `/api/agent/issues?${params.toString()}`);
  }

  get(issueId: number, q: ImageQuery = {}): Promise<ApiResult> {
    return this.request("GET", `/api/agent/issues/${issueId}${imageParams(q)}`);
  }

  getByNumber(projectId: string, number: number, q: ImageQuery = {}): Promise<ApiResult> {
    const params = new URLSearchParams({ project_id: projectId, number: String(number) });
    const extra = imageParams(q);
    return this.request("GET", `/api/agent/issues/by-number?${params.toString()}${extra ? `&${extra.slice(1)}` : ""}`);
  }

  claim(issueId: number, body: { side: string; release?: boolean }): Promise<ApiResult> {
    return this.request("POST", `/api/agent/issues/${issueId}/claim`, body);
  }

  markFixed(issueId: number, body: { side: string; ref_url?: string; ref_kind?: string; note?: string }): Promise<ApiResult> {
    return this.request("POST", `/api/agent/issues/${issueId}/fixed`, body);
  }

  requestVerify(issueId: number, body: { side?: string; rediff?: boolean }): Promise<ApiResult> {
    return this.request("POST", `/api/agent/issues/${issueId}/request-verify`, body);
  }

  requestVerifyLink(body: { project_id: string; link_id: string; side?: string; rediff?: boolean }): Promise<ApiResult> {
    return this.request("POST", `/api/agent/issues/request-verify`, body);
  }

  comment(issueId: number, body: { body: string; propose_fix_side?: string }): Promise<ApiResult> {
    return this.request("POST", `/api/agent/issues/${issueId}/comment`, body);
  }
}

function imageParams(q: ImageQuery): string {
  const params = new URLSearchParams();
  if (q.images) params.set("images", q.images);
  if (q.max_width) params.set("max_width", String(q.max_width));
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** Sliding-window limiter (per Durable Object instance = per user). */
export class SlidingWindowLimiter {
  private hits: number[] = [];
  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}
  /** Records a hit and returns true when under the limit; returns false (no hit recorded) otherwise. */
  take(now = Date.now()): boolean {
    this.hits = this.hits.filter(t => t > now - this.windowMs);
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }
  /** Seconds until the oldest hit leaves the window. */
  retryAfterSeconds(now = Date.now()): number {
    const oldest = this.hits[0];
    return oldest === undefined ? 0 : Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
  }
}

/** Normalise the MCP client's self-reported name into a short audit label. */
export function agentClientLabel(info: { name?: string; title?: string } | undefined): string {
  const raw = (info?.title || info?.name || "").replace(/[^\x20-\x7E]/g, "").trim();
  return raw ? raw.slice(0, 80) : "MCP agent";
}
