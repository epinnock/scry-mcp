/**
 * Snip hits in search results (feature searchable-snips).
 *
 * The search API (scry-nextjs) decides which snips a caller may see and adds `source: "snip"`,
 * `captureId`, `takenBy` and `takenAt` to those hits. This module only reads those members back
 * out of a row for display and for structuredContent; it adds no access logic and never invents a
 * value. A row without them (every story hit, and any hit while SNIP_SEARCH is off) yields `undefined`.
 */

import { VISUAL_UNTRUSTED_NOTE, visualQuoted, visualSafeText } from "./result-metadata.js";

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
    // The name is a person's display name: bounded, one line, markdown-escaped like any other author text.
    takenBy: visualSafeText(row.takenBy, MAX_TAKEN_BY),
    takenAt: visualSafeText(row.takenAt, 64),
  };
}

/** The line under a snip hit's name; tells the agent how to open it. */
export function formatSnipLine(snip: SnipHit | undefined): string | undefined {
  if (!snip) return undefined;
  const by = snip.takenBy ? ` by "${snip.takenBy.replace(/"/g, '\\"')}"` : "";
  const at = snip.takenAt ? ` at ${snip.takenAt}` : "";
  return `Snip (screen capture)${by}${at} · captureId ${snip.captureId} · open with get_capture`;
}

/**
 * The line a snip hit shows where a story hit shows its build provenance: a snip has no build, so
 * "build unknown ... no current build" would be wrong. Built only from fields already on the hit.
 */
export function formatSnipProvenanceLine(snip: SnipHit): string {
  const by = snip.takenBy ? ` by "${snip.takenBy.replace(/"/g, '\\"')}"` : "";
  const date = snip.takenAt?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  const on = date ? `, ${date}` : "";
  return `Snip${by}${on} · open with get_capture ${snip.captureId}`;
}

const SNIP_TEXT_MAX = 400;

/**
 * A snip's name, searchable text and description are text a vision model wrote about another person's
 * screenshot (or text the screenshot itself showed), so they are data, never instructions. The same
 * bounded, one-line, escaped treatment as a visual row; `structuredContent` carries the escaped values.
 */
export function snipStructuredText(row: { id: string; component_name?: string; searchable_text?: string }, description?: string) {
  return {
    name: visualSafeText(row.component_name) ?? visualSafeText(row.id) ?? "Screen capture",
    searchableText: visualSafeText(row.searchable_text, SNIP_TEXT_MAX),
    description: visualSafeText(description, SNIP_TEXT_MAX),
  };
}

/** The text lines of a snip hit: quoted name, the open-with line, the untrusted-data note and a quoted description. */
export function formatSnipIdentityLines(
  index: number,
  row: { id: string; score?: number; component_name?: string; searchable_text?: string },
  snip: SnipHit,
  description?: string,
): string[] {
  const name = visualQuoted(row.component_name) ?? visualQuoted(row.id) ?? '"Screen capture"';
  const lines = [
    `${index + 1}. ${name} (score: ${row.score?.toFixed(3)})`,
    `   ${formatSnipLine(snip)}`,
    `   ${VISUAL_UNTRUSTED_NOTE}`,
  ];
  const text = visualQuoted(description, SNIP_TEXT_MAX) ?? visualQuoted(row.searchable_text, SNIP_TEXT_MAX);
  if (text) lines.push(`   Description: ${text}`);
  return lines;
}
