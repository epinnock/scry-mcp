import { describe, expect, it } from "vitest";
import {
  DIRECT_BASE_URL,
  gatewayHeaders,
  gatewayMetadata,
  gatewayRoot,
  llmBaseUrl,
  llmRoute,
  LlmGatewayConfigError,
  METADATA_MAX_VALUE,
} from "../src/llm-gateway";

const ROOT = "https://gateway.ai.cloudflare.com/v1/acct/scry-stage";
const on = { LLM_GATEWAY_URL: ROOT, CF_AIG_TOKEN: "run-token" };
const tags = { svc: "mcp", feat: "generate_image", user: "uid-1", run: "req-1" };

describe("llm-gateway", () => {
  it("is off (direct) when LLM_GATEWAY_URL is unset or blank", () => {
    for (const env of [{}, { LLM_GATEWAY_URL: "" }, { LLM_GATEWAY_URL: "   " }]) {
      expect(gatewayRoot(env)).toBeNull();
      expect(llmBaseUrl(env, "google-ai-studio")).toBe("https://generativelanguage.googleapis.com");
      expect(gatewayHeaders(env, tags)).toEqual({});
      expect(llmRoute(env, "google-ai-studio", tags).viaGateway).toBe(false);
    }
  });

  it("rewrites the Google AI Studio base URL under the gateway root (trailing slash tolerated)", () => {
    expect(llmBaseUrl({ LLM_GATEWAY_URL: `${ROOT}/` }, "google-ai-studio")).toBe(`${ROOT}/google-ai-studio`);
    expect(DIRECT_BASE_URL["google-ai-studio"]).toBe("https://generativelanguage.googleapis.com");
  });

  it("rejects a non-http gateway URL", () => {
    expect(() => gatewayRoot({ LLM_GATEWAY_URL: "gateway.example" })).toThrow(LlmGatewayConfigError);
  });

  it("always sends auth, metadata, skip-cache and collect-log-payload:false when on", () => {
    const h = gatewayHeaders(on, tags);
    expect(h).toEqual({
      "cf-aig-authorization": "Bearer run-token",
      "cf-aig-metadata": JSON.stringify({ svc: "mcp", feat: "generate_image", user: "uid-1", run: "req-1" }),
      "cf-aig-skip-cache": "true",
      "cf-aig-collect-log-payload": "false",
    });
    expect(llmRoute(on, "google-ai-studio", tags)).toEqual({ baseUrl: `${ROOT}/google-ai-studio`, headers: h, viaGateway: true });
  });

  it("throws when the gateway is on without a token", () => {
    expect(() => gatewayHeaders({ LLM_GATEWAY_URL: ROOT }, tags)).toThrow(/CF_AIG_TOKEN/);
    expect(() => gatewayHeaders({ LLM_GATEWAY_URL: ROOT, CF_AIG_TOKEN: " " }, tags)).toThrow(LlmGatewayConfigError);
  });

  it("caps metadata at 5 keys, drops empty and reserved keys, truncates values, escapes non-ASCII", () => {
    const meta = JSON.parse(gatewayMetadata({
      "cf.reserved": "x",
      a: "1", b: null, c: "", d: Number.NaN, e: 2, f: true, g: "x".repeat(300), h: "é", i: "dropped",
    }));
    expect(Object.keys(meta)).toEqual(["a", "e", "f", "g", "h"]);
    expect(meta.g).toHaveLength(METADATA_MAX_VALUE);
    expect(meta.h).toBe("é");
    expect(gatewayMetadata({ h: "é" })).toBe('{"h":"\\u00e9"}');
  });
});
