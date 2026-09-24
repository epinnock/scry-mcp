// Cloudflare AI Gateway routing for every paid model call in scry-mcp (feature
// llm-telemetry, PR 7; plan.md "Design per component → 1. AI Gateway"). Same
// shapes as scry-diff-service src/services/llm-gateway.ts (PR #31).
//
// - Kill switch: `LLM_GATEWAY_URL` unset → the call goes straight to the provider
//   and no cf-aig-* header is added.
// - Set → the provider base URL becomes `<LLM_GATEWAY_URL>/<provider>`, where
//   LLM_GATEWAY_URL is the gateway root, e.g.
//   https://gateway.ai.cloudflare.com/v1/<account_id>/scry-stage
//   and every request carries:
//     cf-aig-authorization        Bearer <CF_AIG_TOKEN> (authenticated gateway)
//     cf-aig-metadata             {"svc","feat","proj","user","run"} — ≤ 5 keys, values ≤ 128 chars
//     cf-aig-skip-cache           true  (image generation is not deterministic)
//     cf-aig-collect-log-payload  false (the log row keeps tokens/cost/metadata, never the
//                                        prompt, the reference images or the generated image)
// - Provider keys stay in the provider's own auth header (for Gemini, x-goog-api-key —
//   never the URL, so a key cannot land in any log row). BYOK is not used.

export type GatewayProvider = "google-ai-studio";

/** Direct base URLs (what each call used before the gateway). */
export const DIRECT_BASE_URL: Readonly<Record<GatewayProvider, string>> = {
  "google-ai-studio": "https://generativelanguage.googleapis.com",
};

/** Path under the gateway root that replaces DIRECT_BASE_URL; the caller's path suffix is identical on both. */
const GATEWAY_PATH: Readonly<Record<GatewayProvider, string>> = {
  "google-ai-studio": "google-ai-studio",
};

/** The gateway keeps the first 5 metadata entries and drops the rest. */
export const METADATA_MAX_KEYS = 5;
/** Maximum value lengths are not documented; we cap every value ourselves. */
export const METADATA_MAX_VALUE = 128;

type GatewayEnv = { LLM_GATEWAY_URL?: string; CF_AIG_TOKEN?: string };

export class LlmGatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmGatewayConfigError";
  }
}

/** The gateway root when the flag is on, otherwise null (direct). */
export function gatewayRoot(env: GatewayEnv): string | null {
  const raw = (env.LLM_GATEWAY_URL ?? "").trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) throw new LlmGatewayConfigError("LLM_GATEWAY_URL must be an http(s) URL");
  return raw.replace(/\/+$/, "");
}

/** Base URL for `provider`: `<root>/<provider path>` with the gateway on, the provider's own URL with it off. */
export function llmBaseUrl(env: GatewayEnv, provider: GatewayProvider): string {
  const root = gatewayRoot(env);
  return root ? `${root}/${GATEWAY_PATH[provider]}` : DIRECT_BASE_URL[provider];
}

/** Tags for one call. `feat` is the feature; model and provider come from the request. */
export interface GatewayTags {
  svc: string;
  feat: string;
  proj?: string | null;
  user?: string | null;
  run?: string | null;
}

type MetaValue = string | number | boolean;

/** Escape non-ASCII so the JSON is a valid header ByteString. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * The `cf-aig-metadata` value: a flat JSON object of at most 5 entries in
 * insertion order. null/undefined/empty values are dropped, `cf.`-prefixed keys
 * (reserved) are refused, strings are truncated to 128 characters.
 */
export function gatewayMetadata(entries: Record<string, MetaValue | null | undefined>): string {
  const out: Record<string, MetaValue> = {};
  let n = 0;
  for (const [key, value] of Object.entries(entries)) {
    if (n >= METADATA_MAX_KEYS) break;
    if (key.startsWith("cf.")) continue;
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    out[key] = typeof value === "string" ? value.slice(0, METADATA_MAX_VALUE) : value;
    n += 1;
  }
  return asciiJson(out);
}

/**
 * Headers to add to one provider request. Gateway off → `{}`. Gateway on
 * without CF_AIG_TOKEN → LlmGatewayConfigError: the gateway is authenticated,
 * so the call would only 401.
 */
export function gatewayHeaders(env: GatewayEnv, tags: GatewayTags): Record<string, string> {
  if (!gatewayRoot(env)) return {};
  const token = (env.CF_AIG_TOKEN ?? "").trim();
  if (!token) throw new LlmGatewayConfigError("LLM_GATEWAY_URL is set but CF_AIG_TOKEN is not configured");
  return {
    "cf-aig-authorization": `Bearer ${token}`,
    "cf-aig-metadata": gatewayMetadata({
      svc: tags.svc,
      feat: tags.feat,
      proj: tags.proj,
      user: tags.user,
      run: tags.run,
    }),
    "cf-aig-skip-cache": "true",
    "cf-aig-collect-log-payload": "false",
  };
}

/** Base URL + extra headers for one call (the one-stop form used by call sites). */
export function llmRoute(
  env: GatewayEnv,
  provider: GatewayProvider,
  tags: GatewayTags,
): { baseUrl: string; headers: Record<string, string>; viaGateway: boolean } {
  const headers = gatewayHeaders(env, tags);
  return { baseUrl: llmBaseUrl(env, provider), headers, viaGateway: Object.keys(headers).length > 0 };
}
