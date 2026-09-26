/**
 * `x-scry-request-id` (feature observability-request-id; contract in
 * scry-management/features/observability-request-id/briefs/_request-id-contract.md).
 *
 * A request id is a ULID: 26 Crockford base32 characters, the first 10 of which
 * encode the millisecond it was minted, the last 16 carrying 80 random bits.
 * Inbound ids are accepted when they are a ULID or a lowercase UUID v4; anything
 * else is replaced with a fresh ULID and never logged or echoed.
 *
 * Dependency-free on purpose: the same ~40 lines live in every Scry service.
 */

export const REQUEST_ID_HEADER = "x-scry-request-id";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A fresh ULID. `now` is injectable for tests. */
export function mintRequestId(now: number = Date.now()): string {
  let t = Math.max(0, Math.floor(now));
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  // 16 random chars × 5 bits = 80 bits; 256 is a multiple of 32, so `& 31` is unbiased.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] & 31];
  return time + rand;
}

/** True for a ULID or a lowercase UUID v4 — the only shapes a service accepts inbound. */
export function isValidRequestId(value: unknown): value is string {
  return typeof value === "string" && (ULID_RE.test(value) || UUID_V4_RE.test(value));
}

/** The inbound id when it is well formed, otherwise a fresh ULID. The rejected value is dropped. */
export function acceptOrMint(value: unknown): string {
  return isValidRequestId(value) ? value : mintRequestId();
}
