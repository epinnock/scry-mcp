import { describe, it, expect } from "vitest";
import { isPresignedUrl, presignedExpiry } from "../src/utils/presigned-url";

// A real search_components structuredContent screenshotUrl, truncated.
const PRESIGNED =
  "https://acct.r2.cloudflarestorage.com/bucket/proj/build/shot.png" +
  "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260806T031838Z" +
  "&X-Amz-Expires=3600&X-Amz-Signature=abc123&X-Amz-SignedHeaders=host";

const RAW = "https://bucket.acct.r2.cloudflarestorage.com/proj/build/shot.png";

describe("isPresignedUrl", () => {
  // ISSUES.md #5: search returns presigned URLs and the tool description tells
  // callers to feed them back into get_component_screenshot. Signing an
  // already-signed URL fails, so this distinction is what keeps the documented
  // flow working.
  it("recognises an already-signed URL", () => {
    expect(isPresignedUrl(PRESIGNED)).toBe(true);
  });

  it("does not flag a raw object URL", () => {
    expect(isPresignedUrl(RAW)).toBe(false);
  });

  it("does not flag a URL carrying unrelated query params", () => {
    expect(isPresignedUrl(`${RAW}?width=200`)).toBe(false);
  });

  it("returns false rather than throwing on a non-URL", () => {
    expect(isPresignedUrl("not a url")).toBe(false);
    expect(isPresignedUrl("")).toBe(false);
  });
});

describe("presignedExpiry", () => {
  it("derives expiry from X-Amz-Date plus X-Amz-Expires", () => {
    // 2026-08-06T03:18:38Z + 3600s
    expect(presignedExpiry(PRESIGNED)).toBe("2026-08-06T04:18:38.000Z");
  });

  it("falls back to a valid timestamp when the params are missing", () => {
    expect(() => new Date(presignedExpiry(RAW)).toISOString()).not.toThrow();
  });

  it("falls back rather than throwing on a malformed date", () => {
    const bad = `${RAW}?X-Amz-Signature=x&X-Amz-Date=nonsense&X-Amz-Expires=3600`;
    expect(() => new Date(presignedExpiry(bad)).toISOString()).not.toThrow();
  });
});
