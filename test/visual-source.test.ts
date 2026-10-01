/**
 * adobe-bride-investigation (PR3, scry-mcp): the `source` filter on search_components and search_by_image,
 * and non-UI wording for rows of a visual (Adobe Bridge) collection.
 *
 * guarantee-1: UI search is unchanged: no `source` in the API body unless asked, and a UI row's text and
 *              structuredContent carry no visual wording.
 * guarantee-6: the search API's refusal (403 for a non-member) comes back as a tool error with no rows,
 *              no captions and no images, and a client-controlled `source` never reaches a log line.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScryMCP, type AuthProps } from "../src/mcp";
import { extractResultMetadata, formatVisualIdentityLines, isVisualRow } from "../src/utils/result-metadata";
import { CROSS_PROJECT_WARNING, VISUAL_CROSS_PROJECT_WARNING } from "../src/utils/scope-notice";

declare module "cloudflare:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Workers pool environment augmentation.
  interface ProvidedEnv extends Env {}
}

const props: AuthProps = { firebaseUid: "visual-uid", email: "visual@example.test", displayName: "Visual", emailVerified: true };

class TestScryMCP extends ScryMCP {
  constructor(state: DurableObjectState, bindings: Env) {
    super(state, bindings);
  }
}

async function withClient(test: (client: Client) => Promise<void>) {
  const stub = env.MCP_OBJECT.get(env.MCP_OBJECT.newUniqueId());
  await runInDurableObject(stub, async (_instance, state) => {
    const agent = new TestScryMCP(state, {
      ...env,
      SCRY_ENV: "staging",
      SCRY_SEARCH_API_URL: "https://search.example.test",
      SCRY_SEARCH_API_KEY: "test-api-key",
      SCRY_CALLER_ASSERTION_SECRET: "test-caller-assertion-secret",
      MCP_USAGE: undefined,
    });
    agent.props = props;
    await agent.init();
    const client = new Client({ name: "visual-source-test", version: "1.0.0" });
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

interface Seen {
  searchBodies: Array<Record<string, unknown>>;
  presigned: string[];
}

function stubApi(respond: (body: Record<string, unknown>) => Response): Seen {
  const seen: Seen = { searchBodies: [], presigned: [] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (url.endsWith("/api/image/presign")) {
      seen.presigned.push(String(body.path));
      return Response.json({ url: `https://r2.example.test/signed/${body.path}`, expires_at: "2026-10-01T12:00:00Z" });
    }
    seen.searchBodies.push(body);
    return respond(body);
  });
  return seen;
}

function captureConsole() {
  const out: string[] = [];
  for (const m of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      out.push(a.map(x => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(" "));
    });
  }
  return out;
}

const uiRow = {
  id: "ui-1",
  score: 0.91,
  component_name: "LoginForm",
  searchable_text: "A login form",
  project_id: "ui-public",
  screenshot_url: "ui-public/shots/login.png",
  json_content: {
    filepath: "src/LoginForm.stories.tsx",
    componentFilePath: "src/LoginForm.tsx",
    storyTitle: "Forms/LoginForm",
    testName: "Default",
    inspection: { description: "A login form" },
  },
};

const visualRow = {
  id: "vis-1",
  score: 0.88,
  component_name: "IMG_0042.jpg",
  searchable_text: "a bride in a garden",
  project_id: "visual-private",
  screenshot_url: "visual-private/shots/img-0042.png",
  json_content: {
    source_type: "x-adobe-bridge",
    profile: "visual",
    author_title: "Bride in the garden",
    author_description: "Evening light,\nsecond line",
    author_keywords: ["wedding", "garden", 7, "  "],
    rating: 4,
    label: "Approved",
    creator: "J. Photographer",
    filepath: "bundle/IMG_0042.jpg",
    storyTitle: "should-not-show",
  },
};

const page = (rows: unknown[]) => ({ results: rows, pagination: { page: 1, limit: 10, total: rows.length } });
const respondWith = (rows: unknown[]) => () => Response.json({ ...page(rows), scope: "project" });

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (res: ToolResult) => (res.content as Array<{ text: string }>)[0].text;
type Structured = { results: Array<Record<string, unknown>>; summary: string };
const structuredOf = (res: ToolResult) => res.structuredContent as unknown as Structured;
const rowsOf = (res: ToolResult) => (res.structuredContent as Partial<Structured> | undefined)?.results ?? [];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("visual row helpers", () => {
  it("isVisualRow is true for profile=visual or the Bridge source kind, false for UI rows", () => {
    expect(isVisualRow({ profile: "visual" })).toBe(true);
    expect(isVisualRow({ source_type: "x-adobe-bridge" })).toBe(true);
    expect(isVisualRow({ sourceType: "x-adobe-bridge" })).toBe(true);
    expect(isVisualRow({ profile: "ui" })).toBe(false);
    expect(isVisualRow({ source_type: "storybook-rn" })).toBe(false);
    expect(isVisualRow({})).toBe(false);
    expect(isVisualRow(undefined)).toBe(false);
  });

  it("extractResultMetadata adds `visual` only for visual rows", () => {
    expect("visual" in extractResultMetadata(uiRow.json_content)).toBe(false);
    const meta = extractResultMetadata(visualRow.json_content);
    expect(meta.visual).toEqual({
      title: "Bride in the garden",
      keywords: ["wedding", "garden"],
      rating: 4,
      label: "Approved",
      creator: "J. Photographer",
    });
  });

  it("author text is one line and bounded", () => {
    const meta = extractResultMetadata({
      profile: "visual",
      author_title: `a\n\n${"x".repeat(500)}`,
      author_keywords: Array.from({ length: 50 }, (_, i) => `k${i}`),
    });
    expect(meta.visual?.title).not.toMatch(/\n/);
    expect(meta.visual?.title?.length).toBeLessThanOrEqual(200);
    expect(meta.visual?.keywords).toHaveLength(20);
  });

  it("formatVisualIdentityLines has no Platform, Source or Story line", () => {
    const lines = formatVisualIdentityLines(0, { id: "v", score: 0.5 }, { visual: { title: "T", rating: 3 } });
    expect(lines.join("\n")).toContain("Image (visual collection)");
    expect(lines.join("\n")).not.toMatch(/Platform|Source|Story|component/i);
  });
});

describe("guarantee-1: UI search through the MCP is unchanged", () => {
  it("guarantee-1: no `source` in the API body unless the caller passes one", async () => {
    const seen = stubApi(respondWith([uiRow]));
    await withClient(async client => {
      await client.callTool({ name: "search_components", arguments: { query: "login" } });
      await client.callTool({ name: "search_by_image", arguments: { image_url: "https://example.test/a.png" } }).catch(() => undefined);
    });
    expect(seen.searchBodies.length).toBeGreaterThan(0);
    for (const body of seen.searchBodies) expect("source" in body).toBe(false);
  });

  it("guarantee-1: a UI row keeps its component wording and gains no visual field", async () => {
    stubApi(respondWith([uiRow]));
    await withClient(async client => {
      const res = await client.callTool({ name: "search_components", arguments: { query: "login" } });
      expect(res.isError).not.toBe(true);
      const text = textOf(res);
      expect(text).toContain("LoginForm");
      expect(text).toContain("src/LoginForm.tsx");
      expect(text).not.toContain("Image (visual collection)");
      expect(text).not.toMatch(/Keywords:|Rating:|Creator:/);
      const row = structuredOf(res).results[0];
      expect(row.profile).toBeUndefined();
      expect(row.keywords).toBeUndefined();
    });
  });

  it("guarantee-1: a cross-project UI row keeps the import warning", async () => {
    stubApi(() => Response.json({ ...page([{ ...uiRow, crossProject: true }]), scope: "org", widenedToOrg: true }));
    await withClient(async client => {
      const res = await client.callTool({ name: "search_components", arguments: { query: "login", scope: "org", project_id: "ui-public" } });
      expect(textOf(res)).toContain(CROSS_PROJECT_WARNING);
      expect(textOf(res)).not.toContain(VISUAL_CROSS_PROJECT_WARNING);
    });
  });

  it("guarantee-1: the first line of both tool descriptions is unchanged", async () => {
    await withClient(async client => {
      const { tools } = await client.listTools();
      const byName = Object.fromEntries(tools.map(t => [t.name, t]));
      expect(byName.search_components.description?.split("\n")[0]).toBe("Search for UI components by text query.");
      for (const name of ["search_components", "search_by_image"]) {
        expect(byName[name].description).toContain("Visual collections");
        expect(JSON.stringify(byName[name].inputSchema)).toContain("source");
      }
    });
  });
});

describe("source filter and visual wording", () => {
  it("forwards `source` to the search API when asked", async () => {
    const seen = stubApi(respondWith([visualRow]));
    await withClient(async client => {
      const res = await client.callTool({ name: "search_components", arguments: { query: "bride", source: "x-adobe-bridge" } });
      expect(res.isError).not.toBe(true);
    });
    expect(seen.searchBodies[0].source).toBe("x-adobe-bridge");
  });

  it("words a visual row as an image, with the author's metadata and no component fields", async () => {
    stubApi(respondWith([visualRow]));
    await withClient(async client => {
      const res = await client.callTool({ name: "search_components", arguments: { query: "bride", source: "x-adobe-bridge" } });
      const text = textOf(res);
      expect(text).toContain("**Bride in the garden**");
      expect(text).toContain("Image (visual collection)");
      expect(text).toContain("Keywords: wedding, garden");
      expect(text).toContain("Rating: 4/5");
      expect(text).toContain("Label: Approved");
      expect(text).toContain("Creator: J. Photographer");
      expect(text).not.toMatch(/Source:|Story:|Platform:|bundle\/IMG_0042|should-not-show/);
      const row = structuredOf(res).results[0];
      expect(row.profile).toBe("visual");
      expect(row.keywords).toEqual(["wedding", "garden"]);
    });
  });

  it("a cross-project visual row warns about reuse, not importing", async () => {
    stubApi(() => Response.json({ ...page([{ ...visualRow, crossProject: true }]), scope: "org", widenedToOrg: true }));
    await withClient(async client => {
      const res = await client.callTool({ name: "search_components", arguments: { query: "bride", scope: "org", project_id: "visual-private" } });
      expect(textOf(res)).toContain(VISUAL_CROSS_PROJECT_WARNING);
      expect(textOf(res)).not.toContain("importing");
    });
  });

  it("rejects a `source` of the wrong shape before any request is made", async () => {
    const seen = stubApi(respondWith([]));
    const bad = ["", "a b", "x-adobe-bridge;drop", "../etc", "a/b", "é", "x".repeat(101), "a\nb", "<script>"];
    await withClient(async client => {
      for (const source of bad) {
        const res = await client
          .callTool({ name: "search_components", arguments: { query: "bride", source } })
          .catch(() => ({ isError: true }) as ToolResult);
        expect(res.isError, JSON.stringify(source)).toBe(true);
      }
    });
    expect(seen.searchBodies).toHaveLength(0);
  });

  it("accepts a bare kind and a sourceKey", async () => {
    const seen = stubApi(respondWith([]));
    await withClient(async client => {
      for (const source of ["x-adobe-bridge", "x-adobe-bridge:lib-1", "storybook-rn"]) {
        const res = await client.callTool({ name: "search_components", arguments: { query: "q", source } });
        expect(res.isError, source).not.toBe(true);
      }
    });
    expect(seen.searchBodies.map(b => b.source)).toEqual(["x-adobe-bridge", "x-adobe-bridge:lib-1", "storybook-rn"]);
  });
});

describe("guarantee-6: a non-member gets no rows, captions or images", () => {
  it("guarantee-6: a 403 from the search API is a tool error carrying no rows, captions or presigned images", async () => {
    const seen = stubApi(() => Response.json({ error: "Forbidden", code: "project_forbidden" }, { status: 403 }));
    await withClient(async client => {
      const res = await client.callTool({
        name: "search_components",
        arguments: { query: "bride", project_id: "visual-private", source: "x-adobe-bridge" },
      });
      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).toContain("PROJECT_FORBIDDEN");
      expect(text).not.toMatch(/Bride in the garden|a bride in a garden|Keywords:/);
      expect(rowsOf(res)).toEqual([]);
      expect((res.content as Array<{ type: string }>).some(c => c.type === "image")).toBe(false);
    });
    expect(seen.presigned).toHaveLength(0);
  });

  it("guarantee-6: a 401 or 403 from search_by_image returns no rows and fetches no image", async () => {
    for (const status of [401, 403]) {
      const seen = stubApi(() => Response.json({ error: "no" }, { status }));
      await withClient(async client => {
        const res = await client.callTool({
          name: "search_by_image",
          arguments: { image_url: "https://example.test/a.png", project_id: "visual-private", source: "x-adobe-bridge" },
        });
        expect(res.isError).toBe(true);
        expect(rowsOf(res)).toEqual([]);
      });
      expect(seen.presigned).toHaveLength(0);
      vi.restoreAllMocks();
    }
  });

  it("guarantee-6: the `source` value reaches no log line, on a refusal or on success", async () => {
    const canary = "x-adobe-bridge:canary-9f3a1c";
    for (const respond of [
      () => Response.json({ error: "Forbidden", code: "project_forbidden" }, { status: 403 }),
      respondWith([visualRow]),
    ]) {
      const out = captureConsole();
      stubApi(respond);
      await withClient(async client => {
        await client.callTool({ name: "search_components", arguments: { query: "bride", project_id: "visual-private", source: canary } });
      });
      await new Promise(r => setTimeout(r, 20));
      expect(out.join("\n")).not.toContain(canary);
      expect(out.join("\n")).not.toContain("canary-9f3a1c");
      vi.restoreAllMocks();
    }
  });
});
