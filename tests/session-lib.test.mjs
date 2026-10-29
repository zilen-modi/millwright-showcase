import { describe, expect, it } from 'vitest';

import {
  AUTH_COOKIE_NAME,
  DEFAULT_TOKEN_SECRET,
  decryptAuthCookie,
  encryptAuthCookie,
  isSessionStale,
  loginUrl,
  redact,
  resolveSessionConfig,
  sessionCookie,
  tokenExpiry,
  tokenFromLoginResponse,
} from '../scripts/session-lib.mjs';

const jwtWith = (payload) =>
  `${Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')}.` +
  `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

describe('resolveSessionConfig', () => {
  it('defaults the two local hosts and the app\'s own fallback secret', () => {
    const c = resolveSessionConfig({ E2E_USERNAME: 'u', E2E_PASSWORD: 'p' });
    expect(c.appBase).toBe('http://localhost:3000');
    expect(c.apiBase).toBe('http://localhost:4000');
    expect(c.tokenSecret).toBe(DEFAULT_TOKEN_SECRET);
    expect(c.ok).toBe(true);
  });

  // Credentials are the one thing that must never be invented by the tooling.
  it('reports missing credentials instead of defaulting them', () => {
    const c = resolveSessionConfig({});
    expect(c.ok).toBe(false);
    expect(c.missing).toEqual(['E2E_USERNAME', 'E2E_PASSWORD']);
    expect(c.username).toBeNull();
    expect(c.password).toBeNull();
  });

  it('treats whitespace-only values as missing', () => {
    expect(resolveSessionConfig({ E2E_USERNAME: '  ', E2E_PASSWORD: 'p' }).missing).toEqual(['E2E_USERNAME']);
  });

  it('strips trailing slashes so URLs never double up', () => {
    const c = resolveSessionConfig({ E2E_API_BASE: 'http://localhost:4000/', E2E_USERNAME: 'u', E2E_PASSWORD: 'p' });
    expect(loginUrl(c.apiBase)).toBe('http://localhost:4000/api/auth/v1/password/login');
  });
});

describe('tokenFromLoginResponse', () => {
  it.each([
    [{ data: { access_token: 'abc' } }, 'abc'],
    [{ access_token: 'abc' }, 'abc'],
    [{ data: { accessToken: 'abc' } }, 'abc'],
    [{ result: { token: 'abc' } }, 'abc'],
  ])('reads %j', (body, want) => {
    expect(tokenFromLoginResponse(body)).toBe(want);
  });

  it.each([null, undefined, {}, { data: {} }, 'nope', { data: { access_token: '  ' } }])(
    'is null for %j rather than returning a blank token',
    (body) => { expect(tokenFromLoginResponse(body)).toBeNull(); },
  );
});

describe('the auth cookie', () => {
  // The exact shape the app reads: decryptTokenValue(decodeURIComponent(value)).
  it('round-trips through URL-encoding and AES', () => {
    const jwt = jwtWith({ sub: 'u', exp: 1 });
    const cookie = encryptAuthCookie(jwt, 'a-secret');
    expect(cookie).not.toContain('+'); // URL-encoded, or the cookie breaks on the wire
    expect(decryptAuthCookie(cookie, 'a-secret')).toBe(jwt);
  });

  it('does not decrypt under the wrong secret', () => {
    const cookie = encryptAuthCookie(jwtWith({ sub: 'u' }), 'right');
    expect(decryptAuthCookie(cookie, 'wrong')).toBeNull();
  });

  it('is salted, so the same token encrypts differently every time', () => {
    const jwt = jwtWith({ sub: 'u' });
    expect(encryptAuthCookie(jwt, 's')).not.toBe(encryptAuthCookie(jwt, 's'));
  });

  it('refuses an empty token rather than minting a cookie for nothing', () => {
    expect(() => encryptAuthCookie('', 's')).toThrow(/empty token/);
    expect(() => encryptAuthCookie(null, 's')).toThrow();
  });

  it('builds a cookie for the app origin', () => {
    const c = sessionCookie('v', 'http://localhost:3000');
    expect(c).toMatchObject({ name: AUTH_COOKIE_NAME, domain: 'localhost', path: '/', sameSite: 'Lax' });
  });
});

describe('session staleness', () => {
  it('reads exp without verifying the signature, as the app does', () => {
    expect(tokenExpiry(jwtWith({ exp: 1700 }))).toBe(1_700_000);
  });

  it.each(['', 'not.a.jwt', 'a.b', null])('is stale for an unreadable token: %j', (jwt) => {
    expect(isSessionStale(jwt)).toBe(true);
  });

  it('is stale inside the clock-skew window, not just after expiry', () => {
    const exp = 1_000_000;
    expect(isSessionStale(jwtWith({ exp: exp / 1000 }), exp - 30_000, 60_000)).toBe(true);
    expect(isSessionStale(jwtWith({ exp: exp / 1000 }), exp - 90_000, 60_000)).toBe(false);
  });
});

describe('redact', () => {
  // tickets/ and pr-reviews/ are committed, so a password reaching a log outlives the run.
  it('removes a secret and its URL-encoded form', () => {
    const out = redact('login as u with p@ss/word and p%40ss%2Fword', ['p@ss/word']);
    expect(out).not.toContain('p@ss/word');
    expect(out).not.toContain('p%40ss%2Fword');
    expect(out).toContain('[redacted]');
  });

  it('removes every occurrence, not just the first', () => {
    expect(redact('abcd abcd abcd', ['abcd'])).toBe('[redacted] [redacted] [redacted]');
  });

  // A 1-3 char "secret" would redact half the log into noise and hide the real message.
  it.each(['', '  ', 'ab', 'abc', null, undefined])('ignores a too-short secret: %j', (s) => {
    expect(redact('abc def', [s])).toBe('abc def');
  });

  it('is tolerant of non-string input', () => {
    expect(redact(null, ['x'])).toBe('');
    expect(redact(undefined, [])).toBe('');
  });
});
