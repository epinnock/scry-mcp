/**
 * How many indexed copies ("versions") of one screen a search row stands for.
 *
 * The search API (feature search-dedup) returns one row per screen by default:
 * the newest indexed copy. It says how many copies that row stands for in
 * `version_count` and how many rows it folded away in `duplicates_collapsed`.
 * Both are computed by the API from rows the caller may read; nothing here
 * recomputes or guesses them. An API that predates the feature sends neither,
 * and then nothing about versions is rendered at all (an absent count is not
 * "1").
 */

export type VersionsMode = "latest" | "all";

/** The `versions` value sent when the caller gives none. */
export const DEFAULT_VERSIONS: VersionsMode = "latest";

/** A positive whole number from the API, or undefined (absent, null, 0, fractional, text). */
export function extractVersionCount(row: Record<string, unknown> | undefined): number | undefined {
  const value = row?.version_count;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** A non-negative whole number from the API, or undefined when absent or malformed. */
export function extractDuplicatesCollapsed(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The line under a result saying how many copies of this screen exist.
 *
 * `Versions: 4 indexed (showing newest, build a1b2c3d)` when the row is the
 * newest of several, `Versions: 1 indexed` for a screen with a single copy, and
 * `Versions: 4 in these results` under `versions: "all"`, where every copy is
 * listed and the row is not necessarily the newest. Returns undefined when the
 * API sent no count.
 */
export function formatVersionLine(
  versionCount: number | undefined,
  mode: VersionsMode,
  build: string | undefined,
): string | undefined {
  if (versionCount === undefined) return undefined;
  if (mode === "all") return `Versions: ${versionCount} in these results`;
  if (versionCount === 1) return "Versions: 1 indexed";
  const buildClause = build ? `, build ${build}` : "";
  return `Versions: ${versionCount} indexed (showing newest${buildClause})`;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The sentence appended to the summary when dedup folded rows away:
 * `9 screens, 11 older versions hidden (pass versions: "all" to see them)`.
 *
 * `screens` is the number of rows on this page, which is also the number of
 * previews the widget renders. Undefined when nothing was folded or the API did
 * not say, so a response with no duplicates reads exactly as it did before.
 */
export function formatCollapsedSentence(
  screens: number,
  duplicatesCollapsed: number | undefined,
): string | undefined {
  if (!duplicatesCollapsed || duplicatesCollapsed < 1) return undefined;
  return (
    `${plural(screens, "screen", "screens")}, ` +
    `${plural(duplicatesCollapsed, "older version", "older versions")} hidden ` +
    `(pass versions: "all" to see them)`
  );
}
