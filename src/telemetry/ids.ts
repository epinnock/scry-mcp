// Trace and span ids (feature llm-telemetry, PR 7). Same derivation as
// scry-diff-service src/telemetry/ids.ts: trace id = the call's UUID without
// dashes; span ids are FNV-1a 64 of (call id, stable key), so a redelivered or
// replayed message re-sends the same ids.

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** 64-bit FNV-1a over the UTF-16 code units of `text`, as 16 lowercase hex digits. */
export function fnv1a64(text: string): string {
  let h = FNV64_OFFSET;
  for (let i = 0; i < text.length; i += 1) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * FNV64_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
}

/** 32 lowercase hex digits from a UUID. Non-UUID ids are hashed into 128 bits. */
export function traceIdFor(runId: string): string {
  const hex = runId.replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(hex) && !/^0+$/.test(hex)) return hex;
  return fnv1a64(`trace|${runId}`) + fnv1a64(`trace2|${runId}`);
}

/** A deterministic, non-zero 16-hex span id for `key` within call `runId`. */
export function spanIdFor(runId: string, key: string): string {
  const id = fnv1a64(`${runId}|${key}`);
  return id === "0000000000000000" ? "0000000000000001" : id;
}
