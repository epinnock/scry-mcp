/**
 * Animated snips (feature animated-snips): a snip may be a short silent clip. The dashboard agent API returns
 * `capture.animation` (`{ durationMs, width, height, fps, bytes }`) and `capture.animationUrl` (a signed MP4 link that
 * lasts an hour) only when the caller may see the clip and the dashboard switch is on. `agentUrl` is then a contact
 * sheet of six frames, so the picture the agent gets is the sheet and the clip itself is a link.
 *
 * Off (ANIMATED_SNIPS is not "on"): the caller never calls `parseClip`, so the text and structuredContent are today's.
 * The signed link is printed only when it is a plain https URL on one line (a link with a newline in it could add a
 * line of instructions to the answer). The link and the sizes never reach a log line or an analytics event; only a
 * boolean (`has_animation`) leaves the tool result (see analytics/event.ts).
 */
import { CAPTURE_AGENT_IMAGE, CAPTURE_CLIP, SIGNED_URL_SECONDS } from "./constants";

export interface Clip {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  /** The signed MP4 link: https, one line, no spaces. */
  url: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const inRange = (v: unknown, min: number, max: number): v is number => finite(v) && v >= min && v <= max;

/** An https link with no whitespace or control characters; anything else is never printed. */
function safeHttpsUrl(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length === 0 || v.length > 4096) return undefined;
  if (/\s/.test(v) || /\p{Cc}/u.test(v)) return undefined; // a newline would add a line to the answer
  try {
    return new URL(v).protocol === "https:" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** `animation` as the contract limits it, or null when it is missing or outside them. */
function shapeOf(a: unknown): Omit<Clip, "url"> | null {
  if (!isRecord(a)) return null;
  const { durationMs, width, height, fps } = a;
  if (!inRange(durationMs, CAPTURE_CLIP.minDurationMs, CAPTURE_CLIP.maxDurationMs)) return null;
  if (!inRange(width, 1, CAPTURE_CLIP.maxLongEdgePx) || !inRange(height, 1, CAPTURE_CLIP.maxLongEdgePx)) return null;
  if (!finite(fps) || fps <= 0 || fps > CAPTURE_CLIP.maxFps) return null;
  return { durationMs, width: Math.round(width), height: Math.round(height), fps };
}

/**
 * The clip on a capture, or null when the switch is off, when it is a still, when `animation` is missing or outside the contract's limits,
 * or when `animationUrl` is missing or not a safe https link (the caller lacks access or the dashboard switch is off).
 */
export function parseClip(capture: Record<string, unknown>, enabled: boolean | undefined): Clip | null {
  if (!enabled) return null;
  const url = safeHttpsUrl(capture.animationUrl);
  const shape = shapeOf(capture.animation);
  return url && shape ? { ...shape, url } : null;
}

/** Seconds with one decimal (3000 -> "3.0"). */
export const clipSeconds = (clip: Pick<Clip, "durationMs">): string => (clip.durationMs / 1000).toFixed(1);

/** The picture line of a clip: the contact sheet is attached, or the agent is pointed at the clip link. */
export function clipPictureLine(attached: boolean, note: string | undefined): string {
  if (attached) {
    return `Picture: attached below: ${CAPTURE_CLIP.contactSheetFrames} frames of the clip in a ${CAPTURE_CLIP.contactSheetCols} x ${CAPTURE_CLIP.contactSheetRows} grid, left to right, top to bottom (WebP, long edge at most ${CAPTURE_AGENT_IMAGE.maxLongEdgePx} px).`;
  }
  const why = note ? ` (${note})` : "";
  return `Picture: not attached${why}. Open the clip link to see it.`;
}

/** The two lines that follow the original link, exactly as in the shared contract (`expect_ss_on`); none for a still. */
export function clipLines(clip: Clip | null): string[] {
  if (!clip) return [];
  return [
    `Animated snip: ${clipSeconds(clip)} s clip, ${clip.width} x ${clip.height} px, ${Number(clip.fps.toFixed(1))} fps, no sound. The original picture is the middle frame.`,
    `Clip (MP4, link expires in ${SIGNED_URL_SECONDS / 3600} hour): ${clip.url}`,
  ];
}

/**
 * The `structuredContent` keys: `has_animation` + `animation` (same data as the text, nothing more) while the switch is on,
 * and no key at all while it is off. A still with the switch on is `has_animation: false, animation: null`.
 */
export function clipStructured(enabled: boolean | undefined, clip: Clip | null): Record<string, unknown> {
  if (!enabled) return {};
  if (!clip) return { has_animation: false, animation: null };
  return {
    has_animation: true,
    animation: {
      duration_ms: clip.durationMs,
      width: clip.width,
      height: clip.height,
      fps: clip.fps,
      url: clip.url,
      url_expires_in_seconds: SIGNED_URL_SECONDS,
    },
  };
}

/** A list row's suffix for a clip (` · clip 3.0 s`); a row needs no link, only a valid `animation`. */
export function clipRowSuffix(capture: Record<string, unknown>): string {
  const shape = shapeOf(capture.animation);
  return shape ? ` · clip ${clipSeconds(shape)} s` : "";
}
