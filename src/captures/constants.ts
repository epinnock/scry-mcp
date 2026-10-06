/**
 * Snip capture tools: the one place the image budget lives (feature snip-capture, PR 5).
 *
 * The Sync app renders the agent picture (a lossy WebP, long edge 1280 px) before upload and the
 * server only verifies it, so the MCP never resizes anything: it inlines the stored rendition when it
 * fits `inlineMaxBytes` and otherwise returns the link alone. Claude Code counts an MCP image's
 * base64 text against its tool-output cap (default 25,000 tokens, about 100k base64 characters or
 * 75 KB of image), so the budget is the safe side of that cap.
 *
 * Spike F1 (real client caps and WebP legibility) decides the final numbers: change them here only.
 */
export const CAPTURE_AGENT_IMAGE = {
  /** Long edge the app renders the agent picture to; named in the tool text, never enforced here. */
  maxLongEdgePx: 1280,
  /** Target size the app sizes the WebP to (about 70 KB). */
  targetBytes: 70 * 1024,
  /** Largest rendition this server inlines; anything bigger is link-only. */
  inlineMaxBytes: 75 * 1024,
  /** Give up fetching the rendition after this long; a missing picture is never an error. */
  fetchTimeoutMs: 10_000,
} as const;

/** `latest_capture` refuses a capture older than this unless the caller passes maxAgeMinutes. */
export const LATEST_DEFAULT_MAX_AGE_MINUTES = 15;
/** The dashboard caps the window at one day. */
export const LATEST_MAX_AGE_MINUTES = 24 * 60;
/** Signed original and rendition links last one hour (dashboard SIGNED_URL_SECONDS). */
export const SIGNED_URL_SECONDS = 3600;
/** list_captures page size (dashboard max 50, default 24). */
export const LIST_DEFAULT_LIMIT = 10;
export const LIST_MAX_LIMIT = 50;
/** delete_capture is a write: this many per minute per user, on top of the 60 req/min limit. */
export const CAPTURE_WRITE_RATE_LIMIT_RPM = 10;
