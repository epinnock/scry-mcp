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
