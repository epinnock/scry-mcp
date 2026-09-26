// AI usage credits for scry-mcp (feature ai-credits, plan item 8).
//
// generate_image is paid from the caller's org wallet (src/wallet.ts, D1 revised):
//   reserve 40 (fast) / 150 (quality) before Gemini is called
//   → settle on success (the image was generated; storage failures still count)
//   → release on failure ("failed, refunded").
// The ledger lives in scry-diff-service (`/api/credits/*`, service bearer);
// this module only calls it, it never keeps balances of its own.
//
// CREDITS_MODE (this worker's var) decides what the tool does with the answer:
//   off     (default) no credits calls at all.
//   shadow  reserve/settle/release are called so the ledger is written, but
//           nothing is ever refused here: a 402 or an unreachable ledger is
//           logged and the image is generated uncharged.
//   enforce a 402 is a tool error (no Gemini call); an unreachable or
//           misconfigured ledger fails closed (CREDITS_UNAVAILABLE, retryable).
// Whether the LEDGER refuses (402) is its own CREDITS_MODE (diff-service): in
// shadow it holds and marks would_block instead.

import { requestIdHeaders } from "./lib/tool-request";

export type CreditsMode = "off" | "shadow" | "enforce";
export type ImageQuality = "fast" | "quality";

export const IMAGE_CREDIT_TASK: Readonly<Record<ImageQuality, string>> = {
  fast: "mcp.image.fast",
  quality: "mcp.image.quality",
};

/** Mirrors CREDIT_PRICES in scry-diff-service (price version v2-2026-09); used only for copy. */
export const IMAGE_CREDIT_PRICE: Readonly<Record<ImageQuality, number>> = {
  fast: 40,
  quality: 150,
};

export const DEFAULT_CREDITS_PAGE_URL = "https://dashboard.scrymore.com/credits";
const CREDITS_TIMEOUT_MS = 10_000;

type CreditsEnv = {
  CREDITS_MODE?: string;
  CREDITS_API_URL?: string;
  CREDITS_API_TOKEN?: string;
  CREDITS_PAGE_URL?: string;
};

export function creditsMode(env: CreditsEnv): CreditsMode {
  const m = (env.CREDITS_MODE ?? "").trim().toLowerCase();
  return m === "shadow" || m === "enforce" ? m : "off";
}

export function creditsPageUrl(env: CreditsEnv): string {
  const u = (env.CREDITS_PAGE_URL ?? "").trim();
  return /^https:\/\//i.test(u) ? u : DEFAULT_CREDITS_PAGE_URL;
}

/** The balance fields the ledger returns (subset). */
export interface CreditBalance {
  available: number;
  monthly_left?: number;
  bonus_left?: number;
  held?: number;
  resets_at: string;
}

export type ReserveOutcome =
  | { kind: "held"; wouldBlock: boolean; amount: number; balance: CreditBalance }
  | { kind: "skipped" }
  | { kind: "insufficient"; needed: number; available: number; resetsAt: string };

/** The ledger could not be asked: missing config, network error, timeout, non-2xx other than 402. */
export class CreditsUnavailableError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "CreditsUnavailableError";
  }
}

export class CreditsClient {
  constructor(private readonly env: CreditsEnv) {}

  private base(): string {
    const raw = (this.env.CREDITS_API_URL ?? "").trim();
    if (!/^https?:\/\//i.test(raw)) throw new CreditsUnavailableError("CREDITS_API_URL is not set");
    if (!this.env.CREDITS_API_TOKEN) throw new CreditsUnavailableError("CREDITS_API_TOKEN is not set");
    return raw.replace(/\/+$/, "");
  }

  private async post(path: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
    const url = `${this.base()}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CREDITS_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.env.CREDITS_API_TOKEN}`,
          ...requestIdHeaders(),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new CreditsUnavailableError(
        err instanceof Error && err.name === "AbortError" ? `${path} timed out` : `${path} failed: ${String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON body: the status decides.
    }
    return { status: res.status, json };
  }

  async reserve(input: { walletId: string; task: string; refId: string; actorUid: string }): Promise<ReserveOutcome> {
    const { status, json } = await this.post("/api/credits/reserve", {
      wallet_id: input.walletId,
      task: input.task,
      quantity: 1,
      ref_type: "mcp",
      ref_id: input.refId,
      actor_uid: input.actorUid,
    });
    if (status === 402 && json.error === "insufficient_credits") {
      return {
        kind: "insufficient",
        needed: Number(json.needed ?? 0),
        available: Number(json.available ?? 0),
        resetsAt: String(json.resets_at ?? ""),
      };
    }
    if (status !== 200 || json.ok !== true) {
      throw new CreditsUnavailableError(`reserve returned HTTP ${status}${json.error ? `: ${String(json.error)}` : ""}`, status);
    }
    if (json.mode === "off" || json.skipped === true) return { kind: "skipped" };
    const hold = (json.hold ?? {}) as { amount?: number };
    return {
      kind: "held",
      wouldBlock: json.would_block === true,
      amount: Number(hold.amount ?? 0),
      balance: json.balance as CreditBalance,
    };
  }

  /** Settle a hold at its own price. Returns the balance after the debit. */
  async settle(refId: string, reason: string | null): Promise<CreditBalance> {
    const { status, json } = await this.post("/api/credits/settle", { ref_id: refId, ...(reason ? { reason } : {}) });
    if (status !== 200 || json.ok !== true) throw new CreditsUnavailableError(`settle returned HTTP ${status}`, status);
    return json.balance as CreditBalance;
  }

  /** Release a hold in full ("failed, refunded" in the ledger). */
  async release(refId: string, reason = "failed, refunded"): Promise<CreditBalance> {
    const { status, json } = await this.post("/api/credits/release", { ref_id: refId, reason });
    if (status !== 200 || json.ok !== true) throw new CreditsUnavailableError(`release returned HTTP ${status}`, status);
    return json.balance as CreditBalance;
  }
}

// ── Copy ─────────────────────────────────────────────────────────────────────

/** "Oct 1" from the ledger's resets_at (UTC). Empty when unparseable. */
export function formatResetDate(resetsAt: string): string {
  const t = Date.parse(resetsAt);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const n = (v: number) => v.toLocaleString("en-US");

/**
 * Tool error text for a refused image. At zero it is the plan's copy verbatim:
 * "You're out of AI credits (0 left, resets Oct 1). See https://dashboard.scrymore.com/credits"
 */
export function insufficientCreditsMessage(
  r: { needed: number; available: number; resetsAt: string },
  /** What was refused, e.g. "A quality image", "Image search". */
  what: string,
  pageUrl: string,
  /** The paying org's name, when known ("Acme is out of AI credits"). */
  orgName?: string | null,
): string {
  const reset = formatResetDate(r.resetsAt);
  const resets = reset ? `, resets ${reset}` : "";
  if (r.available <= 0) {
    return orgName
      ? `${orgName} is out of AI credits (0 left${resets}). See ${pageUrl}`
      : `You're out of AI credits (0 left${resets}). See ${pageUrl}`;
  }
  const who = orgName ? `${orgName} has` : "you have";
  return `Not enough AI credits: ${what} needs ${n(r.needed)} and ${who} ${n(r.available)} left${resets}. See ${pageUrl}`;
}

export const IMAGE_LABEL: Readonly<Record<ImageQuality, string>> = {
  fast: "A fast image",
  quality: "A quality image",
};

/** One line under a generated image, e.g. "Used 40 AI credits · Acme · 1,960 credits left (resets Oct 1)." */
export function creditsUsedLine(used: number, left: number, resetsAt: string, orgName?: string | null): string {
  const reset = formatResetDate(resetsAt);
  const org = orgName ? `${orgName} · ` : "";
  return `Used ${n(used)} AI credits · ${org}${n(left)} credits left${reset ? ` (resets ${reset})` : ""}.`;
}

// ── Gemini usageMetadata ────────────────────────────────────────────────────

type ModalityCount = { modality?: string; tokenCount?: number };

/** Gemini generateContent usageMetadata (the fields we read). */
export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  promptTokensDetails?: ModalityCount[];
  candidatesTokensDetails?: ModalityCount[];
}

export interface ImageTokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Output tokens in the IMAGE modality (what Google bills images by); null when not itemised. */
  imageOutputTokens: number | null;
  thoughtsTokens: number;
  totalTokens: number;
}

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** Normalise usageMetadata; null when Gemini sent none. */
export function parseGeminiUsage(u: GeminiUsageMetadata | null | undefined): ImageTokenUsage | null {
  if (!u || typeof u !== "object") return null;
  const inputTokens = count(u.promptTokenCount);
  const outputTokens = count(u.candidatesTokenCount);
  const thoughtsTokens = count(u.thoughtsTokenCount);
  const image = Array.isArray(u.candidatesTokensDetails)
    ? u.candidatesTokensDetails.find((d) => String(d?.modality ?? "").toUpperCase() === "IMAGE")
    : undefined;
  return {
    inputTokens,
    outputTokens,
    imageOutputTokens: image ? count(image.tokenCount) : null,
    thoughtsTokens,
    totalTokens: count(u.totalTokenCount) || inputTokens + outputTokens + thoughtsTokens,
  };
}

/** The ledger debit's reason (≤ 200 chars): model + token counts, so each image's usage is on its ledger row. */
export function usageReason(model: string, usage: ImageTokenUsage | null): string {
  if (!usage) return `${model} · tokens not reported`;
  const img = usage.imageOutputTokens !== null ? ` (${usage.imageOutputTokens} image)` : "";
  const thoughts = usage.thoughtsTokens ? ` · ${usage.thoughtsTokens} thinking` : "";
  return `${model} · ${usage.inputTokens} in · ${usage.outputTokens} out${img}${thoughts} · ${usage.totalTokens} total tokens`.slice(0, 200);
}
