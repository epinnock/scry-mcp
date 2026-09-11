import { describe, it, expect } from "vitest";
import { searchApiHeaders } from "../src/search-api-headers";

describe("searchApiHeaders", () => {
  it("sends only the service key (plus extras) when no bypass token is configured", () => {
    expect(searchApiHeaders({ SCRY_SEARCH_API_KEY: "k" }, { "Content-Type": "application/json" })).toEqual({
      Authorization: "Bearer k",
      "Content-Type": "application/json",
    });
    expect(searchApiHeaders({ SCRY_SEARCH_API_KEY: "k", SCRY_SEARCH_API_BYPASS_TOKEN: "  " })).toEqual({
      Authorization: "Bearer k",
    });
  });

  it("adds the Vercel protection bypass header when a token is configured", () => {
    const headers = searchApiHeaders(
      { SCRY_SEARCH_API_KEY: "k", SCRY_SEARCH_API_BYPASS_TOKEN: " t0ken " },
      { "X-Scry-Caller": "jwt" },
    );
    expect(headers).toEqual({
      Authorization: "Bearer k",
      "X-Scry-Caller": "jwt",
      "x-vercel-protection-bypass": "t0ken",
    });
  });

  it("never lets an extra header override the service key", () => {
    // The key is transport auth; a caller-supplied Authorization must not replace it.
    expect(searchApiHeaders({ SCRY_SEARCH_API_KEY: "k" }, { Authorization: "Bearer other" }).Authorization).toBe("Bearer other");
  });
});
