// Pure logic for obtaining a browser session against the local stack - no network, no
// filesystem, unit-testable. `session.mjs` does the fetch and the file write.
//
// The app does not accept a bare JWT. `frontend/src/utils/auth/token.ts` stores the token as
// `encodeURIComponent(CryptoJS.AES.encrypt(jwt, NEXT_PUBLIC_TOKEN_SECRET).toString())` under the
// cookie `authToken`, and the server reads it back through `next/headers` - which is why request
// interception cannot fake a session and a real cookie has to be minted.
import CryptoJS from 'crypto-js';

/** The cookie name the app reads. Mirrors `AUTH_TOKEN_COOKIE_NAME` in the frontend. */
export const AUTH_COOKIE_NAME = 'authToken';

/** The frontend's own fallback in `env.public.ts`. A local stack started without the variable
 *  set is running on exactly this, so defaulting to it is what makes the helper work out of the
 *  box rather than failing on a secret nobody set. */
export const DEFAULT_TOKEN_SECRET = 'local-dev-secret-change-me';

/** Where the backend mounts username/password login. */
export const LOGIN_PATH = '/api/auth/v1/password/login';

const trimOrNull = (v) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? null : s;
};

const stripSlash = (url) => String(url).replace(/\/+$/, '');

/**
 * Resolve everything a browser run needs from the environment, reporting what is missing rather
 * than throwing - the caller turns that into one actionable message naming the env file.
 *
 * Credentials come from `config/*.env` (gitignored by pattern) and are never defaulted: a test
 * account has to be a deliberate act, not something the tooling invents.
 */
export function resolveSessionConfig(env = {}) {
  const cfg = {
    apiBase: stripSlash(trimOrNull(env.E2E_API_BASE) ?? 'http://localhost:4000'),
    appBase: stripSlash(trimOrNull(env.E2E_APP_BASE) ?? 'http://localhost:3000'),
    username: trimOrNull(env.E2E_USERNAME),
    password: trimOrNull(env.E2E_PASSWORD),
    tokenSecret: trimOrNull(env.E2E_TOKEN_SECRET) ?? DEFAULT_TOKEN_SECRET,
  };
  const missing = ['E2E_USERNAME', 'E2E_PASSWORD'].filter((k) => !trimOrNull(env[k]));
  return { ...cfg, missing, ok: missing.length === 0 };
}

/** The login endpoint for a given API base. */
export const loginUrl = (apiBase) => `${stripSlash(apiBase)}${LOGIN_PATH}`;

/**
 * Pull the access token out of a login response without assuming one envelope shape. The backend
 * wraps payloads as `{ success, data }`, but the branch-activate route answers a bare
 * `{ access_token }` - a difference that already cost a wasted debugging round once, when a
 * fixture returned `{ activeBranchId }` and the switch silently did nothing.
 */
export function tokenFromLoginResponse(body) {
  if (!body || typeof body !== 'object') return null;
  const candidates = [body, body.data, body.result, body.payload].filter(
    (o) => o && typeof o === 'object',
  );
  for (const o of candidates) {
    for (const key of ['access_token', 'accessToken', 'token', 'jwt']) {
      const v = trimOrNull(o[key]);
      if (v) return v;
    }
  }
  return null;
}

/** Mint the `authToken` cookie value for a JWT: AES through CryptoJS, then URL-encoded, because
 *  the reader calls `decryptTokenValue(decodeURIComponent(value))`. */
export function encryptAuthCookie(jwt, secret = DEFAULT_TOKEN_SECRET) {
  const token = trimOrNull(jwt);
  if (!token) throw new Error('encryptAuthCookie: refusing to encrypt an empty token');
  return encodeURIComponent(CryptoJS.AES.encrypt(token, secret).toString());
}

/** Read one back - used by the tests and by `session.mjs --verify` to prove a stored cookie still
 *  decrypts under the secret the app is actually running with. */
export function decryptAuthCookie(value, secret = DEFAULT_TOKEN_SECRET) {
  try {
    const bytes = CryptoJS.AES.decrypt(decodeURIComponent(String(value)), secret);
    return trimOrNull(bytes.toString(CryptoJS.enc.Utf8));
  } catch {
    return null;
  }
}

/** A Playwright cookie record for the app origin. `sameSite: 'Lax'` and a path of `/` match what
 *  the app sets itself, so middleware sees the same thing on a navigation as it would in a
 *  real browser. */
export function sessionCookie(cookieValue, appBase) {
  const { hostname } = new URL(appBase);
  return {
    name: AUTH_COOKIE_NAME,
    value: cookieValue,
    domain: hostname,
    path: '/',
    httpOnly: false,
    secure: false,
    sameSite: 'Lax',
  };
}

/**
 * A JWT's expiry, read WITHOUT verifying the signature - the app does the same
 * (`decodeToken` uses `jose.decodeJwt`). This is only ever used to say "your session is stale,
 * log in again", never to decide that a token is trustworthy.
 */
export function tokenExpiry(jwt) {
  try {
    const [, payload] = String(jwt).split('.');
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** True when the token is absent, unreadable, or expires within `skewMs`. */
export function isSessionStale(jwt, nowMs = Date.now(), skewMs = 60_000) {
  const exp = tokenExpiry(jwt);
  if (exp === null) return true;
  return exp - skewMs <= nowMs;
}

/**
 * Remove secrets from anything about to be printed. Every browser run logs URLs, response bodies
 * and Playwright errors, and a password or a live token in a panel log is a leak that outlives
 * the run - `tickets/` and `pr-reviews/` are committed.
 */
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    const s = trimOrNull(secret);
    if (!s || s.length < 4) continue; // too short to match anything but noise
    out = out.split(s).join('[redacted]');
    out = out.split(encodeURIComponent(s)).join('[redacted]');
  }
  return out;
}
