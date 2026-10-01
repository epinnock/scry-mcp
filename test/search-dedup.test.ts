/**
 * search-dedup (PR 2, scry-mcp): `versions` on search_components and search_by_image, a version line and
 * `versionCount` on each result, and a summary sentence, so the preview count equals the deduped row count.
 *
 * The API responses come from test/fixtures/search-dedup-response.json, recorded by scry-nextjs PR 1's API
 * tests (never hand-written here). The only change a test makes to a recorded row is adding a
 * `screenshot_url` (the recording has none) so there is something to preview; the negative tests strip the
 * two new fields from a recorded response to play an API that predates the feature.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScryMCP, type AuthProps } from "../src/mcp";
import {
  DEFAULT_VERSIONS,
  extractDuplicatesCollapsed,
  extractVersionCount,
  formatCollapsedSentence,
  formatVersionLine,
} from "../src/utils/version-info";
import recorded from "./fixtures/search-dedup-response.json";

declare module "cloudflare:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Workers pool environment augmentation.
  interface ProvidedEnv extends Env {}
}

type Row = Record<string, unknown> & { id: string; version_count?: number; build_sha?: string };
type ApiResponse = Record<string, unknown> & { results: Row[]; duplicates_collapsed?: number };
type RecordedCase = { request: Record<string, unknown>; status: number; response: ApiResponse };

const cases = recorded.cases as unknown as Record<"latest" | "all", RecordedCase>;
const props: AuthProps = { firebaseUid: "dedup-uid", email: "dedup@example.test", displayName: "Dedup", emailVerified: true };

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
    const client = new Client({ name: "dedup-test", version: "1.0.0" });
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

const withScreenshots = (response: ApiResponse): ApiResponse => ({
  ...response,
  results: response.results.map(r => ({ ...r, screenshot_url: `screenshots/${r.id}.png` })),
});

/** An API that predates the feature: no per-row version_count, no top-level duplicates_collapsed. */
function oldApiShape(response: ApiResponse): ApiResponse {
  const old: ApiResponse = { ...response, results: response.results.map(r => ({ ...r })) };
  delete old.duplicates_collapsed;
  for (const row of old.results) delete row.version_count;
  return old;
}

interface Seen {
  searchBodies: Array<Record<string, unknown>>;
  presigned: string[];
}

/** Stub fetch: /api/search answers `respond(body)`, /api/image/presign answers a signed URL. */
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

const recordedByVersions = (body: Record<string, unknown>) =>
  Response.json(withScreenshots(body.versions === "all" ? cases.all.response : cases.latest.response));

type Structured = {
  results: Array<{ screenshotUrl?: string; versionCount?: number; name: string; storyId?: string }>;
  summary: string;
  versions: string;
  duplicatesCollapsed?: number;
};
const textOf = (res: Awaited<ReturnType<Client["callTool"]>>) => (res.content as Array<{ text: string }>)[0].text;
const structuredOf = (res: Awaited<ReturnType<Client["callTool"]>>) => res.structuredContent as unknown as Structured;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("version-info helpers", () => {
  it("extractVersionCount accepts only positive whole numbers", () => {
    expect(extractVersionCount({ version_count: 3 })).toBe(3);
    expect(extractVersionCount({ version_count: 1 })).toBe(1);
    for (const bad of [0, -1, 1.5, "3", null, undefined, Number.NaN]) {
      expect(extractVersionCount({ version_count: bad })).toBeUndefined();
    }
    expect(extractVersionCount({})).toBeUndefined();
    expect(extractVersionCount(undefined)).toBeUndefined();
  });

  it("extractDuplicatesCollapsed accepts zero and positive whole numbers only", () => {
    expect(extractDuplicatesCollapsed(0)).toBe(0);
    expect(extractDuplicatesCollapsed(11)).toBe(11);
    for (const bad of [-1, 2.5, "4", null, undefined]) expect(extractDuplicatesCollapsed(bad)).toBeUndefined();
  });

  it("formatVersionLine words the three cases and says nothing without a count", () => {
    expect(formatVersionLine(4, "latest", "a1b2c3d")).toBe("Versions: 4 indexed (showing newest, build a1b2c3d)");
    expect(formatVersionLine(4, "latest", undefined)).toBe("Versions: 4 indexed (showing newest)");
    expect(formatVersionLine(1, "latest", "a1b2c3d")).toBe("Versions: 1 indexed");
    expect(formatVersionLine(4, "all", "a1b2c3d")).toBe("Versions: 4 in these results");
    expect(formatVersionLine(undefined, "latest", "a1b2c3d")).toBeUndefined();
  });

  it("formatCollapsedSentence is silent unless rows were folded", () => {
    expect(formatCollapsedSentence(9, 11)).toBe('9 screens, 11 older versions hidden (pass versions: "all" to see them)');
    expect(formatCollapsedSentence(1, 1)).toBe('1 screen, 1 older version hidden (pass versions: "all" to see them)');
    expect(formatCollapsedSentence(9, 0)).toBeUndefined();
    expect(formatCollapsedSentence(9, undefined)).toBeUndefined();
  });

  it("the default is latest", () => {
    expect(DEFAULT_VERSIONS).toBe("latest");
  });
});

describe("contract: search_components over the recorded dedup response", () => {
  it("defaults to versions=latest, forwards it, and shows one preview per deduped row", async () => {
    const seen = stubApi(recordedByVersions);
    await withClient(async client => {
      const res = await client.callTool({ name: "search_components", arguments: { query: "login" } });
      expect(res.isError).not.toBe(true);

      expect(seen.searchBodies).toHaveLength(1);
      expect(seen.searchBodies[0].versions).toBe("latest");

      const rows = cases.latest.response.results;
      const structured = structuredOf(res);
      // The headline: preview count == deduped row count == presign calls.
      expect(structured.results).toHaveLength(rows.length);
      expect(structured.results.filter(r => r.screenshotUrl)).toHaveLength(rows.length);
      expect(seen.presigned).toHaveLength(rows.length);
      expect(new Set(seen.presigned).size).toBe(rows.length);
    });
  });

  it("puts the version count on every result: text line and structuredContent versionCount", async () => {
    stubApi(recordedByVersions);
    await withClient(async client => {
      const res = await client.callTool({ name: "search_components", arguments: { query: "login" } });
      const rows = cases.latest.response.results;
      const structured = structuredOf(res);
      expect(structured.results.map(r => r.versionCount)).toEqual(rows.map(r => r.version_count));

      const text = textOf(res);
      for (const row of rows) {
        const sha = row.build_sha ? `, build ${row.build_sha.slice(0, 7)}` : "";
        const expected =
          row.version_count === 1 ? "Versions: 1 indexed" : `Versions: ${row.version_count} indexed (showing newest${sha})`;
        expect(text).toContain(expected);
      }
      // One version line per row, no more.
      expect(text.match(/^ {3}Versions: /gm)).toHaveLength(rows.length);
    });
  });

  it("says how many screens are shown and how many older versions were hidden", async () => {
    stubApi(recordedByVersions);
    await withClient(async client => {
      const res = await client.callTool({ name: "search_components", arguments: { query: "login" } });
      const { results, duplicates_collapsed } = cases.latest.response;
      const sentence = `${results.length} screens, ${duplicates_collapsed} older versions hidden (pass versions: "all" to see them)`;
      expect(textOf(res)).toContain(sentence);
      const structured = structuredOf(res);
      expect(structured.summary).toContain(sentence);
      expect(structured.duplicatesCollapsed).toBe(duplicates_collapsed);
      expect(structured.versions).toBe("latest");
    });
  });

  it('versions="all" is forwarded, restores the full list and drops the hidden-versions sentence', async () => {
    const seen = stubApi(recordedByVersions);
    await withClient(async client => {
      const res = await client.callTool({ name: "search_components", arguments: { query: "login", versions: "all", limit: 20 } });
      expect(res.isError).not.toBe(true);
      expect(seen.searchBodies[0].versions).toBe("all");

      const rows = cases.all.response.results;
      const structured = structuredOf(res);
      expect(structured.results).toHaveLength(rows.length);
      expect(structured.results.filter(r => r.screenshotUrl)).toHaveLength(rows.length);
      expect(structured.versions).toBe("all");
      expect(structured.duplicatesCollapsed).toBe(0);
      expect(textOf(res)).not.toContain("older version");
      expect(textOf(res)).toContain("Versions: 3 in these results");
      expect(textOf(res)).not.toContain("showing newest");
    });
  });

  it("legacy rows (no story_id, no build) still carry a version line, with no invented build", async () => {
    stubApi(recordedByVersions);
    await withClient(async client => {
      const res = await client.callTool({ name: "search_components", arguments: { query: "login" } });
      const legacy = cases.latest.response.results.filter(r => r.id.startsWith("legacy-") && r.version_count === 3);
      expect(legacy.length).toBeGreaterThan(0);
      expect(textOf(res)).toContain("Versions: 3 indexed (showing newest)\n");
    });
  });
});

describe("contract: search_by_image over the recorded dedup response", () => {
  const image = "iVBORw0KGgoAAAANSUhEUg==";

  it("defaults to versions=latest, forwards versions=all, and previews one image per row", async () => {
    const seen = stubApi(recordedByVersions);
    await withClient(async client => {
      const latest = await client.callTool({ name: "search_by_image", arguments: { image } });
      expect(seen.searchBodies[0].versions).toBe("latest");
      expect(structuredOf(latest).results).toHaveLength(cases.latest.response.results.length);
      expect(textOf(latest)).toContain("older versions hidden");
      expect(textOf(latest)).toContain("Versions: 3 indexed (showing newest");

      const all = await client.callTool({ name: "search_by_image", arguments: { image, versions: "all", limit: 20 } });
      expect(seen.searchBodies[1].versions).toBe("all");
      expect(structuredOf(all).results).toHaveLength(cases.all.response.results.length);
      expect(textOf(all)).not.toContain("older version");
    });
  });
});

describe("old API responses without the new fields", () => {
  it("search_components still works: same rows and previews, no version line, no hidden-versions sentence", async () => {
    stubApi(() => Response.json(withScreenshots(oldApiShape(cases.latest.response))));
    await withClient(async client => {
      const res = await client.callTool({ name: "search_components", arguments: { query: "login" } });
      expect(res.isError).not.toBe(true);

      const rows = cases.latest.response.results;
      const structured = structuredOf(res);
      expect(structured.results).toHaveLength(rows.length);
      expect(structured.results.filter(r => r.screenshotUrl)).toHaveLength(rows.length);
      expect(structured.results.every(r => r.versionCount === undefined)).toBe(true);
      expect(structured.duplicatesCollapsed).toBeUndefined();

      const text = textOf(res);
      expect(text).not.toContain("Versions:");
      expect(text).not.toContain("older version");
      expect(text).toContain(`Found ${rows.length} results`);
    });
  });

  it("search_by_image still works against an old API", async () => {
    stubApi(() => Response.json(withScreenshots(oldApiShape(cases.all.response))));
    await withClient(async client => {
      const res = await client.callTool({ name: "search_by_image", arguments: { image: "iVBORw0KGgo=", versions: "all" } });
      expect(res.isError).not.toBe(true);
      expect(structuredOf(res).results).toHaveLength(cases.all.response.results.length);
      expect(textOf(res)).not.toContain("Versions:");
    });
  });

  it("ignores malformed counts instead of printing them", async () => {
    const odd = cases.latest.response;
    stubApi(() =>
      Response.json({
        ...odd,
        duplicates_collapsed: "lots",
        results: odd.results.map(r => ({ ...r, version_count: 0 })),
      }),
    );
    await withClient(async client => {
      const res = await client.callTool({ name: "search_components", arguments: { query: "login" } });
      expect(res.isError).not.toBe(true);
      expect(textOf(res)).not.toContain("Versions:");
      expect(textOf(res)).not.toContain("older version");
    });
  });
});

describe("a bad versions value", () => {
  it("surfaces the API 400 and its machine code, on both tools", async () => {
    stubApi(() => Response.json({ error: "versions must be 'latest' or 'all'", code: "invalid_versions" }, { status: 400 }));
    await withClient(async client => {
      for (const call of [
        { name: "search_components", arguments: { query: "login", versions: "bogus" } },
        { name: "search_by_image", arguments: { image: "iVBORw0KGgo=", versions: "bogus" } },
      ]) {
        const res = await client.callTool(call);
        expect(res.isError).toBe(true);
        const body = JSON.parse(textOf(res)) as { error: string; message: string; retryable: boolean };
        expect(body.error).toBe("INVALID_VERSIONS");
        expect(body.message).toContain("400");
        expect(body.message).toContain("versions must be");
        expect(body.retryable).toBe(false);
      }
    });
  });

  it("is forwarded as given, never silently replaced by the default", async () => {
    const seen = stubApi(() => Response.json({ error: "x", code: "invalid_versions" }, { status: 400 }));
    await withClient(async client => {
      await client.callTool({ name: "search_components", arguments: { query: "login", versions: "bogus" } });
    });
    expect(seen.searchBodies[0].versions).toBe("bogus");
  });

  it("never reaches a log line (the client controls the value)", async () => {
    const out: string[] = [];
    for (const m of ["log", "warn", "error", "info", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        out.push(a.map(String).join(" "));
      });
    }
    stubApi(() => Response.json({ error: "versions must be 'latest' or 'all'", code: "invalid_versions" }, { status: 400 }));
    await withClient(async client => {
      await client.callTool({ name: "search_components", arguments: { query: "login", versions: "CANARY-7f3a" } });
      await client.callTool({ name: "search_by_image", arguments: { image: "iVBORw0KGgo=", versions: "CANARY-7f3a" } });
    });
    await new Promise(r => setTimeout(r, 25));
    expect(out.length).toBeGreaterThan(0);
    expect(out.join("\n")).not.toContain("CANARY-7f3a");
  });
});
