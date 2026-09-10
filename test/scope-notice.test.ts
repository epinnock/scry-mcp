import { describe, it, expect } from "vitest";
import { CROSS_PROJECT_WARNING, withScopeNotice } from "../src/utils/scope-notice";

/**
 * MCP output is the only thing an agent sees. The search API now answers with
 * the scope it was asked for and tags cross-project hits, but that signal is
 * worthless if this layer drops it — the agent then treats a component from
 * another team's repo as local and writes an import that cannot resolve, or
 * reads an empty org result as "nobody has this" when nobody has opted in.
 */
describe("withScopeNotice", () => {
  const base = "Found 3 results (page 1/1)";

  it("says the search was confined to the project under project scope", () => {
    const result = withScopeNotice(base, { scope: "project", widenedToOrg: false });

    expect(result.startsWith(base)).toBe(true);
    expect(result).toMatch(/this project only/i);
    expect(result).not.toMatch(/widened/i);
  });

  // The old default silently widened on an empty result. Scope is explicit
  // now, so project scope must never claim a widening whatever flags arrive.
  it("never reports a widening under project scope", () => {
    const result = withScopeNotice(base, { scope: "project", widenedToOrg: true, crossProjectCount: 2 });
    expect(result).toMatch(/this project only/i);
    expect(result).not.toMatch(/other projects/i);
  });

  it("counts cross-project rows when an org search returned them", () => {
    const result = withScopeNotice(base, {
      scope: "org",
      widenedToOrg: true,
      crossProjectCount: 2,
      resultCount: 3,
    });

    expect(result.startsWith(base)).toBe(true);
    expect(result).toMatch(/organisation/i);
    expect(result).toContain("2 of 3");
    expect(result).toMatch(/opted in/i);
  });

  // The notice has to name the marker used on the individual results, or the
  // agent is told results are mixed without being told which are which.
  it("points at the marker used on individual results when rows are mixed", () => {
    const result = withScopeNotice(base, { scope: "org", widenedToOrg: true, crossProjectCount: 1, resultCount: 3 });
    expect(result).toContain("⚠");
    expect(CROSS_PROJECT_WARNING).toContain("⚠");
  });

  it("explains an org search that returned no sibling rows, using counts only", () => {
    const result = withScopeNotice(base, {
      scope: "org",
      widenedToOrg: false,
      crossProjectCount: 0,
      resultCount: 3,
      excluded: { not_discoverable: 2, unauthorised: 1 },
    });

    expect(result).toMatch(/no results from other projects/i);
    expect(result).toContain("2 projects");
    expect(result).toMatch(/not opted in/i);
    expect(result).toContain("1 opted-in project you cannot access");
  });

  it("stays terse when an org search excluded nothing", () => {
    const result = withScopeNotice(base, { scope: "org", widenedToOrg: false, resultCount: 3 });
    expect(result).toMatch(/no results from other projects\.$/i);
  });

  // No project_id means the API searched everything the account can read.
  // That is a broader scope than either named one and the agent must know.
  it("names the account-wide scope when the API reported none", () => {
    const result = withScopeNotice(base, {});
    expect(result).toMatch(/every project readable/i);
    expect(withScopeNotice(base)).toBe(result);
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
