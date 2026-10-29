// Pure classification/formatting logic for the external-fetch guardrails, extracted
// for unit testing. Every external call in Autopilot (Jira, Figma, git fetch/push, gh,
// network) must fail loudly and be acknowledged rather than silently proceeding on
// missing/partial data — this module decides *what kind* of failure occurred, whether
// it's worth retrying, and how to phrase the acknowledgement that halts the stage.

/** Classify an error (or error-like `{message, code, status}`) into a coarse kind so
 * callers can decide whether to retry and how to phrase the acknowledgement. */
export function classifyError(err) {
  const message = String(err?.message ?? err ?? '');
  const code = err?.code ? String(err.code) : '';
  const status = err?.status ?? err?.statusCode ?? extractStatus(message);
  const haystack = `${code} ${message}`.toLowerCase();

  // Check specific network/timeout error codes first — ENOTFOUND, for instance,
  // textually contains "not found" but is a DNS/network failure, not an HTTP 404.
  if (/econnrefused|enotfound|econnreset|ehostunreach|enetunreach|fetch failed/.test(haystack)) {
    return 'network';
  }
  if (/etimedout|timeout|timed out/.test(haystack)) {
    return 'timeout';
  }
  if (status === 401 || status === 403 || /\b(401|403)\b/.test(haystack) || /unauthoriz|forbidden|\btoken\b|\bauth\b/.test(haystack)) {
    return 'auth';
  }
  if (status === 429 || /\b429\b/.test(haystack) || /rate.?limit/.test(haystack)) {
    return 'rate-limit';
  }
  if (status === 404 || /\b404\b/.test(haystack) || /not found/.test(haystack)) {
    return 'not-found';
  }
  if (/network/.test(haystack)) {
    return 'network';
  }
  return 'other';
}

function extractStatus(message) {
  const m = /\b(\d{3})\b/.exec(message);
  return m ? Number(m[1]) : undefined;
}

/** Whether a given failure kind is worth retrying. Auth and not-found failures are
 * deterministic — retrying wastes time and risks masking a real config problem. */
export function shouldRetry(kind) {
  return kind === 'network' || kind === 'timeout' || kind === 'rate-limit';
}

/** Format the single structured acknowledgement line the orchestrator prints/logs when
 * a stage halts on a failed external fetch, instead of proceeding on missing data. */
export function acknowledgement({ label, source, kind, message }) {
  return `⛔ ${label} BLOCKED — ${source} fetch failed (${kind}): ${message}. Acknowledged; stopping this stage rather than proceeding on missing data.`;
}
