/**
 * Helpers for recognising URLs that already carry an AWS SigV4 signature.
 *
 * search_components returns presigned URLs in its structuredContent, and
 * get_component_screenshot's own description tells callers to feed a search
 * result's screenshot_url back in. Signing an already-signed URL fails, so
 * without this an agent following the documented flow got
 * SCREENSHOT_FETCH_FAILED (ISSUES.md #5).
 */

/** True when a URL already carries an AWS SigV4 signature. */
export function isPresignedUrl(url: string): boolean {
  try {
    return new URL(url).searchParams.has("X-Amz-Signature");
  } catch {
    return false;
  }
}

/**
 * Best-effort expiry for an already-presigned URL, from its X-Amz-Date and
 * X-Amz-Expires parameters. Falls back to now when they are absent or
 * unparseable — the caller only uses this for reporting.
 */
export function presignedExpiry(url: string): string {
  try {
    const q = new URL(url).searchParams;
    const date = q.get("X-Amz-Date"); // e.g. 20260806T031838Z
    const expires = Number(q.get("X-Amz-Expires"));
    if (date && Number.isFinite(expires)) {
      const iso = date.replace(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
        "$1-$2-$3T$4:$5:$6Z",
      );
      const start = Date.parse(iso);
      if (!Number.isNaN(start)) return new Date(start + expires * 1000).toISOString();
    }
  } catch {
    /* fall through */
  }
  return new Date().toISOString();
}
