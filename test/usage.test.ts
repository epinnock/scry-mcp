import { env, runInDurableObject } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScryMCP, type AuthProps } from "../src/mcp";

declare module "cloudflare:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Workers pool environment augmentation.
  interface ProvidedEnv extends Env {}
}

const props: AuthProps = {
  firebaseUid: "usage-test-user",
  email: "usage@example.test",
  displayName: "Usage Test",
  emailVerified: true,
};

// Use the configured Workers pool and real Durable Object context. Supplying the
// constructor env lets us inspect writes with a spy instead of the opaque binding.
class TestScryMCP extends ScryMCP {
  constructor(state: DurableObjectState, bindings: Env) {
    super(state, bindings);
  }
}

async function withClient(
  binding: AnalyticsEngineDataset | undefined,
  test: (client: Client) => Promise<void>,
  overrides: Partial<Env> = {},
  auth: { props?: AuthProps } = { props },
) {
  const stub = env.MCP_OBJECT.get(env.MCP_OBJECT.newUniqueId());
  await runInDurableObject(stub, async (_instance, state) => {
    const agent = new TestScryMCP(state, {
      ...env,
      SCRY_ENV: "staging",
      SCRY_SEARCH_API_URL: "https://search.example.test",
      SCRY_SEARCH_API_KEY: "test-api-key",
      SCRY_CALLER_ASSERTION_SECRET: "test-caller-assertion-secret",
      GEMINI_API_KEY: "test-gemini-key",
      ...overrides,
      MCP_USAGE: binding,
    });
    agent.props = auth.props as AuthProps;
    await agent.init();
    const client = new Client({ name: "usage-test", version: "1.0.0" });
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

function mockUpstreams() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/api/search")) {
      return Response.json({ results: [], pagination: { page: 1, limit: 10, total: 0 } });
    }
    if (url.includes(":generateContent")) {
      return Response.json({ candidates: [{ content: { parts: [
        { inlineData: { data: "aW1hZ2U=", mimeType: "image/png" } },
      ] } }] });
    }
    if (url.endsWith("/api/image/upload")) return Response.json({ success: true });
    if (url.endsWith("/api/image/presign")) {
      return Response.json({ url: "https://images.example.test/image.png", expires_at: "2030-01-01T00:00:00Z" });
    }
    if (url === "https://images.example.test/image.png") {
      return new Response("image", { headers: { "content-type": "image/png" } });
    }
    throw new Error(`Unexpected test fetch: ${url}`);
  });
}

function point(tool: string, environment = "staging", uid = props.firebaseUid) {
  return { blobs: [tool, environment, uid], doubles: [1], indexes: [uid] };
}

const toolCalls = [
  { name: "whoami", arguments: {} },
  { name: "search_components", arguments: { query: "private query" } },
  { name: "search_by_image", arguments: { image: "private image", query: "private query" } },
  { name: "get_component_screenshot", arguments: { screenshot_url: "screenshots/private.png" } },
  { name: "generate_image", arguments: { prompt: "private prompt", reference_image: "private image" } },
];

afterEach(() => vi.restoreAllMocks());

describe("MCP usage analytics", () => {
  it.each(toolCalls)("records exactly one point for $name with only tool, env and uid", async (call) => {
    mockUpstreams();
    const writeDataPoint = vi.fn();
    await withClient({ writeDataPoint }, async (client) => {
      const result = await client.callTool(call);
      expect(result.isError).not.toBe(true);
      expect(writeDataPoint.mock.calls).toEqual([[point(call.name)]]);
    });
  });

  it("preserves the tool response when writing throws", async () => {
    const writeDataPoint = vi.fn(() => { throw new Error("Analytics unavailable"); });
    await withClient({ writeDataPoint }, async (client) => {
      expect(await client.callTool({ name: "whoami", arguments: {} })).toEqual({
        content: [{ type: "text", text: JSON.stringify({
          uid: props.firebaseUid,
          email: props.email,
          displayName: props.displayName,
          emailVerified: props.emailVerified,
        }, null, 2) }],
      });
      expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith(point("whoami"));
    });
  });

  it("preserves the tool response without a binding", async () => {
    await withClient(undefined, async (client) => {
      expect(await client.callTool({ name: "whoami", arguments: {} })).toEqual({
        content: [{ type: "text", text: JSON.stringify({
          uid: props.firebaseUid,
          email: props.email,
          displayName: props.displayName,
          emailVerified: props.emailVerified,
        }, null, 2) }],
      });
    });
  });

  it("uses unknown and anonymous when environment and props are absent", async () => {
    const writeDataPoint = vi.fn();
    await withClient({ writeDataPoint }, async (client) => {
      const result = await client.callTool(toolCalls[1]);
      expect(result.isError).toBe(true);
      expect(writeDataPoint.mock.calls).toEqual([[point("search_components", "unknown", "anonymous")]]);
    }, { SCRY_ENV: undefined, SCRY_CALLER_ASSERTION_SECRET: undefined }, {});
  });

  it.each([toolCalls[1], toolCalls[2], toolCalls[3], toolCalls[4]])(
    "does not count upstream error diagnostics for $name",
    async (call) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Upstream failed", { status: 500 }));
      const writeDataPoint = vi.fn();
      await withClient({ writeDataPoint }, async (client) => {
        expect((await client.callTool(call)).isError).toBe(true);
        expect(writeDataPoint.mock.calls).toEqual([[point(call.name)]]);
      });
    },
  );

  it("does not count extra screenshot diagnostics when image fetch throws", async () => {
    mockUpstreams().mockImplementation(async (input) => {
      if (String(input).endsWith("/api/image/presign")) {
        return Response.json({ url: "https://images.example.test/image.png", expires_at: "2030-01-01T00:00:00Z" });
      }
      throw new Error("Image unavailable");
    });
    const writeDataPoint = vi.fn();
    await withClient({ writeDataPoint }, async (client) => {
      expect((await client.callTool(toolCalls[3])).isError).not.toBe(true);
      expect(writeDataPoint.mock.calls).toEqual([[point("get_component_screenshot")]]);
    });
  });

  it.each([
    { name: "search_by_image", arguments: { image: "x".repeat(10 * 1024 * 1024 + 1) } },
    { name: "generate_image", arguments: { prompt: "test", reference_image: "x".repeat(10 * 1024 * 1024 + 1) } },
  ])("counts $name when handler validation rejects the image", async (call) => {
    const writeDataPoint = vi.fn();
    await withClient({ writeDataPoint }, async (client) => {
      expect((await client.callTool(call)).isError).toBe(true);
      expect(writeDataPoint.mock.calls).toEqual([[point(call.name)]]);
    });
  });

  it("counts each invocation once, including a rate-limited call", async () => {
    mockUpstreams();
    const writeDataPoint = vi.fn();
    await withClient({ writeDataPoint }, async (client) => {
      for (let i = 0; i < 60; i++) {
        expect((await client.callTool(toolCalls[1])).isError).not.toBe(true);
      }
      const result = await client.callTool(toolCalls[1]);
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(body).toEqual({
        error: "RATE_LIMITED",
        message: "Too many requests. Please wait a moment and try again.",
        retryable: true,
        request_id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      });
      expect(writeDataPoint.mock.calls).toEqual(Array.from({ length: 61 }, () => [point("search_components")]));
    });
  });
});
