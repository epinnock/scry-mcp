import { importX509 } from "jose";

// --- Key cache ---
let cachedKeys: Record<string, string> | null = null;
let cacheExpiry = 0;

export async function getGooglePublicKeys(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cachedKeys && now < cacheExpiry) return cachedKeys;

  const res = await fetch(
    "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com"
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch Google public keys: ${res.status}`);
  }

  const cacheControl = res.headers.get("Cache-Control") || "";
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAge = maxAgeMatch ? parseInt(maxAgeMatch[1]) * 1000 : 3600_000;

  cachedKeys = (await res.json()) as Record<string, string>;
  cacheExpiry = now + maxAge;
  return cachedKeys;
}

// Exported for test teardown
export function _resetKeyCache(): void {
  cachedKeys = null;
  cacheExpiry = 0;
}

function base64UrlToArrayBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  const padded = pad ? base64 + "=".repeat(4 - pad) : base64;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// --- Types ---
export interface FirebaseTokenPayload {
  uid: string;
  email?: string;
  name?: string;
  picture?: string;
  email_verified?: boolean;
  auth_time: number;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  sub: string;
  firebase: {
    sign_in_provider: string;
    identities: Record<string, string[]>;
  };
}

// --- Main verification function ---
export async function verifyFirebaseIdToken(
  idToken: string,
  projectId: string
): Promise<FirebaseTokenPayload | null> {
  try {
    const parts = idToken.split(".");
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;
    const decodeB64Url = (s: string) => {
      const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
      const pad = b64.length % 4;
      return atob(pad ? b64 + "=".repeat(4 - pad) : b64);
    };
    const header = JSON.parse(decodeB64Url(headerB64));
    const payload: FirebaseTokenPayload = JSON.parse(decodeB64Url(payloadB64));

    // 1. Validate claims
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) { console.error("[firebase-verify] token expired", { exp: payload.exp, now }); return null; }
    if (payload.iat > now + 5) { console.error("[firebase-verify] iat in future", { iat: payload.iat, now }); return null; }
    if (payload.aud !== projectId) { console.error("[firebase-verify] aud mismatch", { aud: payload.aud, projectId }); return null; }
    if (payload.iss !== `https://securetoken.google.com/${projectId}`) { console.error("[firebase-verify] iss mismatch", { iss: payload.iss, projectId }); return null; }
    if (!payload.sub || payload.sub.length === 0 || payload.sub.length > 128) { console.error("[firebase-verify] invalid sub"); return null; }
    if (payload.auth_time > now + 5) { console.error("[firebase-verify] auth_time in future"); return null; }

    // 2. Fetch Google's public keys
    const keys = await getGooglePublicKeys();
    const certPem = keys[header.kid];
    if (!certPem) { console.error("[firebase-verify] kid not found", { kid: header.kid }); return null; }

    // 3. Import public key from X.509 cert and verify signature
    const publicKey = await importX509(certPem, "RS256");
    const signatureInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = base64UrlToArrayBuffer(signatureB64);

    const cryptoKey = publicKey as unknown as CryptoKey;
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signature,
      signatureInput
    );

    if (!valid) { console.error("[firebase-verify] signature invalid"); return null; }

    payload.uid = payload.sub;
    return payload;
  } catch (err) {
    console.error("[firebase-verify] unexpected error", err);
    return null;
  }
}
