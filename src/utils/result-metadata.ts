/**
 * Pull the actionable fields out of a search result's `json_content`.
 *
 * The build-processing pipeline writes camelCase keys (`filepath`, `storyTitle`,
 * `testName`, `inspection.description`) while earlier display code only read
 * snake_case keys that the Storybook path never emits. Reading both keeps
 * results usable regardless of which producer wrote the record — most
 * importantly the source path, without which an agent cannot import the
 * component it just found.
 */
export function extractResultMetadata(jc: Record<string, unknown> | undefined) {
  const str = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = jc?.[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    return undefined;
  };

  const inspection = (jc?.inspection ?? {}) as Record<string, unknown>;
  const tags = Array.isArray(inspection.tags)
    ? (inspection.tags as string[])
    : Array.isArray(jc?.tags)
      ? (jc.tags as string[])
      : undefined;

  return {
    description:
      typeof inspection.description === "string" ? inspection.description : undefined,
    // Prefer the component's own file. `filepath` is the .stories file, so
    // leading with it pointed agents one import short of the thing to use
    // (ISSUES.md #6). Older rows have no componentFilePath and fall back.
    sourcePath: str(
      "componentFilePath", "component_file_path",
      "source_path", "sourcePath", "import_path", "importPath",
      "filepath",
    ),
    /** The .stories file the screenshot came from, when distinct. */
    storyPath: str("filepath", "story_path", "storyPath"),
    storyTitle: str("storyTitle", "story_title"),
    variant: str("testName", "test_name", "storyName", "story_name"),
    figmaUrl: str("figma_url", "figmaUrl"),
    githubUrl: str("github_url", "githubUrl"),
    storybookUrl: str("storybook_url", "storybookUrl"),
    screenshotUrl: str("screenshotR2Url", "screenshot_r2_url", "screenshot_url"),
    tags: tags?.length ? tags : undefined,
  };
}

/**
 * How current a result is, as decided by the search API.
 *
 * The verdict is never recomputed here — the MCP has no view of which build a
 * project considers current — so an unrecognised or absent value renders as
 * `unknown` rather than as a guess.
 */
export type Freshness = "fresh" | "stale" | "unknown";

export interface ResultProvenance {
  /** The build this row was indexed from. */
  buildId?: string;
  /** The commit that build was produced from. */
  buildSha?: string;
  /** ISO-8601 instant the row was indexed. */
  indexedAt?: string;
  /** The build the row's project currently considers current. */
  latestBuildId?: string;
  /** Storybook story id, when the build recorded one. */
  storyId?: string;
  freshness: Freshness;
  /** The search API's machine-readable reason for the verdict. */
  freshnessReason?: string;
}

/**
 * The provenance fields of a search result, from the top level of the row.
 *
 * These are top-level scalars on the indexed row rather than members of
 * `json_content`, so they are read from the result itself, not through
 * `extractResultMetadata`.
 *
 * Absent, null and the empty string all become undefined. The indexer writes
 * "" where it has nothing to write, and rows written before these fields
 * existed read as NULL; neither may reach an agent as a value.
 */
export function extractProvenance(result: Record<string, unknown> | undefined): ResultProvenance {
  const str = (key: string): string | undefined => {
    const value = result?.[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };

  const freshness = result?.freshness;

  return {
    buildId: str("build_id"),
    buildSha: str("build_sha"),
    indexedAt: str("indexed_at"),
    latestBuildId: str("latest_build_id"),
    storyId: str("story_id"),
    freshness:
      freshness === "fresh" || freshness === "stale" ? freshness : "unknown",
    freshnessReason: str("freshness_reason"),
  };
}

/** The date part of an ISO-8601 instant, or undefined if it is not one. */
function isoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString().slice(0, 10);
}

/**
 * One line saying which build a result came from and whether it is current.
 *
 * Reads as `build b_1234 (a1b2c3d) indexed 2026-09-08 · fresh`, and drops any
 * clause it has no value for rather than printing a placeholder — a blank
 * commit or an invented date is worse than a shorter line. A row with no
 * provenance at all still gets a line, because "unknown" is information: it
 * tells an agent not to trust the result as current.
 */
export function formatProvenanceLine(provenance: ResultProvenance): string {
  const build = provenance.buildId
    ? provenance.buildSha
      ? `build ${provenance.buildId} (${provenance.buildSha.slice(0, 7)})`
      : `build ${provenance.buildId}`
    : "build unknown";

  const indexed = isoDate(provenance.indexedAt);

  return [build, indexed ? `indexed ${indexed}` : undefined]
    .filter(Boolean)
    .join(" ") + ` · ${freshnessClause(provenance)}`;
}

/**
 * The verdict, with the reason spelled out for the two cases where an agent
 * would otherwise have to guess why.
 */
function freshnessClause(provenance: ResultProvenance): string {
  if (provenance.freshness === "fresh") return "fresh";

  if (provenance.freshness === "stale") {
    return provenance.latestBuildId
      ? `stale: newer build ${provenance.latestBuildId} exists`
      : "stale: a newer build has been indexed";
  }

  switch (provenance.freshnessReason) {
    case "row_has_no_build_id":
      return "unknown: this result predates build tracking";
    case "project_has_no_current_build":
      return "unknown: this project has no current build";
    default:
      return "unknown";
  }
}
