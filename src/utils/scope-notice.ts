/**
 * Notices that tell an agent where a search result actually came from.
 *
 * Scope is explicit (ISSUES.md #45): `project` returns only the named
 * project's rows and never widens; `org` also returns rows from sibling
 * projects that opted in to discovery and that the caller can read, tagged
 * `crossProject`. None of that reaches an agent unless this layer says it:
 * MCP output is the only thing the model sees, and a bare `Project: <id>` line
 * carries no signal about whether the component is reachable from the repo
 * being edited.
 *
 * The failure this prevents is specific. A component living in another team's
 * app is findable but not necessarily importable, so an agent that treats it as
 * local writes an import that does not resolve — a build error rather than a
 * missing feature, and one whose cause is several steps from the symptom.
 */

export const CROSS_PROJECT_WARNING =
  "   ⚠ From a DIFFERENT project in your organisation. Verify it is published as a shared package before importing it — it may not be reachable from this repo.";

export interface ScopeOutcome {
  /** The scope the search API answered with. Absent when no project_id was sent. */
  scope?: string;
  /** True only when scope was "org" and rows from other projects are present. */
  widenedToOrg?: boolean;
  /** How many of the returned rows are from other projects. */
  crossProjectCount?: number;
  /** How many rows were returned on this page. */
  resultCount?: number;
  /** Counts of sibling projects left out of an org search, and why. */
  excluded?: { not_discoverable?: number; unauthorised?: number };
}

/**
 * Append a scope notice to a result summary.
 *
 * Without it an agent cannot distinguish "this project has none" from "these
 * all came from elsewhere", and would report a component as already present
 * locally — or, under org scope, would not know that an empty result means
 * no sibling has opted in rather than that no sibling has the component.
 */
export function withScopeNotice(summary: string, outcome: ScopeOutcome = {}): string {
  const { scope, widenedToOrg, crossProjectCount = 0, resultCount = 0, excluded } = outcome;

  if (scope === "project") {
    return `${summary} — Scope: this project only.`;
  }

  if (scope === "org") {
    if (widenedToOrg) {
      return (
        `${summary} — Scope: organisation — ${crossProjectCount} of ${resultCount} results are from other ` +
        `projects that opted in to discovery. Results marked ⚠ are from other projects.`
      );
    }
    const notDiscoverable = excluded?.not_discoverable ?? 0;
    const unauthorised = excluded?.unauthorised ?? 0;
    const reasons: string[] = [];
    if (notDiscoverable > 0) {
      reasons.push(`${notDiscoverable} project${notDiscoverable === 1 ? "" : "s"} in your organisation ha${notDiscoverable === 1 ? "s" : "ve"} not opted in to discovery`);
    }
    if (unauthorised > 0) {
      reasons.push(`${unauthorised} opted-in project${unauthorised === 1 ? "" : "s"} you cannot access`);
    }
    const why = reasons.length ? ` (${reasons.join("; ")})` : "";
    return `${summary} — Scope: organisation — no results from other projects${why}.`;
  }

  // No project_id was sent: the API searched everything the account can read.
  return `${summary} — Scope: every project readable by this account (no project_id given).`;
}
