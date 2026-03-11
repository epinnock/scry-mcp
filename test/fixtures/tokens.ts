import { SignJWT, generateKeyPair } from "jose";

let _keyPair: Awaited<ReturnType<typeof generateKeyPair>> | null = null;

export async function getTestKeyPair() {
  if (!_keyPair) _keyPair = await generateKeyPair("RS256");
  return _keyPair;
}

export const TEST_PROJECT_ID = "test-project-123";
export const TEST_KID = "test-key-id-1";

interface TokenOptions {
  uid?: string;
  email?: string;
  name?: string;
  emailVerified?: boolean;
  projectId?: string;
  expiresIn?: string;   // e.g. "1h", "-1h" for expired
  issuedAt?: Date;
  kid?: string;
}

export async function createTestToken(opts: TokenOptions = {}): Promise<string> {
  const { privateKey } = await getTestKeyPair();
  const projectId = opts.projectId ?? TEST_PROJECT_ID;
  const uid = opts.uid ?? "test-user-abc";

  const now = Math.floor(Date.now() / 1000);

  const jwt = new SignJWT({
    email: opts.email ?? "test@example.com",
    name: opts.name ?? "Test User",
    email_verified: opts.emailVerified ?? true,
    auth_time: now - 60,
    firebase: {
      sign_in_provider: "google.com",
      identities: { "google.com": ["123"], email: [opts.email ?? "test@example.com"] },
    },
  })
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? TEST_KID })
    .setSubject(uid)
    .setAudience(projectId)
    .setIssuer(`https://securetoken.google.com/${projectId}`)
    .setIssuedAt(opts.issuedAt ?? new Date());

  if (opts.expiresIn) {
    jwt.setExpirationTime(opts.expiresIn);
  } else {
    jwt.setExpirationTime("1h");
  }

  return jwt.sign(privateKey);
}

/**
 * Returns the test public key as a CryptoKey for use with crypto.subtle.verify.
 * Use this with vi.mock("jose") to mock importX509 since we can't create
 * real X.509 certificates in tests.
 */
export async function getTestPublicCryptoKey(): Promise<CryptoKey> {
  const { publicKey } = await getTestKeyPair();
  return publicKey as unknown as CryptoKey;
}
