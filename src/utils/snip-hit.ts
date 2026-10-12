/**
 * Snip hits in search results (feature searchable-snips).
 *
 * The search API (scry-nextjs) decides which snips a caller may see and adds `source: "snip"`,
 * `captureId`, `takenBy` and `takenAt` to those hits. This module only reads those members back
 * out of a row for display and for structuredContent; it adds no access logic and never invents a
 * value. A row without them (every story hit, and any hit while SNIP_SEARCH is off) yields `undefined`.
 */

export interface SnipHit {
  source: "snip";
  captureId: string;
  takenBy?: string;
  takenAt?: string;
}

const MAX_TAKEN_BY = 120;

/** One bounded line of text: control characters (newlines included) become spaces. */
function oneLine(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = oneLine(value, max);
  return text === "" ? undefined : text;
}

/** The snip members of a search row, or undefined when the row is not a snip hit. */
export function extractSnipHit(row: Record<string, unknown> | undefined): SnipHit | undefined {
  if (row?.source !== "snip") return undefined;
  const captureId = optionalText(row.captureId, 200);
  if (!captureId) return undefined;
  return {
    source: "snip",
    captureId,
    takenBy: optionalText(row.takenBy, MAX_TAKEN_BY),
    takenAt: optionalText(row.takenAt, 64),
  };
}

/** The line under a snip hit's name; tells the agent how to open it. */
export function formatSnipLine(snip: SnipHit | undefined): string | undefined {
  if (!snip) return undefined;
  const by = snip.takenBy ? ` by ${snip.takenBy}` : "";
  const at = snip.takenAt ? ` at ${snip.takenAt}` : "";
  return `Snip (screen capture)${by}${at} · captureId ${snip.captureId} · open with get_capture`;
}
