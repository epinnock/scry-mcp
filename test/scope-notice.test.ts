import { describe, it, expect } from "vitest";
import { CROSS_PROJECT_WARNING, withScopeNotice } from "../src/utils/scope-notice";

/**
 * MCP output is the only thing an agent sees. The search API tags cross-project
 * hits and reports when it widened, but that signal is worthless if this layer
 * drops it — the agent then treats a component from another team's repo as
 * local and writes an import that cannot resolve.
 */
describe("withScopeNotice", () => {
  const base = "Found 3 results (page 1/1)";

  it("leaves the summary alone when the search stayed in the project", () => {
    expect(withScopeNotice(base, false)).toBe(base);
  });

  // Absent means the API did not report widening — treat that as "did not".
  it("leaves the summary alone when widening is unreported", () => {
    expect(withScopeNotice(base, undefined)).toBe(base);
  });

  it("says so when the search widened to the organisation", () => {
    const result = withScopeNotice(base, true);

    expect(result.startsWith(base)).toBe(true);
    expect(result).toMatch(/nothing matched in this project/i);
    expect(result).toMatch(/widened/i);
  });

  // The notice has to name the marker used on the individual results, or the
  // agent is told results are mixed without being told which are which.
  it("points at the marker used on individual results", () => {
    expect(withScopeNotice(base, true)).toContain("⚠");
    expect(CROSS_PROJECT_WARNING).toContain("⚠");
  });
});

describe("CROSS_PROJECT_WARNING", () => {
  it("states the component may not be importable, not merely that it is remote", () => {
    // "From another project" alone reads as provenance trivia. The actionable
    // part is that importing it may fail.
    expect(CROSS_PROJECT_WARNING).toMatch(/DIFFERENT project/);
    expect(CROSS_PROJECT_WARNING).toMatch(/may not be reachable|shared package/i);
  });

  it("is indented to sit under its result", () => {
    // Result detail lines are indented three spaces; an unindented warning
    // would read as a separate top-level result.
    expect(CROSS_PROJECT_WARNING.startsWith("   ")).toBe(true);
  });
});
