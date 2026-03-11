import { Hono } from "hono";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { verifyFirebaseIdToken } from "./utils/firebase-verify";

const app = new Hono<{ Bindings: Env }>();

// ----- CSRF helpers -----

function generateCSRFToken(): { token: string; setCookie: string } {
  const token = crypto.randomUUID();
  const setCookie = `__Host-csrf=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`;
  return { token, setCookie };
}

function validateCSRFToken(formData: FormData, request: Request): boolean {
  const formToken = formData.get("csrf_token") as string;
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader
    .split(";")
    .find((c) => c.trim().startsWith("__Host-csrf="));
  const cookieToken = match?.split("=")[1]?.trim();
  return !!formToken && formToken === cookieToken;
}

// ----- Routes -----

// GET /authorize — show the Firebase sign-in page
app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  if (!oauthReqInfo.clientId) {
    return c.text("Invalid OAuth request", 400);
  }

  const { token: csrfToken, setCookie } = generateCSRFToken();
  const state = btoa(JSON.stringify({ oauthReqInfo }));

  const html = renderLoginPage({
    firebaseApiKey: c.env.FIREBASE_API_KEY,
    firebaseAuthDomain: c.env.FIREBASE_AUTH_DOMAIN,
    firebaseProjectId: c.env.FIREBASE_PROJECT_ID,
    state,
    csrfToken,
  });

  return c.html(html, 200, { "Set-Cookie": setCookie });
});

// POST /callback — receive the Firebase ID token, verify, issue MCP token
app.post("/callback", async (c) => {
  const formData = await c.req.raw.formData();

  if (!validateCSRFToken(formData, c.req.raw)) {
    return c.text("CSRF validation failed", 403);
  }

  const firebaseIdToken = formData.get("id_token") as string;
  const encodedState = formData.get("state") as string;

  if (!firebaseIdToken || !encodedState) {
    return c.text("Missing credentials", 400);
  }

  const user = await verifyFirebaseIdToken(
    firebaseIdToken,
    c.env.FIREBASE_PROJECT_ID
  );
  if (!user) {
    return c.text("Authentication failed", 401);
  }

  let state: { oauthReqInfo: AuthRequest };
  try {
    state = JSON.parse(atob(encodedState));
  } catch {
    return c.text("Invalid state", 400);
  }

  if (!state.oauthReqInfo?.clientId) {
    return c.text("Invalid OAuth request in state", 400);
  }

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: state.oauthReqInfo,
    userId: user.uid,
    metadata: {
      label: user.email || user.uid,
    },
    scope: state.oauthReqInfo.scope,
    props: {
      firebaseUid: user.uid,
      email: user.email || "",
      displayName: user.name || "",
      emailVerified: user.email_verified || false,
    },
  });

  return Response.redirect(redirectTo);
});

// ----- Login Page -----

function renderLoginPage(config: {
  firebaseApiKey: string;
  firebaseAuthDomain: string;
  firebaseProjectId: string;
  state: string;
  csrfToken: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign In — Scry MCP</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; background: #f5f5f5;
    }
    .card {
      background: white; border-radius: 12px; padding: 2rem;
      box-shadow: 0 2px 12px rgba(0,0,0,0.1); max-width: 400px; width: 100%;
    }
    h1 { font-size: 1.25rem; margin-bottom: 1.5rem; text-align: center; }
    .btn {
      display: block; width: 100%; padding: 0.75rem; margin-bottom: 0.75rem;
      border: 1px solid #ddd; border-radius: 8px; font-size: 1rem;
      cursor: pointer; background: white; transition: background 0.15s;
    }
    .btn:hover { background: #f0f0f0; }
    .btn-google { border-color: #4285f4; color: #4285f4; }
    .divider { text-align: center; margin: 1rem 0; color: #999; font-size: 0.875rem; }
    input {
      display: block; width: 100%; padding: 0.75rem; margin-bottom: 0.75rem;
      border: 1px solid #ddd; border-radius: 8px; font-size: 1rem;
    }
    .btn-submit { background: #333; color: white; border: none; }
    .btn-submit:hover { background: #555; }
    .error { color: #d32f2f; font-size: 0.875rem; margin-bottom: 0.75rem; display: none; }
    .loading { display: none; text-align: center; padding: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign in to Scry</h1>
    <div id="error" class="error"></div>
    <div id="loading" class="loading">Signing in...</div>
    <div id="auth-ui">
      <button class="btn btn-google" onclick="signInWithGoogle()">
        Continue with Google
      </button>
      <div class="divider">or sign in with email</div>
      <input type="email" id="email" placeholder="Email" autocomplete="email" />
      <input type="password" id="password" placeholder="Password" autocomplete="current-password" />
      <button class="btn btn-submit" onclick="signInWithEmail()">Sign In</button>
    </div>
  </div>
  <script src="https://www.gstatic.com/firebasejs/11.0.0/firebase-app-compat.js"></script>
  <script src="https://www.gstatic.com/firebasejs/11.0.0/firebase-auth-compat.js"></script>
  <script>
    firebase.initializeApp({
      apiKey: "${config.firebaseApiKey}",
      authDomain: "${config.firebaseAuthDomain}",
      projectId: "${config.firebaseProjectId}",
    });
    const auth = firebase.auth();
    function showError(msg) {
      const el = document.getElementById("error");
      el.textContent = msg;
      el.style.display = "block";
    }
    function showLoading() {
      document.getElementById("auth-ui").style.display = "none";
      document.getElementById("loading").style.display = "block";
    }
    async function submitToken(idToken) {
      showLoading();
      const form = document.createElement("form");
      form.method = "POST";
      form.action = "/callback";
      const fields = {
        id_token: idToken,
        state: "${config.state}",
        csrf_token: "${config.csrfToken}",
      };
      for (const [key, value] of Object.entries(fields)) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = key;
        input.value = value;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    }
    async function signInWithGoogle() {
      try {
        const provider = new firebase.auth.GoogleAuthProvider();
        const result = await auth.signInWithPopup(provider);
        const idToken = await result.user.getIdToken();
        await submitToken(idToken);
      } catch (err) {
        showError(err.message || "Google sign-in failed");
      }
    }
    async function signInWithEmail() {
      const email = document.getElementById("email").value;
      const password = document.getElementById("password").value;
      if (!email || !password) {
        showError("Please enter email and password");
        return;
      }
      try {
        const result = await auth.signInWithEmailAndPassword(email, password);
        const idToken = await result.user.getIdToken();
        await submitToken(idToken);
      } catch (err) {
        showError(err.message || "Sign-in failed");
      }
    }
  </script>
</body>
</html>`;
}

export const FirebaseAuthHandler = app;
