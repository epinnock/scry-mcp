/**
 * searchable-snips (scry-mcp): snip hits returned by the search API pass through search_components and
 * search_by_image unchanged in shape, and story hits are untouched.
 *
 * The story hit is recorded (test/fixtures/search-dedup-response.json). The snip hit follows
 * scry-management/features/searchable-snips/contract.md §5: `source: "snip"`, `captureId`, `takenBy`, `takenAt`.
 * The MCP adds no access logic: whatever the API returns is what is shown.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScryMCP, type AuthProps } from "../src/mcp";
import { extractSnipHit, formatSnipLine } from "../src/utils/snip-hit";
import recorded from "./fixtures/search-dedup-response.json";

declare module "cloudflare:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Workers pool environment augmentation.
  interface ProvidedEnv extends Env {}
}

type Row = Record<string, unknown>;
const storyHit = (recorded.cases.latest.response.results as unknown as Row[])[0];
const snipHit: Row = {
  id: "snip:cap-123",
  score: 0.91,
  component_name: "Checkout error dialog",
  searchable_text: "Checkout error dialog",
  project_id: "proj-a",
  source: "snip",
  captureId: "cap-123",
  takenBy: "Ada Lovelace",
  takenAt: "2026-10-11T15:04:05.000Z",
  sharedByOwner: false,
};

const props: AuthProps = { firebaseUid: "snip-uid", email: "snip@example.test", displayName: "Snip", emailVerified: true };

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
    const client = new Client({ name: "snip-test", version: "1.0.0" });
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

function stubApi(results: Row[]) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ results, pagination: { page: 1, limit: 10, total: results.length } }),
  );
}

type Structured = { results: Array<Row> };
const textOf = (res: Awaited<ReturnType<Client["callTool"]>>) => (res.content as Array<{ text: string }>)[0].text;
const structuredOf = (res: Awaited<ReturnType<Client["callTool"]>>) => res.structuredContent as unknown as Structured;
// 1x1 PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extractSnipHit / formatSnipLine", () => {
  it("reads the four members from a snip row", () => {
    expect(extractSnipHit(snipHit)).toEqual({
      source: "snip",
      captureId: "cap-123",
      takenBy: "Ada Lovelace",
      takenAt: "2026-10-11T15:04:05.000Z",
    });
  });

  it("is undefined for a story row, a missing id, or a non-snip source", () => {
    expect(extractSnipHit(storyHit)).toBeUndefined();
    expect(extractSnipHit({ source: "snip" })).toBeUndefined();
    expect(extractSnipHit({ source: "snip", captureId: 7 })).toBeUndefined();
    expect(extractSnipHit({ source: "figma", captureId: "c" })).toBeUndefined();
    expect(extractSnipHit(undefined)).toBeUndefined();
  });

  it("keeps takenBy to one bounded line and drops malformed optional members", () => {
    const hit = extractSnipHit({ source: "snip", captureId: "c1", takenBy: "A\nB\r\n" + "x".repeat(500), takenAt: 5 });
    expect(hit?.takenBy).not.toMatch(/[\r\n]/);
    expect(hit?.takenBy?.length).toBeLessThanOrEqual(120);
    expect(hit?.takenAt).toBeUndefined();
  });

  it("words the line and says how to open it", () => {
    expect(formatSnipLine(extractSnipHit(snipHit))).toBe(
      "Snip (screen capture) by Ada Lovelace at 2026-10-11T15:04:05.000Z · captureId cap-123 · open with get_capture",
    );
    expect(formatSnipLine(undefined)).toBeUndefined();
  });
});

describe.each([
  ["search_components", { query: "checkout error" }],
  ["search_by_image", { image: PNG }],
])("%s with a snip hit and a story hit", (tool, args) => {
  it("passes source, captureId, takenBy and takenAt through on the snip hit only", async () => {
    stubApi([snipHit, storyHit]);
    await withClient(async client => {
      const res = await client.callTool({ name: tool, arguments: args });
      expect(res.isError).not.toBe(true);
      const [snip, story] = structuredOf(res).results;
      expect(snip).toMatchObject({ source: "snip", captureId: "cap-123", takenBy: "Ada Lovelace", takenAt: "2026-10-11T15:04:05.000Z" });
      for (const key of ["source", "captureId", "takenBy", "takenAt"]) expect(story).not.toHaveProperty(key);
      // The story hit keeps its existing shape.
      expect(story).toMatchObject({ name: "Login", projectId: "proj-a", storyId: "auth-login--default", versionCount: 3 });

      const text = textOf(res);
      expect(text).toContain("captureId cap-123 · open with get_capture");
      expect(text.match(/Snip \(screen capture\)/g)).toHaveLength(1);
    });
  });

  it("a response with only story hits renders no snip text and no snip members", async () => {
    stubApi([storyHit]);
    await withClient(async client => {
      const res = await client.callTool({ name: tool, arguments: args });
      expect(textOf(res)).not.toContain("Snip");
      expect(structuredOf(res).results[0]).not.toHaveProperty("captureId");
    });
  });

  it("the tool description mentions snips and get_capture", async () => {
    await withClient(async client => {
      const { tools } = await client.listTools();
      const description = tools.find(t => t.name === tool)?.description ?? "";
      expect(description).toContain("Results can include snips (screen captures) shared with you; open one with get_capture.");
    });
  });
});
