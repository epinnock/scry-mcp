import { env, runInDurableObject } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { jwtVerify } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScryMCP, type AuthProps } from "../src/mcp";
import { DASHBOARD_AGENT_AUDIENCE } from "../src/utils/caller-assertion";

declare module "cloudflare:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Workers pool environment augmentation.
  interface ProvidedEnv extends Env {}
}

const props: AuthProps = { firebaseUid: "agent-user-1", email: "ana@example.test", displayName: "Ana", emailVerified: true };
const SECRET = "test-caller-assertion-secret";
/** D-SEC-1: the dashboard-agent hop signs with its own secret, never SECRET. */
const AGENT_SECRET = "test-agent-assertion-secret";
const DASH = "https://dashboard.example.test";

class TestScryMCP extends ScryMCP {
  constructor(state: DurableObjectState, bindings: Env) {
    super(state, bindings);
  }
}

async function withClient(overrides: Partial<Env>, test: (client: Client) => Promise<void>, clientName = "claude-code") {
  const stub = env.MCP_OBJECT.get(env.MCP_OBJECT.newUniqueId());
  await runInDurableObject(stub, async (_instance, state) => {
    const agent = new TestScryMCP(state, {
      ...env,
      SCRY_ENV: "staging",
      SCRY_SEARCH_API_URL: "https://search.example.test",
      SCRY_SEARCH_API_KEY: "test-api-key",
      SCRY_CALLER_ASSERTION_SECRET: SECRET,
      SCRY_AGENT_ASSERTION_SECRET: AGENT_SECRET,
      MCP_USAGE: undefined,
      ISSUE_TOOLS_ENABLED: "1",
      SCRY_DASHBOARD_API_URL: DASH,
      SCRY_DASHBOARD_BYPASS_TOKEN: "bypass-123",
      ...overrides,
    });
    agent.props = props;
    await agent.init();
    const client = new Client({ name: clientName, version: "2.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await agent.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await test(client);
    } finally {
      await client.close();
      await agent.server.close();
    }
  });
}

type Captured = { method: string; url: string; headers: Headers; body: unknown };

function mockDashboard(handler: (c: Captured) => Response) {
  const calls: Captured[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://img.example.test/")) {
      return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
    }
    if (!url.startsWith(DASH)) throw new Error(`Unexpected test fetch: ${url}`);
    const c: Captured = {
      method: init?.method ?? "GET",
      url,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    return handler(c);
  });
  return calls;
}

const text = (r: unknown) => ((r as { content: Array<{ type: string; text?: string }> }).content[0].text ?? "");
const errorOf = (r: unknown) => JSON.parse(text(r)) as Record<string, unknown>;

const TRACKS = [{ side: "code", status: "in_progress", claimed_by: "agent-user-1", claimed_kind: "agent", claim_expires_at: "2026-09-25T01:15:00Z" }];
const WRITE_OK = { ok: true, event: { type: "side_claimed" }, issue: { id: 42, number: 7, status: "open" }, resolution: TRACKS, verify_hint: { code: "will verify on next Storybook build" } };

const PAYLOAD = {
  issue: { id: 42, number: 7, note: "Primary button colour differs", severity: "major", status: "open", fix_side: "both", suggested_fix_side: "design", suggested_fix_side_reason: "Figma fill is detached" },
  project_id: "proj-1",
  link_id: "link-9",
  dashboard_url: "https://dashboard.example.test/projects/proj-1?tab=design-sync&diffLink=link-9&view=issues",
  resolution: [{ side: "code", status: "todo" }, { side: "design", status: "todo" }],
  verify_hint: { code: "next Storybook build", design: "next sync or request_verify(design)" },
  last_recheck: { verdict: "still_drifts", reason: "fill #5B5BD6 vs #6366F1", at: "2026-09-25T00:00:00Z" },
  expected: { from: "code", property: "fill", value: "#6366F1", actual: "#5B5BD6" },
  design: { actionable: true, figma_file_key: "FILEKEY", figma_node_id: "12:34", node_name: "Button", figma_url: "https://www.figma.com/design/FILEKEY?node-id=12-34", image: { url: "https://img.example.test/a.png", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } } },
  code: { story_id: "checkout-summarycard--default", component_file: "src/components/SummaryCard.tsx", story_file: "src/components/SummaryCard.stories.tsx", build_sha: "a41f9c2", image: { data: "aW1n", mime_type: "image/png", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } } },
  timeline: [
    { type: "promoted", actor: { kind: "user", id: "u9", name: "Ben" }, at: "2026-09-24T23:00:00Z" },
    { type: "side_claimed", actor: { kind: "agent", id: "agent-user-1", name: "claude-code", agent_client: "claude-code" }, payload: { actor_name: "Ana" }, at: "2026-09-25T00:00:00Z" },
  ],
};

afterEach(() => vi.restoreAllMocks());

describe("issue tools registration", () => {
  it("registers the six tools only when ISSUE_TOOLS_ENABLED=1", async () => {
    const six = ["list_design_issues", "get_design_issue", "claim_design_issue", "mark_design_issue_fixed", "request_verify", "comment_design_issue"];
    await withClient({}, async (client) => {
      const names = (await client.listTools()).tools.map(t => t.name);
      for (const n of six) expect(names).toContain(n);
    });
    await withClient({ ISSUE_TOOLS_ENABLED: undefined }, async (client) => {
      const names = (await client.listTools()).tools.map(t => t.name);
      for (const n of six) expect(names).not.toContain(n);
    });
  });

  it("fails closed with SERVER_MISCONFIGURED when the dashboard URL is missing", async () => {
    const calls = mockDashboard(() => Response.json({}));
    await withClient({ SCRY_DASHBOARD_API_URL: undefined }, async (client) => {
      const r = await client.callTool({ name: "list_design_issues", arguments: { project_id: "proj-1" } });
      expect(r.isError).toBe(true);
      expect(errorOf(r).error).toBe("SERVER_MISCONFIGURED");
    });
    expect(calls).toHaveLength(0);
  });

  it("D-SEC-1: fails closed when SCRY_AGENT_ASSERTION_SECRET is unset, even with the search secret set", async () => {
    const calls = mockDashboard(() => Response.json({}));
    await withClient({ SCRY_AGENT_ASSERTION_SECRET: undefined }, async (client) => {
      const r = await client.callTool({ name: "list_design_issues", arguments: { project_id: "proj-1" } });
      expect(r.isError).toBe(true);
      expect(errorOf(r).error).toBe("SERVER_MISCONFIGURED");
      expect(errorOf(r).message).toContain("SCRY_AGENT_ASSERTION_SECRET");
    });
    expect(calls).toHaveLength(0);
  });
});

describe("identity and audit", () => {
  it("signs X-Scry-Caller for the dashboard audience with sub = uid and the MCP client's name as agent_client", async () => {
    const calls = mockDashboard(() => Response.json({ issues: [], next_cursor: null }));
    await withClient({}, async (client) => {
      await client.callTool({ name: "list_design_issues", arguments: { project_id: "proj-1" } });
    });
    const h = calls[0].headers;
    const { payload } = await jwtVerify(h.get("X-Scry-Caller")!, new TextEncoder().encode(AGENT_SECRET), {
      algorithms: ["HS256"], audience: DASHBOARD_AGENT_AUDIENCE, issuer: "scry-mcp", maxTokenAge: "60s",
    });
    expect(payload.sub).toBe("agent-user-1");
    expect(payload.agent_client).toBe("claude-code");
    expect(h.get("x-vercel-protection-bypass")).toBe("bypass-123");
    expect(h.get("Authorization")).toBeNull();
  });

  it("an assertion for the dashboard does not verify as a search assertion", async () => {
    const calls = mockDashboard(() => Response.json({ issues: [] }));
    await withClient({}, async (client) => {
      await client.callTool({ name: "list_design_issues", arguments: { project_id: "proj-1" } });
    });
    await expect(jwtVerify(calls[0].headers.get("X-Scry-Caller")!, new TextEncoder().encode(SECRET), { audience: "scry-search" })).rejects.toThrow();
  });

  it("D-SEC-1: the dashboard assertion is signed with SCRY_AGENT_ASSERTION_SECRET, not the search secret", async () => {
    const calls = mockDashboard(() => Response.json({ issues: [] }));
    await withClient({}, async (client) => {
      await client.callTool({ name: "list_design_issues", arguments: { project_id: "proj-1" } });
    });
    const token = calls[0].headers.get("X-Scry-Caller")!;
    await expect(jwtVerify(token, new TextEncoder().encode(SECRET), { audience: DASHBOARD_AGENT_AUDIENCE })).rejects.toThrow(/signature/);
    await expect(jwtVerify(token, new TextEncoder().encode(AGENT_SECRET), { audience: DASHBOARD_AGENT_AUDIENCE })).resolves.toBeTruthy();
  });

  it("never sends actor fields in write bodies (the dashboard sets them)", async () => {
    const calls = mockDashboard(() => Response.json(WRITE_OK));
    await withClient({}, async (client) => {
      await client.callTool({ name: "claim_design_issue", arguments: { issue_id: 42, side: "code" } });
      await client.callTool({ name: "mark_design_issue_fixed", arguments: { issue_id: 42, side: "code", ref_url: "https://github.com/acme/web/pull/412", note: "use token" } });
      await client.callTool({ name: "request_verify", arguments: { issue_id: 42, side: "code" } });
      await client.callTool({ name: "comment_design_issue", arguments: { issue_id: 42, body: "done", propose_fix_side: "design" } });
    });
    expect(calls.map(c => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /api/agent/issues/42/claim",
      "POST /api/agent/issues/42/fixed",
      "POST /api/agent/issues/42/request-verify",
      "POST /api/agent/issues/42/comment",
    ]);
    for (const c of calls) {
      for (const k of ["who", "actor_kind", "agent_client", "actor_name", "via", "actor_uid"]) expect(c.body).not.toHaveProperty(k);
    }
    expect(calls[0].body).toEqual({ side: "code" });
    expect(calls[1].body).toEqual({ side: "code", ref_url: "https://github.com/acme/web/pull/412", note: "use token" });
    expect(calls[2].body).toEqual({ side: "code" });
    expect(calls[3].body).toEqual({ body: "done", propose_fix_side: "design" });
  });
});

describe("list_design_issues", () => {
  it("passes filters as query params and renders ids, sides and next step", async () => {
    const calls = mockDashboard(() => Response.json({
      issues: [{ id: 42, number: 7, note: "Primary button colour differs", severity: "major", status: "open", fix_side: "code", link_id: "link-9", pair_name: "Checkout / Summary card", resolution: TRACKS }],
      next_cursor: "41",
    }));
    await withClient({}, async (client) => {
      const r = await client.callTool({ name: "list_design_issues", arguments: { project_id: "proj-1", status: ["open"], fix_side: ["code", "both"], assignee: "me", limit: 10 } });
      expect(r.isError).not.toBe(true);
      const t = text(r);
      expect(t).toContain("issue_id 42 (#7)");
      expect(t).toContain("code=in_progress*");
      expect(t).toContain("cursor=41");
      expect(t).toContain("get_design_issue");
    });
    const q = new URL(calls[0].url).searchParams;
    expect(new URL(calls[0].url).pathname).toBe("/api/agent/issues");
    expect(q.get("project_id")).toBe("proj-1");
    expect(q.get("status")).toBe("open");
    expect(q.get("fix_side")).toBe("code,both");
    expect(q.get("assignee")).toBe("me");
    expect(q.get("limit")).toBe("10");
  });

  it("defaults limit to 50 and rejects limit > 100", async () => {
    const calls = mockDashboard(() => Response.json({ issues: [] }));
    await withClient({}, async (client) => {
      await client.callTool({ name: "list_design_issues", arguments: { project_id: "proj-1" } });
      const bad = await client.callTool({ name: "list_design_issues", arguments: { project_id: "proj-1", limit: 500 } });
      expect(bad.isError).toBe(true);
    });
    expect(new URL(calls[0].url).searchParams.get("limit")).toBe("50");
    expect(calls).toHaveLength(1);
  });

  it("maps 404 to NOT_FOUND (other tenant or unpromoted)", async () => {
    mockDashboard(() => Response.json({ error: "not_found" }, { status: 404 }));
    await withClient({}, async (client) => {
      const r = await client.callTool({ name: "list_design_issues", arguments: { project_id: "other-org" } });
      expect(errorOf(r)).toMatchObject({ error: "NOT_FOUND", retryable: false });
    });
  });
});

describe("get_design_issue", () => {
  it("renders both arenas, the expected value and how to fix, and inlines both crops", async () => {
    const calls = mockDashboard(() => Response.json(PAYLOAD));
    await withClient({}, async (client) => {
      const r = await client.callTool({ name: "get_design_issue", arguments: { issue_id: 42 } });
      expect(r.isError).not.toBe(true);
      const t = text(r);
      for (const s of ["FILEKEY", "12:34", "src/components/SummaryCard.tsx", "checkout-summarycard--default", "fill = #6366F1", "actual #5B5BD6", "Figma's own MCP", "open a pull request", "still_drifts", "AI hint", "promoted by Ben", "side_claimed by claude-code (for Ana)", "sha a41f9c2"]) expect(t).toContain(s);
      expect(t).not.toContain("layer subtree");
      const images = (r.content as Array<{ type: string }>).filter(c => c.type === "image");
      expect(images).toHaveLength(2);
    });
    expect(new URL(calls[0].url).pathname).toBe("/api/agent/issues/42");
    expect(new URL(calls[0].url).searchParams.get("images")).toBe("crops");
  });

  it("looks up by project_id + number and skips images when images=none", async () => {
    const calls = mockDashboard(() => Response.json(PAYLOAD));
    await withClient({}, async (client) => {
      const r = await client.callTool({ name: "get_design_issue", arguments: { project_id: "proj-1", number: 7, images: "none" } });
      expect((r.content as Array<{ type: string }>).filter(c => c.type === "image")).toHaveLength(0);
    });
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/api/agent/issues/by-number");
    expect(u.searchParams.get("project_id")).toBe("proj-1");
    expect(u.searchParams.get("number")).toBe("7");
    expect(u.searchParams.get("images")).toBe("none");
  });

  it("says a human must pick the side when fix_side is undecided", async () => {
    mockDashboard(() => Response.json({ ...PAYLOAD, issue: { ...PAYLOAD.issue, fix_side: "undecided" }, resolution: [] }));
    await withClient({}, async (client) => {
      const r = await client.callTool({ name: "get_design_issue", arguments: { issue_id: 42, images: "none" } });
      expect(text(r)).toContain("propose_fix_side");
    });
  });

  it("requires issue_id or project_id + number", async () => {
    const calls = mockDashboard(() => Response.json(PAYLOAD));
    await withClient({}, async (client) => {
      const r = await client.callTool({ name: "get_design_issue", arguments: { project_id: "proj-1" } });
      expect(errorOf(r).error).toBe("INVALID_ARGUMENT");
    });
    expect(calls).toHaveLength(0);
  });
});

describe("writes", () => {
  it("claim collision returns CLAIMED with the holder", async () => {
    mockDashboard(() => Response.json({ error: "claimed", claimed_by: "u2", claimed_kind: "agent", claim_expires_at: "2026-09-25T01:15:00Z" }, { status: 409 }));
    await withClient({}, async (client) => {
      const r = await client.callTool({ name: "claim_design_issue", arguments: { issue_id: 42, side: "code" } });
      expect(errorOf(r)).toMatchObject({ error: "CLAIMED", claimed_by: "u2", claim_expires_at: "2026-09-25T01:15:00Z", retryable: true });
    });
  });

  it("claim release sends release: true", async () => {
    const calls = mockDashboard(() => Response.json(WRITE_OK));
    await withClient({}, async (client) => {
      const r = await client.callTool({ name: "claim_design_issue", arguments: { issue_id: 42, side: "code", release: true } });
      expect(text(r)).toContain("Released");
    });
    expect(calls[0].body).toEqual({ side: "code", release: true });
  });

  it("mark fixed needs a reference unless ref_kind is synced", async () => {
    const calls = mockDashboard(() => Response.json(WRITE_OK));
    await withClient({}, async (client) => {
      const r = await client.callTool({ name: "mark_design_issue_fixed", arguments: { issue_id: 42, side: "code" } });
      expect(errorOf(r).error).toBe("INVALID_ARGUMENT");
      const ok = await client.callTool({ name: "mark_design_issue_fixed", arguments: { issue_id: 42, side: "design", ref_kind: "synced" } });
      expect(ok.isError).not.toBe(true);
      expect(text(ok)).toContain("Marked the design side fixed");
    });
    expect(calls).toHaveLength(1);
  });

  it("maps agent-forbidden and viewer 403s", async () => {
    let n = 0;
    mockDashboard(() => (n++ === 0
      ? Response.json({ error: "forbidden_for_agents" }, { status: 403 })
      : Response.json({ error: "forbidden" }, { status: 403 })));
    await withClient({}, async (client) => {
      const a = await client.callTool({ name: "mark_design_issue_fixed", arguments: { issue_id: 42, side: "code", ref_url: "abc1234", ref_kind: "commit" } });
      expect(errorOf(a).error).toBe("FORBIDDEN_FOR_AGENTS");
      const b = await client.callTool({ name: "comment_design_issue", arguments: { issue_id: 42, body: "x" } });
      expect(errorOf(b).error).toBe("FORBIDDEN");
    });
  });

  it("caps issue writes at 30 per minute per user; reads still work", async () => {
    mockDashboard(c => (c.method === "GET" ? Response.json({ issues: [] }) : Response.json(WRITE_OK)));
    await withClient({}, async (client) => {
      for (let i = 0; i < 30; i++) {
        const r = await client.callTool({ name: "comment_design_issue", arguments: { issue_id: 42, body: `c${i}` } });
        expect(r.isError).not.toBe(true);
      }
      const capped = await client.callTool({ name: "comment_design_issue", arguments: { issue_id: 42, body: "c31" } });
      expect(errorOf(capped)).toMatchObject({ error: "WRITE_RATE_LIMITED", retryable: true });
      const read = await client.callTool({ name: "list_design_issues", arguments: { project_id: "proj-1" } });
      expect(read.isError).not.toBe(true);
    });
  });
});

describe("request_verify", () => {
  it("renders verdicts, moved tracks and quota for an issue", async () => {
    mockDashboard(() => Response.json({
      ran: true, run_id: "run-1", verdicts: [{ issue_id: 42, verdict: "matches", reason: "fill now #6366F1" }],
      tracks_moved: { 42: [{ side: "code", to: "verified" }] }, waiting: [],
      quota: { hour: { used: 1, limit: 20, remaining: 19 }, day: { used: 1, limit: 200, remaining: 199 } },
    }));
    await withClient({}, async (client) => {
      const t = text(await client.callTool({ name: "request_verify", arguments: { issue_id: 42, side: "code" } }));
      expect(t).toContain("matches");
      expect(t).toContain("code→verified");
      expect(t).toContain("19/hour, 199/day");
    });
  });

  it("verifies a whole link via project_id + link_id, and says when nothing ran", async () => {
    const calls = mockDashboard(() => Response.json({ ran: false, reason: "no_new_input", waiting: [{ issue_id: 42, side: "code", status: "fixed", hint: "next Storybook build" }] }));
    await withClient({}, async (client) => {
      const t = text(await client.callTool({ name: "request_verify", arguments: { project_id: "proj-1", link_id: "link-9", rediff: true } }));
      expect(t).toContain("No re-check ran — no_new_input");
    });
    expect(new URL(calls[0].url).pathname).toBe("/api/agent/issues/request-verify");
    expect(calls[0].body).toEqual({ project_id: "proj-1", link_id: "link-9", rediff: true });
  });

  it("maps the verify cap (429) and short credits (402)", async () => {
    let n = 0;
    mockDashboard(() => (n++ === 0
      ? Response.json({ error: "verify_rate_limited", window: "hour", limit: 20, retry_after_seconds: 1800 }, { status: 429 })
      : Response.json({ error: "insufficient_credits", needed: 10, available: 3, stage: "rediff" }, { status: 402 })));
    await withClient({}, async (client) => {
      const a = await client.callTool({ name: "request_verify", arguments: { issue_id: 42 } });
      expect(errorOf(a)).toMatchObject({ error: "VERIFY_RATE_LIMITED", retry_after_seconds: 1800, retryable: true });
      const b = await client.callTool({ name: "request_verify", arguments: { issue_id: 42, rediff: true } });
      expect(errorOf(b)).toMatchObject({ error: "INSUFFICIENT_CREDITS", needed: 10, available: 3 });
    });
  });

  it("requires issue_id or project_id + link_id", async () => {
    await withClient({}, async (client) => {
      const r = await client.callTool({ name: "request_verify", arguments: { project_id: "proj-1" } });
      expect(errorOf(r).error).toBe("INVALID_ARGUMENT");
    });
  });
});

describe("upstream failures", () => {
  it("does not leak a non-JSON (login page) body and marks 5xx retryable", async () => {
    mockDashboard(() => new Response("<html>" + "x".repeat(5000), { status: 502 }));
    await withClient({}, async (client) => {
      const r = await client.callTool({ name: "list_design_issues", arguments: { project_id: "proj-1" } });
      const e = errorOf(r);
      expect(e).toMatchObject({ error: "DASHBOARD_API_502", retryable: true });
      expect(text(r).length).toBeLessThan(400);
    });
  });

  it("reports an unreachable dashboard as retryable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));
    await withClient({}, async (client) => {
      const r = await client.callTool({ name: "list_design_issues", arguments: { project_id: "proj-1" } });
      expect(errorOf(r)).toMatchObject({ error: "DASHBOARD_UNREACHABLE", retryable: true });
    });
  });

  it("401 means the assertion secret does not match: SERVER_MISCONFIGURED", async () => {
    mockDashboard(() => Response.json({ error: "invalid_caller_assertion" }, { status: 401 }));
    await withClient({}, async (client) => {
      const r = await client.callTool({ name: "list_design_issues", arguments: { project_id: "proj-1" } });
      expect(errorOf(r).error).toBe("SERVER_MISCONFIGURED");
    });
  });
});

describe("agent_client survives hibernation", () => {
  it("persists clientInfo at initialize and reads it back on a fresh instance", async () => {
    const stub = env.MCP_OBJECT.get(env.MCP_OBJECT.newUniqueId());
    await runInDurableObject(stub, async (_instance, state) => {
      const bindings = { ...env, SCRY_CALLER_ASSERTION_SECRET: SECRET, SCRY_AGENT_ASSERTION_SECRET: AGENT_SECRET, MCP_USAGE: undefined, ISSUE_TOOLS_ENABLED: "1", SCRY_DASHBOARD_API_URL: DASH } as Env;
      const first = new TestScryMCP(state, bindings);
      first.props = props;
      await first.init();
      const client = new Client({ name: "claude-code", version: "2.1.0" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await first.server.connect(st);
      await client.connect(ct);
      await vi.waitFor(async () => expect(await state.storage.get("mcpClientInfo")).toMatchObject({ name: "claude-code" }));
      await client.close();
      await first.server.close();

      // A woken instance has no in-memory clientInfo (no initialize on it).
      const woken = new TestScryMCP(state, bindings);
      woken.props = props;
      await woken.init();
      expect(woken.server.server.getClientVersion()).toBeUndefined();
      const label = await (woken as unknown as { agentClient(): Promise<string> }).agentClient();
      expect(label).toBe("claude-code");
    });
  });
});
