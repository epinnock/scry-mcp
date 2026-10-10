/**
 * Bounded read of the stock service response body (F31). `fetch` resolves when the headers arrive; without
 * this, a service that stalls or streams forever after the headers holds the tool call open and its memory
 * unbounded. The read stops at `maxBytes` and at the caller's abort signal (the same deadline that covers
 * the request), and cancels the stream in both cases.
 */

/** The largest stock answer this server will read. A real answer is a few dozen KB. */
export const STOCK_MAX_BODY_BYTES = 256 * 1024;

export class StockBodyTooLargeError extends Error {
  constructor() {
    super("stock response body over the size cap");
    this.name = "StockBodyTooLargeError";
  }
}

export class StockBodyDeadlineError extends Error {
  constructor() {
    super("stock response body not finished before the deadline");
    this.name = "StockBodyDeadlineError";
  }
}

export async function readBodyCapped(response: Response, signal: AbortSignal, maxBytes = STOCK_MAX_BODY_BYTES): Promise<string> {
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new StockBodyTooLargeError();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new StockBodyDeadlineError());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  deadline.catch(() => undefined); // the race below handles it; avoid an unhandled rejection after a normal finish
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new StockBodyTooLargeError();
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
