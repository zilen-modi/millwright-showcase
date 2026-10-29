#!/usr/bin/env node
// Guardrails for every external fetch in Autopilot (Jira, Figma, git fetch/push, gh,
// network). The rule: FAIL LOUDLY and get acknowledged — never silently proceed on a
// failed/partial fetch, never fabricate data. Classification + message formatting is
// pure logic in guard-lib.mjs (unit-tested); this file adds the timeout/retry/exec
// plumbing around it.
import pRetry, { AbortError } from 'p-retry';
import { execa } from 'execa';

import { acknowledgement, classifyError, shouldRetry } from './guard-lib.mjs';

/** Race `fn()` against a timeout, rejecting with a timeout-flavoured error if it wins. */
function withTimeout(fn, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`timed out after ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
    Promise.resolve()
      .then(fn)
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

/** Run `fn` (an external fetch) with a timeout and retry, only retrying failure kinds
 * `shouldRetry` says are worth retrying (e.g. never retries auth/not-found). Never
 * throws: returns `{ ok:true, value }` or `{ ok:false, kind, source, label, message }`
 * so the caller decides whether to acknowledge-and-halt or handle it another way. */
export async function withGuard(label, fn, { source, retries = 2, timeoutMs = 15000 } = {}) {
  let lastKind = 'other';
  let lastMessage = '';
  try {
    const value = await pRetry(
      async () => {
        try {
          return await withTimeout(fn, timeoutMs);
        } catch (err) {
          const kind = classifyError(err);
          lastKind = kind;
          lastMessage = err?.message || String(err);
          if (!shouldRetry(kind)) {
            // p-retry stops immediately on AbortError, no further attempts wasted.
            throw new AbortError(err);
          }
          throw err;
        }
      },
      { retries, onFailedAttempt: () => {} },
    );
    return { ok: true, value };
  } catch {
    return { ok: false, kind: lastKind, source: source || label, label, message: lastMessage };
  }
}

/** If `result` is a failure, print the structured acknowledgement and throw (so the
 * calling stage HALTS with a clear, non-silent reason). If ok, unwrap and return the
 * value. */
export function acknowledgeOrThrow(result) {
  if (!result.ok) {
    const line = acknowledgement(result);
    console.error(line);
    throw new Error(line);
  }
  return result.value;
}

/** Guarded `execa` for git/gh/network commands — same timeout+retry+classification as
 * `withGuard`, wrapping a subprocess instead of an arbitrary async function. */
export async function guardExec(label, cmd, args = [], opts = {}) {
  const { source, retries = 2, timeoutMs = 15000, ...execaOpts } = opts;
  return withGuard(label, () => execa(cmd, args, execaOpts), { source: source || cmd, retries, timeoutMs });
}
