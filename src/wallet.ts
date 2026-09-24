// Which credits wallet an MCP call is paid from (feature ai-credits, D1 revised
// 2026-09-24: credits live at the ORG level; plan.md "DECISION 2026-09-24").
//
// generate_image has no project in context, so rule 3 applies:
//   org:<users/{uid}.activeOrgId>  when activeOrgId is set AND the caller is in
//                                  that org's memberIds
//   org:personal_<uid>             otherwise (the personal org; its Firestore doc
//                                  may not exist yet: the ledger does not need it,
//                                  and it is then named "Personal workspace")
// The caller never chooses; this server resolves it from Firestore.
//
// Firestore is read over REST with a service account (FIREBASE_CLIENT_EMAIL +
// FIREBASE_PRIVATE_KEY secrets, the same pattern as scry-build-processing-service).
// At most three documents per resolution (cached 60 s): users/{uid},
// orgs/{activeOrgId}, and orgs/personal_<uid> for its name on the fallback path.
// A failed read throws WalletResolutionError: charging a guessed wallet (e.g. the
// personal one when the user picked a team org) would bill the wrong account.

import { SignJWT, importPKCS8 } from "jose";

export interface ResolvedWallet {
  walletId: string;
  orgId: string;
  /** Display name for "Acme · 1,240 credits"; null when not cheaply known. */
  orgName: string | null;
  personal: boolean;
}

export class WalletResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletResolutionError";
  }
}

type WalletEnv = {
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
};

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/datastore";
const FIRESTORE_TIMEOUT_MS = 5_000;
/** Ledger wallet ids are [A-Za-z0-9_-]{1,128} after the prefix. */
const ID_RE = /^[A-Za-z0-9_-]{1,119}$/;

export const personalOrgId = (uid: string) => `personal_${uid}`;

type FsValue = { stringValue?: string; arrayValue?: { values?: FsValue[] }; booleanValue?: boolean };
type FsDoc = { fields?: Record<string, FsValue> };

/** Firestore REST reader with a cached OAuth token (one per worker isolate / DO). */
export class FirestoreReader {
  private token: { value: string; exp: number } | null = null;

  constructor(private readonly env: WalletEnv) {}

  configured(): boolean {
    return !!(this.env.FIREBASE_PROJECT_ID && this.env.FIREBASE_CLIENT_EMAIL && this.env.FIREBASE_PRIVATE_KEY);
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.exp) return this.token.value;
    if (!this.configured()) throw new WalletResolutionError("Firestore service account is not configured");
    // Secrets set from a JSON file often carry literal "\n".
    const pem = this.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, "\n");
    const key = await importPKCS8(pem, "RS256");
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.env.FIREBASE_CLIENT_EMAIL!)
      .setSubject(this.env.FIREBASE_CLIENT_EMAIL!)
      .setAudience(TOKEN_URL)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    if (!res.ok) throw new WalletResolutionError(`service account token: HTTP ${res.status}`);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 };
    return data.access_token;
  }

  /** The document's fields, or null when it does not exist. */
  async get(path: string): Promise<Record<string, FsValue> | null> {
    const token = await this.accessToken();
    const url = `https://firestore.googleapis.com/v1/projects/${this.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FIRESTORE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      if (res.status === 404) return null;
      if (!res.ok) throw new WalletResolutionError(`Firestore ${path.split("/")[0]}: HTTP ${res.status}`);
      return ((await res.json()) as FsDoc).fields ?? {};
    } catch (err) {
      if (err instanceof WalletResolutionError) throw err;
      throw new WalletResolutionError(`Firestore ${path.split("/")[0]}: ${String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

const str = (v: FsValue | undefined) => (typeof v?.stringValue === "string" ? v.stringValue : null);

/** Name shown for a personal org whose doc does not exist yet (the dashboard creates it lazily). */
export const PERSONAL_ORG_FALLBACK_NAME = "Personal workspace";

/**
 * Rule 3 without a project. The org's name comes from its doc; a personal org
 * whose doc does not exist yet is "Personal workspace". Never depends on the
 * dashboard at request time.
 */
export async function resolveCallerWallet(
  reader: Pick<FirestoreReader, "get">,
  uid: string,
): Promise<ResolvedWallet> {
  if (!ID_RE.test(uid)) throw new WalletResolutionError("uid cannot form a wallet id");
  const personalId = personalOrgId(uid);
  const personal = async (doc?: Record<string, FsValue> | null): Promise<ResolvedWallet> => {
    const d = doc === undefined ? await reader.get(`orgs/${encodeURIComponent(personalId)}`) : doc;
    return { walletId: `org:${personalId}`, orgId: personalId, orgName: str(d?.name) ?? PERSONAL_ORG_FALLBACK_NAME, personal: true };
  };

  const user = await reader.get(`users/${encodeURIComponent(uid)}`);
  const activeOrgId = str(user?.activeOrgId);
  if (!activeOrgId || !ID_RE.test(activeOrgId)) return personal();

  const org = await reader.get(`orgs/${encodeURIComponent(activeOrgId)}`);
  if (activeOrgId === personalId) return personal(org);
  if (!org) return personal();
  const members = (org.memberIds?.arrayValue?.values ?? []).map((v) => v.stringValue);
  if (!members.includes(uid)) return personal();
  return { walletId: `org:${activeOrgId}`, orgId: activeOrgId, orgName: str(org.name), personal: false };
}
