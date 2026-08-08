/**
 * Notices that tell an agent where a search result actually came from.
 *
 * The search API widens to the rest of the organisation when a project finds
 * nothing, and tags hits from other projects with `crossProject`. None of that
 * reaches an agent unless this layer says it: MCP output is the only thing the
 * model sees, and a bare `Project: <id>` line carries no signal about whether
 * the component is reachable from the repo being edited.
 *
 * The failure this prevents is specific. A component living in another team's
 * app is findable but not necessarily importable, so an agent that treats it as
 * local writes an import that does not resolve — a build error rather than a
 * missing feature, and one whose cause is several steps from the symptom.
 */

export const CROSS_PROJECT_WARNING =
  "   ⚠ From a DIFFERENT project in your organisation. Verify it is published as a shared package before importing it — it may not be reachable from this repo.";

const WIDENED_SUFFIX =
  " — nothing matched in this project, so the search widened to the rest of your organisation. Results marked ⚠ are from other projects.";

/**
 * Append the widening notice to a result summary when the search left the
 * caller's project.
 *
 * Without it an agent cannot distinguish an empty project from one whose
 * results all came from elsewhere, and would report the component as already
 * present locally.
 */
export function withScopeNotice(summary: string, widenedToOrg?: boolean): string {
  return widenedToOrg ? `${summary}${WIDENED_SUFFIX}` : summary;
}
