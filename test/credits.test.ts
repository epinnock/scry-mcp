import { env, runInDurableObject } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScryMCP, type AuthProps } from "../src/mcp";
import {
  creditsMode,
  creditsPageUrl,
  creditsUsedLine,
  formatResetDate,
  insufficientCreditsMessage,
  parseGeminiUsage,
  usageReason,
} from "../src/credits";

declare module "cloudflare:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Workers pool environment augmentation.
  interface ProvidedEnv extends Env {}
}

const props: AuthProps = {
  firebaseUid: "credits-test-user",
  email: "credits@example.test",
  displayName: "Credits Test",
  emailVerified: true,
};

const LEDGER = "https://ledger.example.test";
const FS_PREFIX = "https://firestore.googleapis.com/v1/projects/test-project/databases/(default)/documents/";

/** A throwaway RSA key so the service-account JWT really signs. */
async function testPrivateKeyPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let bin = "";
  for (const b of der) bin += String.fromCharCode(b);
  // Stored with literal "\n", as a secret pasted from a service-account JSON is.
  return `-----BEGIN PRIVATE KEY-----\\n${btoa(bin)}\\n-----END PRIVATE KEY-----`;
}
const PRIVATE_KEY = testPrivateKeyPem();

/** Firestore docs by path. Default: active org "acme" (Acme), caller is a member. */
type Docs = Record<string, Record<string, unknown> | undefined>;
const defaultDocs = (): Docs => ({
  "users/credits-test-user": { activeOrgId: { stringValue: "acme" } },
  "orgs/acme": { name: { stringValue: "Acme" }, memberIds: { arrayValue: { values: [{ stringValue: "credits-test-user" }, { stringValue: "other" }] } } },
});
const TOKEN = "test-ledger-token";
const RESETS = "2026-10-01T00:00:00.000Z";

class TestScryMCP extends ScryMCP {
  constructor(state: DurableObjectState, bindings: Env) {
    super(state, bindings);
  }
}

async function withClient(overrides: Partial<Env>, test: (client: Client) => Promise<void>, opts: { inboundRequestId?: string } = {}) {
  const stub = env.MCP_OBJECT.get(env.MCP_OBJECT.newUniqueId());
  await runInDurableObject(stub, async (_instance, state) => {
    const agent = new TestScryMCP(state, {
      ...env,
      SCRY_ENV: "staging",
      SCRY_SEARCH_API_URL: "https://search.example.test",
      SCRY_SEARCH_API_KEY: "test-api-key",
      SCRY_CALLER_ASSERTION_SECRET: "test-caller-assertion-secret",
      GEMINI_API_KEY: "test-gemini-key",
      LLM_GATEWAY_URL: undefined,
      MCP_USAGE: undefined,
      CREDITS_API_URL: LEDGER,
      CREDITS_API_TOKEN: TOKEN,
      FIREBASE_PROJECT_ID: "test-project",
      FIREBASE_CLIENT_EMAIL: "sa@test-project.iam.gserviceaccount.com",
      FIREBASE_PRIVATE_KEY: await PRIVATE_KEY,
      ...overrides,
    });
    agent.props = props;
    await agent.init();
    const client = new Client({ name: "credits-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await agent.server.connect(serverTransport);
    if (opts.inboundRequestId) {
      // Simulate a transport that exposes HTTP headers (extra.requestInfo) carrying
      // a caller-chosen x-scry-request-id on every message.
      const deliver = serverTransport.onmessage!;
      serverTransport.onmessage = (message, extra) =>
        deliver(message, { ...extra, requestInfo: { headers: { "x-scry-request-id": opts.inboundRequestId! } } } as never);
    }
    await client.connect(clientTransport);
    try {
      await test(client);
    } finally {
      await client.close();
      await agent.server.close();
    }
  });
}

type Captured = { path: string; headers: Headers; body: Record<string, unknown> };

const USAGE = {
  promptTokenCount: 9,
  candidatesTokenCount: 1290,
  totalTokenCount: 1299,
  candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1290 }],
};

const geminiOk = () => Response.json({
  candidates: [{ finishReason: "STOP", content: { parts: [
    { text: "A blue button" },
    { inlineData: { data: "aW1hZ2U=", mimeType: "image/png" } },
  ] } }],
  usageMetadata: USAGE,
});

const balance = (available: number) => ({
  wallet_id: `user:${props.firebaseUid}`, period: "2026-09", monthly_grant: 2000,
  monthly_left: available, bonus_left: 0, held: 0, available, resets_at: RESETS,
});

/** Default ledger: 2,000 available; reserve holds the task's price. */
function ledgerOk(available = 2000) {
  return (path: string, body: Record<string, unknown>): Response => {
    const price = body.task === "mcp.image.quality" ? 150 : 40;
    if (path === "/api/credits/reserve") {
      return Response.json({ ok: true, mode: "shadow", replay: false, would_block: false,
        hold: { ref_id: body.ref_id, task: body.task, quantity: 1, amount: price, status: "held" },
        balance: { ...balance(available - price), held: price } });
    }
    if (path === "/api/credits/settle") return Response.json({ ok: true, replay: false, hold: {}, balance: balance(available - 40) });
    if (path === "/api/credits/release") return Response.json({ ok: true, replay: false, hold: {}, balance: balance(available) });
    return new Response("not found", { status: 404 });
  };
}

function mockUpstreams(opts: {
  ledger?: (path: string, body: Record<string, unknown>) => Response | Promise<Response>;
  gemini?: () => Response;
  search?: () => Response;
  docs?: Docs;
  firestoreStatus?: number;
} = {}) {
  const ledger: Captured[] = [];
  const gemini: string[] = [];
  const firestore: string[] = [];
  const tokenRequests: string[] = [];
  const docs = opts.docs ?? defaultDocs();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      tokenRequests.push(String(init?.body ?? ""));
      return Response.json({ access_token: "fs-token", expires_in: 3600 });
    }
    if (url.startsWith(FS_PREFIX)) {
      const path = decodeURIComponent(url.slice(FS_PREFIX.length));
      firestore.push(path);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fs-token");
      if (opts.firestoreStatus) return new Response("err", { status: opts.firestoreStatus });
      const fields = docs[path];
      return fields ? Response.json({ name: path, fields }) : Response.json({ error: { code: 404 } }, { status: 404 });
    }
    if (url.startsWith(LEDGER)) {
      const path = url.slice(LEDGER.length);
      const body = JSON.parse(String(init?.body ?? "{}"));
      ledger.push({ path, headers: new Headers(init?.headers), body });
      return (opts.ledger ?? ledgerOk())(path, body);
    }
    if (url.includes(":generateContent")) {
      gemini.push(String(init?.body ?? ""));
      return (opts.gemini ?? geminiOk)();
    }
    if (url.endsWith("/api/image/upload")) return Response.json({ success: true });
    if (url.endsWith("/api/image/presign")) {
      return Response.json({ url: "https://images.example.test/image.png", expires_at: "2030-01-01T00:00:00Z" });
    }
    if (url.endsWith("/api/search")) return (opts.search ?? (() => Response.json({ results: [], pagination: { page: 1, limit: 10, total: 0 } })))();
    throw new Error(`Unexpected test fetch: ${url}`);
  });
  return { ledger, gemini, firestore, tokenRequests };
}

const fast = { name: "generate_image", arguments: { prompt: "A blue button" } };
const qualityCall = { name: "generate_image", arguments: { prompt: "A blue button", quality: "quality" } };
const errorOf = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content)[0].text);
const texts = (r: unknown) => ((r as { content: unknown }).content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text);

afterEach(() => vi.restoreAllMocks());

describe("generate_image credits: CREDITS_MODE off (default)", () => {
  it("makes no ledger call and adds no credits fields", async () => {
    const { ledger, gemini } = mockUpstreams();
    await withClient({ CREDITS_MODE: undefined }, async (client) => {
      const r = await client.callTool(fast);
      expect(r.isError).not.toBe(true);
      expect(r.structuredContent).not.toHaveProperty("credits_used");
      expect(r.structuredContent).not.toHaveProperty("credits_left");
      const tools = await client.listTools();
      expect(tools.tools.find((t) => t.name === "generate_image")?.description).not.toContain("INSUFFICIENT_CREDITS");
    });
    expect(ledger).toHaveLength(0);
    expect(gemini).toHaveLength(1);
  });
});

describe.each(["shadow", "enforce"] as const)("generate_image credits: CREDITS_MODE %s", (mode) => {
  it("reserves 40 on the caller's wallet, settles with Gemini token counts, reports credits_used/credits_left", async () => {
    const { ledger, gemini } = mockUpstreams();
    await withClient({ CREDITS_MODE: mode }, async (client) => {
      const r = await client.callTool(fast);
      expect(r.isError).not.toBe(true);
      expect(r.structuredContent).toMatchObject({
        credits_used: 40, credits_left: 1960, credits_resets_at: RESETS, credits_wallet: "org:acme", credits_org_name: "Acme",
      });
      expect(texts(r)).toContain("Used 40 AI credits · Acme · 1,960 credits left (resets Oct 1).");
      const tools = await client.listTools();
      expect(tools.tools.find((t) => t.name === "generate_image")?.description).toContain("40 (fast) or 150 (quality)");
    });
    expect(gemini).toHaveLength(1);
    expect(ledger.map((c) => c.path)).toEqual(["/api/credits/reserve", "/api/credits/settle"]);
    const [reserve, settle] = ledger;
    expect(reserve.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(reserve.body).toMatchObject({
      wallet_id: "org:acme", task: "mcp.image.fast", quantity: 1, ref_type: "mcp", actor_uid: "credits-test-user",
    });
    expect(reserve.body.ref_id).toMatch(/^mcp-image:[0-9a-f-]{36}$/);
    expect(settle.body.ref_id).toBe(reserve.body.ref_id);
    expect(settle.body.reason).toBe("gemini-3.1-flash-image-preview · 9 in · 1290 out (1290 image) · 1299 total tokens");
  });

  it("reserves 150 (mcp.image.quality) for a quality image", async () => {
    const { ledger } = mockUpstreams();
    await withClient({ CREDITS_MODE: mode }, async (client) => {
      const r = await client.callTool(qualityCall);
      expect(r.structuredContent).toMatchObject({ credits_used: 150 });
    });
    expect(ledger[0].body.task).toBe("mcp.image.quality");
    expect(String(ledger[1].body.reason)).toMatch(/^gemini-3-pro-image-preview · /);
  });

  it("releases the hold (failed, refunded) and never settles when Gemini fails", async () => {
    const { ledger } = mockUpstreams({ gemini: () => new Response("boom", { status: 500 }) });
    await withClient({ CREDITS_MODE: mode }, async (client) => {
      const r = await client.callTool(fast);
      expect(r.isError).toBe(true);
      expect(errorOf(r)).toMatchObject({ error: "GEMINI_API_ERROR", retryable: true });
    });
    expect(ledger.map((c) => c.path)).toEqual(["/api/credits/reserve", "/api/credits/release"]);
    expect(ledger[1].body).toEqual({ ref_id: ledger[0].body.ref_id, reason: "failed, refunded" });
  });

  it("releases the hold when the prompt is safety-filtered", async () => {
    const { ledger } = mockUpstreams({ gemini: () => Response.json({ candidates: [{ finishReason: "SAFETY" }] }) });
    await withClient({ CREDITS_MODE: mode }, async (client) => {
      expect(errorOf(await client.callTool(fast)).error).toBe("SAFETY_FILTERED");
    });
    expect(ledger.map((c) => c.path)).toEqual(["/api/credits/reserve", "/api/credits/release"]);
  });

  it("still returns the image when settle fails (retried once), with credits_left from the hold", async () => {
    const base = ledgerOk();
    const { ledger } = mockUpstreams({
      ledger: (path, body) => (path === "/api/credits/settle" ? new Response("down", { status: 503 }) : base(path, body)),
    });
    await withClient({ CREDITS_MODE: mode }, async (client) => {
      const r = await client.callTool(fast);
      expect(r.isError).not.toBe(true);
      expect(r.structuredContent).toMatchObject({ credits_used: 40, credits_left: 1960 });
    });
    expect(ledger.map((c) => c.path)).toEqual(["/api/credits/reserve", "/api/credits/settle", "/api/credits/settle"]);
  });

  it("reports a shadow would-block hold normally (the ledger decides; nothing refused)", async () => {
    const base = ledgerOk(10);
    const { gemini } = mockUpstreams({
      ledger: (path, body) => {
        if (path !== "/api/credits/reserve") return base(path, body);
        return Response.json({ ok: true, mode: "shadow", would_block: true, hold: { amount: 40 }, balance: balance(0) }, { headers: { "X-Credits-Would-Block": "1" } });
      },
    });
    await withClient({ CREDITS_MODE: mode }, async (client) => {
      expect((await client.callTool(fast)).isError).not.toBe(true);
    });
    expect(gemini).toHaveLength(1);
  });
});

const insufficient = (available: number, needed = 40) => () =>
  Response.json({ error: "insufficient_credits", needed, available, resets_at: RESETS }, { status: 402 });

describe("generate_image credits: refusals", () => {
  it("enforce at 0: tool error with the credits link, no Gemini call, nothing to release (acceptance #12)", async () => {
    const { ledger, gemini } = mockUpstreams({ ledger: insufficient(0) });
    await withClient({ CREDITS_MODE: "enforce" }, async (client) => {
      const r = await client.callTool(fast);
      expect(r.isError).toBe(true);
      expect(errorOf(r)).toEqual({
        error: "INSUFFICIENT_CREDITS",
        message: "Acme is out of AI credits (0 left, resets Oct 1). See https://dashboard.scrymore.com/credits",
        retryable: false,
        needed: 40,
        available: 0,
        resets_at: RESETS,
        credits_url: "https://dashboard.scrymore.com/credits",
        credits_wallet: "org:acme",
        credits_org_name: "Acme",
        request_id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      });
    });
    expect(gemini).toHaveLength(0);
    expect(ledger.map((c) => c.path)).toEqual(["/api/credits/reserve"]);
  });

  it("enforce with 20 left asking for quality: says what it needs and links CREDITS_PAGE_URL", async () => {
    const { gemini } = mockUpstreams({ ledger: insufficient(20, 150) });
    await withClient({ CREDITS_MODE: "enforce", CREDITS_PAGE_URL: "https://dashboard-stage.scrymore.com/credits" }, async (client) => {
      expect(errorOf(await client.callTool(qualityCall)).message).toBe(
        "Not enough AI credits: A quality image needs 150 and Acme has 20 left, resets Oct 1. See https://dashboard-stage.scrymore.com/credits",
      );
    });
    expect(gemini).toHaveLength(0);
  });

  it("shadow never refuses: a 402 is logged and the image is generated uncharged", async () => {
    const { ledger, gemini } = mockUpstreams({ ledger: insufficient(0) });
    await withClient({ CREDITS_MODE: "shadow" }, async (client) => {
      const r = await client.callTool(fast);
      expect(r.isError).not.toBe(true);
      expect(r.structuredContent).not.toHaveProperty("credits_used");
    });
    expect(gemini).toHaveLength(1);
    expect(ledger.map((c) => c.path)).toEqual(["/api/credits/reserve"]);
  });

  it.each([
    ["ledger 500", { ledger: () => new Response("err", { status: 500 }) }, {}],
    ["ledger 401 (bad token)", { ledger: () => Response.json({ error: "Unauthorized" }, { status: 401 }) }, {}],
    ["network error", { ledger: () => { throw new TypeError("fetch failed"); } }, {}],
    ["CREDITS_API_TOKEN unset", {}, { CREDITS_API_TOKEN: undefined }],
    ["CREDITS_API_URL unset", {}, { CREDITS_API_URL: undefined }],
    ["Firestore 500 (wallet unresolvable)", { firestoreStatus: 500 }, {}],
    ["Firestore service account unset", {}, { FIREBASE_PRIVATE_KEY: undefined }],
  ] as const)("enforce fails closed on %s: CREDITS_UNAVAILABLE, no Gemini call", async (_label, upstream, overrides) => {
    const { gemini } = mockUpstreams(upstream as Parameters<typeof mockUpstreams>[0]);
    await withClient({ CREDITS_MODE: "enforce", ...overrides }, async (client) => {
      const r = await client.callTool(fast);
      expect(errorOf(r)).toMatchObject({ error: "CREDITS_UNAVAILABLE", retryable: true });
    });
    expect(gemini).toHaveLength(0);
  });

  it("shadow fails open when the ledger is unreachable", async () => {
    const { gemini } = mockUpstreams({ ledger: () => new Response("err", { status: 500 }) });
    await withClient({ CREDITS_MODE: "shadow" }, async (client) => {
      const r = await client.callTool(fast);
      expect(r.isError).not.toBe(true);
      expect(r.structuredContent).not.toHaveProperty("credits_used");
    });
    expect(gemini).toHaveLength(1);
  });

  it("a ledger in CREDITS_MODE off (skipped) charges nothing", async () => {
    const { ledger } = mockUpstreams({ ledger: () => Response.json({ ok: true, mode: "off", skipped: true }) });
    await withClient({ CREDITS_MODE: "enforce" }, async (client) => {
      const r = await client.callTool(fast);
      expect(r.isError).not.toBe(true);
      expect(r.structuredContent).not.toHaveProperty("credits_used");
    });
    expect(ledger.map((c) => c.path)).toEqual(["/api/credits/reserve"]);
  });
});

describe("search_by_image surfaces the search API's 402", () => {
  it("maps 402 insufficient_credits to INSUFFICIENT_CREDITS with the credits link", async () => {
    mockUpstreams({
      search: () => Response.json(
        { error: "insufficient_credits", code: "insufficient_credits", needed: 1, available: 0, resets_at: RESETS, message: "x" },
        { status: 402 },
      ),
    });
    await withClient({}, async (client) => {
      const r = await client.callTool({ name: "search_by_image", arguments: { image: "aW1hZ2U=" } });
      expect(r.isError).toBe(true);
      expect(errorOf(r)).toEqual({
        error: "INSUFFICIENT_CREDITS",
        message: "You're out of AI credits (0 left, resets Oct 1). See https://dashboard.scrymore.com/credits",
        retryable: false,
        request_id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      });
    });
  });

  it("leaves other 402 bodies to the generic mapping", async () => {
    mockUpstreams({ search: () => new Response("payment required", { status: 402 }) });
    await withClient({}, async (client) => {
      const r = await client.callTool({ name: "search_by_image", arguments: { image: "aW1hZ2U=" } });
      expect(errorOf(r)).toMatchObject({ error: "SEARCH_API_402", retryable: false });
    });
  });
});

describe("credits helpers", () => {
  it("creditsMode defaults to off and accepts shadow/enforce only", () => {
    expect(creditsMode({})).toBe("off");
    expect(creditsMode({ CREDITS_MODE: " Enforce " })).toBe("enforce");
    expect(creditsMode({ CREDITS_MODE: "shadow" })).toBe("shadow");
    expect(creditsMode({ CREDITS_MODE: "on" })).toBe("off");
  });

  it("creditsPageUrl accepts https overrides only", () => {
    expect(creditsPageUrl({})).toBe("https://dashboard.scrymore.com/credits");
    expect(creditsPageUrl({ CREDITS_PAGE_URL: "javascript:alert(1)" })).toBe("https://dashboard.scrymore.com/credits");
    expect(creditsPageUrl({ CREDITS_PAGE_URL: "https://dashboard-stage.scrymore.com/credits" })).toBe("https://dashboard-stage.scrymore.com/credits");
  });

  it("formats reset dates and the used line", () => {
    expect(formatResetDate(RESETS)).toBe("Oct 1");
    expect(formatResetDate("nope")).toBe("");
    expect(creditsUsedLine(150, 1850, "")).toBe("Used 150 AI credits · 1,850 credits left.");
    expect(insufficientCreditsMessage({ needed: 40, available: 0, resetsAt: "" }, "A fast image", "https://x.test/credits"))
      .toBe("You're out of AI credits (0 left). See https://x.test/credits");
  });

  it("parses Gemini usageMetadata, including the IMAGE modality and thinking tokens", () => {
    expect(parseGeminiUsage(undefined)).toBeNull();
    expect(parseGeminiUsage(USAGE)).toEqual({ inputTokens: 9, outputTokens: 1290, imageOutputTokens: 1290, thoughtsTokens: 0, totalTokens: 1299 });
    const pro = parseGeminiUsage({ promptTokenCount: 12, candidatesTokenCount: 1120, thoughtsTokenCount: 300,
      candidatesTokensDetails: [{ modality: "TEXT", tokenCount: 0 }, { modality: "IMAGE", tokenCount: 1120 }] });
    expect(pro).toEqual({ inputTokens: 12, outputTokens: 1120, imageOutputTokens: 1120, thoughtsTokens: 300, totalTokens: 1432 });
    expect(parseGeminiUsage({ promptTokenCount: -1 } as never)).toMatchObject({ inputTokens: 0, imageOutputTokens: null });
    expect(usageReason("m", pro)).toBe("m · 12 in · 1120 out (1120 image) · 300 thinking · 1432 total tokens");
    expect(usageReason("m", null)).toBe("m · tokens not reported");
  });
});

describe("generate_image wallet resolution (D1 revised: org wallets, rule 3 without a project)", () => {
  const reserveWallet = async (docs: Docs, extra: Partial<Env> = {}) => {
    const up = mockUpstreams({ docs });
    let structured: Record<string, unknown> = {};
    let text: (string | undefined)[] = [];
    await withClient({ CREDITS_MODE: "shadow", ...extra }, async (client) => {
      const r = await client.callTool(fast);
      structured = r.structuredContent as Record<string, unknown>;
      text = texts(r);
    });
    return { ...up, wallet: up.ledger[0]?.body.wallet_id, structured, text };
  };

  it("uses the active org when the caller is a member, reading users/{uid} then orgs/{id} once", async () => {
    const r = await reserveWallet(defaultDocs());
    expect(r.wallet).toBe("org:acme");
    expect(r.firestore).toEqual(["users/credits-test-user", "orgs/acme"]);
    // The service-account assertion is a JWT bearer grant.
    expect(r.tokenRequests[0]).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
  });

  it("falls back to the personal org when the caller is not in the active org's memberIds", async () => {
    const docs = defaultDocs();
    docs["orgs/acme"] = { name: { stringValue: "Acme" }, memberIds: { arrayValue: { values: [{ stringValue: "someone-else" }] } } };
    const r = await reserveWallet(docs);
    expect(r.wallet).toBe("org:personal_credits-test-user");
    expect(r.structured).toMatchObject({ credits_wallet: "org:personal_credits-test-user", credits_org_name: "Personal workspace" });
    expect(r.text).toContain("Used 40 AI credits · Personal workspace · 1,960 credits left (resets Oct 1).");
    expect(r.firestore).toEqual(["users/credits-test-user", "orgs/acme", "orgs/personal_credits-test-user"]);
  });

  it("falls back to the personal org when activeOrgId is unset or the user doc is missing, named from its doc", async () => {
    const r1 = await reserveWallet({
      "users/credits-test-user": {},
      "orgs/personal_credits-test-user": { name: { stringValue: "Credits Test's workspace" }, personal: { booleanValue: true } },
    });
    expect(r1.wallet).toBe("org:personal_credits-test-user");
    expect(r1.firestore).toEqual(["users/credits-test-user", "orgs/personal_credits-test-user"]);
    expect(r1.structured).toMatchObject({ credits_org_name: "Credits Test's workspace" });
    vi.restoreAllMocks();
    const r2 = await reserveWallet({});
    expect(r2.wallet).toBe("org:personal_credits-test-user");
    expect(r2.structured).toMatchObject({ credits_org_name: "Personal workspace" });
  });

  it("falls back to the personal org when the active org doc does not exist", async () => {
    const r = await reserveWallet({ "users/credits-test-user": { activeOrgId: { stringValue: "gone" } } });
    expect(r.wallet).toBe("org:personal_credits-test-user");
  });

  it("uses the personal org doc's own name when it is the active org", async () => {
    const r = await reserveWallet({
      "users/credits-test-user": { activeOrgId: { stringValue: "personal_credits-test-user" } },
      "orgs/personal_credits-test-user": { name: { stringValue: "My space" }, memberIds: { arrayValue: { values: [{ stringValue: "credits-test-user" }] } } },
    });
    expect(r.wallet).toBe("org:personal_credits-test-user");
    expect(r.structured).toMatchObject({ credits_org_name: "My space" });
    expect(r.firestore).toEqual(["users/credits-test-user", "orgs/personal_credits-test-user"]);
  });

  it("ignores an activeOrgId that cannot be a wallet id", async () => {
    const r = await reserveWallet({ "users/credits-test-user": { activeOrgId: { stringValue: "../projects/x" } } });
    expect(r.wallet).toBe("org:personal_credits-test-user");
    expect(r.firestore).toEqual(["users/credits-test-user", "orgs/personal_credits-test-user"]);
  });

  it("caches the resolution for a minute: two images, one pair of Firestore reads", async () => {
    const up = mockUpstreams();
    await withClient({ CREDITS_MODE: "shadow" }, async (client) => {
      await client.callTool(fast);
      await client.callTool(fast);
    });
    expect(up.firestore).toEqual(["users/credits-test-user", "orgs/acme"]);
    expect(up.tokenRequests).toHaveLength(1);
    expect(up.ledger.filter((c) => c.path === "/api/credits/reserve").map((c) => c.body.wallet_id)).toEqual(["org:acme", "org:acme"]);
  });

  it("never reads Firestore with CREDITS_MODE off", async () => {
    const up = mockUpstreams();
    await withClient({ CREDITS_MODE: "off" }, async (client) => {
      await client.callTool(fast);
    });
    expect(up.firestore).toHaveLength(0);
  });
});

describe("generate_image ledger key is server-minted, never the request id", () => {
  it("an inbound request id reused across two calls produces two distinct ledger refs and two charges", async () => {
    const INBOUND = "01M3EQG44Y0J8F2K6ZP9RX1T7C";
    const { ledger, gemini } = mockUpstreams();
    const trace: string[] = [];
    await withClient({ CREDITS_MODE: "enforce" }, async (client) => {
      for (let i = 0; i < 2; i++) {
        const r = await client.callTool(fast);
        expect(r.isError).not.toBe(true);
      }
    }, { inboundRequestId: INBOUND });
    for (const c of ledger) trace.push(c.headers.get("x-scry-request-id") ?? "");
    expect(gemini).toHaveLength(2);
    const reserves = ledger.filter((c) => c.path === "/api/credits/reserve");
    const settles = ledger.filter((c) => c.path === "/api/credits/settle");
    expect(reserves).toHaveLength(2);
    expect(settles).toHaveLength(2);
    const refs = reserves.map((c) => String(c.body.ref_id));
    expect(new Set(refs).size).toBe(2);
    for (const ref of refs) {
      expect(ref).toMatch(/^mcp-image:[0-9a-f-]{36}$/);
      expect(ref).not.toContain(INBOUND);
    }
    expect(settles.map((c) => c.body.ref_id)).toEqual(refs);
    // The inbound id is still used for tracing: it is forwarded on the ledger hop.
    expect(trace).toEqual([INBOUND, INBOUND, INBOUND, INBOUND]);
  });
});
