import { describe, expect, it } from 'vitest';

import { acknowledgement, classifyError, shouldRetry } from '../scripts/guard-lib.mjs';

describe('classifyError', () => {
  it('classifies ECONNREFUSED/ENOTFOUND/fetch failed as network', () => {
    expect(classifyError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' })).toBe('network');
    expect(classifyError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND api.figma.com' })).toBe('network');
    expect(classifyError(new Error('fetch failed'))).toBe('network');
  });

  it('classifies ETIMEDOUT/timeout as timeout', () => {
    expect(classifyError({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' })).toBe('timeout');
    expect(classifyError(new Error('operation timed out'))).toBe('timeout');
  });

  it('classifies 401/403/token errors as auth', () => {
    expect(classifyError(new Error('Request failed with status code 401'))).toBe('auth');
    expect(classifyError({ status: 403, message: 'Forbidden' })).toBe('auth');
    expect(classifyError(new Error('invalid token'))).toBe('auth');
  });

  it('classifies 429 as rate-limit', () => {
    expect(classifyError(new Error('Request failed with status code 429'))).toBe('rate-limit');
    expect(classifyError({ status: 429, message: 'Too Many Requests' })).toBe('rate-limit');
  });

  it('classifies 404 as not-found', () => {
    expect(classifyError(new Error('Request failed with status code 404'))).toBe('not-found');
    expect(classifyError({ status: 404, message: 'Not Found' })).toBe('not-found');
  });

  it('falls back to other for unrecognized errors', () => {
    expect(classifyError(new Error('something unexpected exploded'))).toBe('other');
    expect(classifyError()).toBe('other');
  });
});

describe('shouldRetry', () => {
  it('retries network, timeout, and rate-limit', () => {
    expect(shouldRetry('network')).toBe(true);
    expect(shouldRetry('timeout')).toBe(true);
    expect(shouldRetry('rate-limit')).toBe(true);
  });

  it('does not retry auth or not-found', () => {
    expect(shouldRetry('auth')).toBe(false);
    expect(shouldRetry('not-found')).toBe(false);
  });

  it('does not retry other', () => {
    expect(shouldRetry('other')).toBe(false);
  });
});

describe('acknowledgement', () => {
  it('formats the structured acknowledgement line', () => {
    const line = acknowledgement({ label: 'REVIEW', source: 'Figma', kind: 'auth', message: 'invalid token' });
    expect(line).toBe(
      '⛔ REVIEW BLOCKED — Figma fetch failed (auth): invalid token. Acknowledged; stopping this stage rather than proceeding on missing data.',
    );
  });

  it('includes label, source, and kind for any failure', () => {
    const line = acknowledgement({ label: 'BUILD', source: 'git fetch', kind: 'network', message: 'ECONNREFUSED' });
    expect(line).toContain('BUILD BLOCKED');
    expect(line).toContain('git fetch fetch failed (network)');
    expect(line).toContain('ECONNREFUSED');
  });
});
