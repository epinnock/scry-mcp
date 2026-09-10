import { describe, it, expect } from "vitest";
import { extractProvenance, formatProvenanceLine } from "../src/utils/result-metadata";

/**
 * P13a. A result used to carry no build, no commit and no indexed time
 * (roadmap-open-questions-code-answers.md B.1), so an agent had no way to tell
 * a component from the current build from one indexed six deploys ago — and no
 * way to know that it could not tell.
 */
describe("extractProvenance", () => {
  it("reads the provenance fields the search API sends", () => {
    expect(
      extractProvenance({
        build_id: "b_1234",
        build_sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        story_id: "example-button--primary",
        indexed_at: "2026-09-08T10:00:00.000Z",
        latest_build_id: "b_1234",
        freshness: "fresh",
        freshness_reason: "matches_current_build",
      })
    ).toEqual({
      buildId: "b_1234",
      buildSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      storyId: "example-button--primary",
      indexedAt: "2026-09-08T10:00:00.000Z",
      latestBuildId: "b_1234",
      freshness: "fresh",
      freshnessReason: "matches_current_build",
    });
  });

  // The indexer writes "" where it has nothing, and rows predating the fields
  // read as NULL. Neither may reach an agent as a value.
  it("treats empty strings and absent fields alike as unknown", () => {
    const provenance = extractProvenance({ build_id: "", build_sha: "", freshness: "unknown" });
    expect(provenance.buildId).toBeUndefined();
    expect(provenance.buildSha).toBeUndefined();
    expect(provenance.freshness).toBe("unknown");
  });

  // The verdict belongs to the search API; the MCP cannot see which build a
  // project considers current, so anything it does not recognise is unknown.
  it("never invents a verdict", () => {
    expect(extractProvenance(undefined).freshness).toBe("unknown");
    expect(extractProvenance({}).freshness).toBe("unknown");
    expect(extractProvenance({ freshness: "probably-fine" }).freshness).toBe("unknown");
  });
});

describe("formatProvenanceLine", () => {
  it("renders a current result as build, short SHA, date and verdict", () => {
    expect(
      formatProvenanceLine({
        buildId: "b_1234",
        buildSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        indexedAt: "2026-09-08T10:00:00.000Z",
        latestBuildId: "b_1234",
        freshness: "fresh",
        freshnessReason: "matches_current_build",
      })
    ).toBe("build b_1234 (a1b2c3d) indexed 2026-09-08 · fresh");
  });

  it("names the newer build a stale result was superseded by", () => {
    expect(
      formatProvenanceLine({
        buildId: "b_1234",
        buildSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        indexedAt: "2026-09-08T10:00:00.000Z",
        latestBuildId: "b_1240",
        freshness: "stale",
        freshnessReason: "newer_build_indexed",
      })
    ).toBe("build b_1234 (a1b2c3d) indexed 2026-09-08 · stale: newer build b_1240 exists");
  });

  it("still says stale when it cannot name the newer build", () => {
    expect(
      formatProvenanceLine({ buildId: "b_1234", freshness: "stale", freshnessReason: "newer_build_indexed" })
    ).toBe("build b_1234 · stale: a newer build has been indexed");
  });

  // Silence would read as currency, so a result with nothing to say still says
  // it — an agent that cannot date a result should not treat it as current.
  it("says so out loud when nothing is known", () => {
    expect(formatProvenanceLine({ freshness: "unknown" })).toBe("build unknown · unknown");
  });

  it("spells out the two reasons freshness is unknowable", () => {
    expect(
      formatProvenanceLine({ freshness: "unknown", freshnessReason: "row_has_no_build_id" })
    ).toBe("build unknown · unknown: this result predates build tracking");

    expect(
      formatProvenanceLine({
        buildId: "b_1234",
        freshness: "unknown",
        freshnessReason: "project_has_no_current_build",
      })
    ).toBe("build b_1234 · unknown: this project has no current build");
  });

  // Omitted, never a placeholder: a blank commit reads as a commit.
  it("drops the SHA and the date rather than printing empties", () => {
    expect(
      formatProvenanceLine({ buildId: "b_1234", indexedAt: "2026-09-08T10:00:00.000Z", freshness: "fresh" })
    ).toBe("build b_1234 indexed 2026-09-08 · fresh");

    expect(formatProvenanceLine({ buildId: "b_1234", buildSha: "a1b2c3d", freshness: "fresh" })).toBe(
      "build b_1234 (a1b2c3d) · fresh"
    );
  });

  it("omits an indexed date it cannot parse instead of showing a broken one", () => {
    expect(formatProvenanceLine({ buildId: "b_1234", indexedAt: "last tuesday", freshness: "fresh" })).toBe(
      "build b_1234 · fresh"
    );
  });
});
