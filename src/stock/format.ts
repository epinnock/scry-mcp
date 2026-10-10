/**
 * Pure helpers for the search_stock tool (feature stock-metasearch): the request the tool sends, the
 * mapping from the stock service's answer to what the agent sees, and the fixed error messages.
 *
 * Contract: scryorg/scry-stock-service `test/fixtures/contract/search-response.json` (copied to
 * test/fixtures/stock-search-response.json; the tests are built from it).
 *
 * Privacy and secrets (G1, G7): nothing here logs, and no message ever carries upstream response text, a
 * header, a token or the user's query. Error text is fixed per status.
 */

export const STOCK_PROVIDERS = ["pixabay", "unsplash", "openverse", "pexels"] as const;
export const STOCK_TYPES = ["photo", "illustration", "vector"] as const;
export const STOCK_MAX_QUERY_LENGTH = 200;
export const STOCK_DEFAULT_LIMIT = 12;
export const STOCK_MAX_LIMIT = 30;
/** Overall time the MCP server waits for the stock service (the service itself gives each provider 2.5 s). */
export const STOCK_TIMEOUT_MS = 3000;

export interface StockItem {
  provider: string;
  providerItemId?: string;
  title: string;
  tags: string[];
  creator?: string;
  creatorUrl?: string;
  creditLine: string;
  pageUrl: string;
  previewUrl: string;
  previewWidth?: number;
  previewHeight?: number;
  type: string;
  licenseLabel?: string;
  isAiGenerated?: boolean;
}

export type ProviderStatus = { status: string; count: number; ms: number };

export interface StockResult {
  items: StockItem[];
  providers: Record<string, ProviderStatus>;
}

export type StockFailure = { code: string; message: string; retryable: boolean; detail?: Record<string, unknown> };

const MAX_TEXT = 200;
const MAX_TAGS = 8;

/** Third-party text goes to an agent: one line, no control characters, bounded. */
function clean(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== "string") return "";
  const oneLine = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2000) return undefined;
  try {
    const u = new URL(value);
    return u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function dimension(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

/**
 * One item from the service, reduced to the fields an agent needs. An item without a creator credit line or
 * without an https page link is dropped (G3: every stock result shows who made it and links to the provider),
 * as is one without an https preview.
 */
export function normaliseItem(raw: unknown): StockItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const provider = clean(r.provider, 32);
  const creditLine = clean(r.creditLine);
  const pageUrl = httpsUrl(r.pageUrl);
  const previewUrl = httpsUrl(r.previewUrl);
  if (!provider || !creditLine || !pageUrl || !previewUrl) return null;
  const item: StockItem = {
    provider,
    title: clean(r.title),
    tags: Array.isArray(r.tags) ? r.tags.map(t => clean(t, 40)).filter(Boolean).slice(0, MAX_TAGS) : [],
    creditLine,
    pageUrl,
    previewUrl,
    type: clean(r.type, 32) || "photo",
  };
  const id = clean(r.providerItemId, 80);
  if (id) item.providerItemId = id;
  const creator = clean(r.creator, 80);
  if (creator) item.creator = creator;
  const creatorUrl = httpsUrl(r.creatorUrl);
  if (creatorUrl) item.creatorUrl = creatorUrl;
  const w = dimension(r.previewWidth);
  const h = dimension(r.previewHeight);
  if (w) item.previewWidth = w;
  if (h) item.previewHeight = h;
  const licence = clean(r.licenseLabel, 80);
  if (licence) item.licenseLabel = licence;
  if (r.isAiGenerated === true) item.isAiGenerated = true;
  return item;
}

/** The service's answer, normalised; null when it is not the contract shape at all. */
export function normaliseResponse(body: unknown): StockResult | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.items) || !b.providers || typeof b.providers !== "object") return null;
  const items = b.items.map(normaliseItem).filter((i): i is StockItem => i !== null);
  const providers: Record<string, ProviderStatus> = {};
  for (const [name, v] of Object.entries(b.providers as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const s = v as Record<string, unknown>;
    const status = clean(s.status, 16);
    if (!status) continue;
    providers[clean(name, 32)] = {
      status,
      count: typeof s.count === "number" && Number.isFinite(s.count) ? Math.max(0, Math.round(s.count)) : 0,
      ms: typeof s.ms === "number" && Number.isFinite(s.ms) ? Math.max(0, Math.round(s.ms)) : 0,
    };
  }
  return { items, providers };
}

/** True when no provider answered (every one errored, timed out, ran out of budget or is disabled). */
export function noProviderAnswered(result: StockResult): boolean {
  return !Object.values(result.providers).some(p => p.status === "ok");
}

const PROVIDER_NOTE =
  "Credits must be shown with every picture (use creditLine) and each picture opens on the provider's site (pageUrl). " +
  "Previews load from the provider; do not download, store or re-upload these pictures.";

export function formatStock(result: StockResult): { text: string; structured: Record<string, unknown> } {
  const statuses = Object.entries(result.providers)
    .map(([name, p]) => (p.status === "ok" ? `${name} ok (${p.count})` : `${name} ${p.status}`))
    .join(", ");
  const lines: string[] = [];
  if (result.items.length === 0) {
    lines.push(`No matching stock pictures. Providers: ${statuses || "none reported"}.`);
  } else {
    lines.push(`${result.items.length} stock picture${result.items.length === 1 ? "" : "s"}. Providers: ${statuses}.`, PROVIDER_NOTE, "");
    result.items.forEach((item, i) => {
      const what = item.title || item.tags.slice(0, 4).join(", ") || "untitled";
      const licence = item.licenseLabel ? ` | licence: ${item.licenseLabel}` : "";
      const ai = item.isAiGenerated ? " | AI-generated" : "";
      lines.push(
        `${i + 1}. [${item.provider} ${item.type}] ${what}`,
        `   credit: ${item.creditLine}${licence}${ai}`,
        `   page: ${item.pageUrl}`,
        `   preview: ${item.previewUrl}`,
      );
    });
  }
  return { text: lines.join("\n"), structured: { items: result.items, providers: result.providers } };
}

/** Fixed per-status errors. The body of the response is never read into the message (G1). */
export function mapStockError(status: number, retryAfter?: string | null): StockFailure {
  if (status === 401 || status === 403) {
    return { code: "SERVER_MISCONFIGURED", message: "The stock service did not accept this MCP server's credentials. Ask the Scry operator to check the stock service token and the caller assertion secret.", retryable: false };
  }
  if (status === 429) {
    const seconds = Number.parseInt(retryAfter ?? "", 10);
    const wait = Number.isFinite(seconds) && seconds > 0 && seconds <= 3600 ? seconds : undefined;
    return {
      code: "RATE_LIMITED",
      message: `Too many stock searches. Wait ${wait ?? "a few"} seconds and try again.`,
      retryable: true,
      detail: wait ? { retry_after_seconds: wait } : undefined,
    };
  }
  if (status === 400 || status === 422) {
    return { code: "VALIDATION_ERROR", message: "The stock service rejected the search arguments (query 1-200 characters, type photo|illustration|vector, a known provider, limit 1-30).", retryable: false };
  }
  return { code: "STOCK_SERVICE_ERROR", message: `The stock service answered ${status >= 500 ? "with an error" : "unexpectedly"}. Scry's own search is unaffected. Retry once.`, retryable: true };
}

export const STOCK_TIMEOUT_FAILURE: StockFailure = {
  code: "STOCK_TIMEOUT",
  message: "The stock service did not answer in time. Scry's own search is unaffected. Retry once.",
  retryable: true,
};

export const STOCK_UNREACHABLE_FAILURE: StockFailure = {
  code: "STOCK_UNREACHABLE",
  message: "Could not reach the stock service. Scry's own search is unaffected. Retry once.",
  retryable: true,
};

export const STOCK_BAD_RESPONSE_FAILURE: StockFailure = {
  code: "STOCK_SERVICE_ERROR",
  message: "The stock service sent an answer this server could not read. Scry's own search is unaffected. Retry once.",
  retryable: true,
};

export const STOCK_NO_PROVIDER_FAILURE: StockFailure = {
  code: "STOCK_PROVIDERS_UNAVAILABLE",
  message: "No stock provider answered (each timed out, hit its budget or is switched off). Scry's own search is unaffected. Retry later.",
  retryable: true,
};

export const STOCK_MISCONFIGURED_FAILURE: StockFailure = {
  code: "SERVER_MISCONFIGURED",
  message: "The Scry MCP server is not configured for stock search (STOCK_SERVICE_URL, STOCK_SERVICE_TOKEN or SCRY_CALLER_ASSERTION_SECRET missing). Ask the operator.",
  retryable: false,
};
