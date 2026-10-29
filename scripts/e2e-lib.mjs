// Pure logic for the functional browser gate: validating a flow spec, deciding what a step is
// allowed to do, and shaping the report the rubric scores. No browser, no network, no files.
//
// This exists because REVIEW kept asserting live-DOM facts in prose - "driven in a real browser",
// "focus lands on <body>" - with no artifact behind them. Every other dimension in this pipeline
// is recomputed from a receipt; the functional one was a sentence. A flow run writes
// `tickets/<KEY>/e2e-report.json` and `loop.mjs` recomputes the rate from its per-flow verdicts,
// exactly as it does for visual-diff.

/** Steps that only look. Always allowed. */
export const READ_STEPS = new Set(['goto', 'expectVisible', 'expectText', 'expectUrl', 'expectHidden', 'screenshot']);

/** Steps that interact but do not, on their own, persist anything server-side. */
export const INTERACT_STEPS = new Set(['click', 'fill', 'press', 'select', 'hover', 'wait']);

/** Steps that can write through to the backend. Gated: a flow must opt in with `writes: true`,
 *  because a run drives a REAL backend as the test account and "submit" is not reversible. */
export const WRITE_STEPS = new Set(['submit']);

export const ALL_STEPS = new Set([...READ_STEPS, ...INTERACT_STEPS, ...WRITE_STEPS]);

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Validate one flow, returning every problem rather than throwing on the first - a spec with
 * three typos should report three, not make the author re-run three times.
 */
export function validateFlow(flow, index = 0) {
  const where = `flow[${index}]${isNonEmptyString(flow?.name) ? ` "${flow.name}"` : ''}`;
  const errors = [];

  if (!flow || typeof flow !== 'object') return [`${where}: not an object`];
  if (!isNonEmptyString(flow.name)) errors.push(`${where}: needs a non-empty "name"`);
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
    errors.push(`${where}: needs at least one step`);
    return errors;
  }

  flow.steps.forEach((step, i) => {
    const at = `${where} step[${i}]`;
    if (!step || typeof step !== 'object') return errors.push(`${at}: not an object`);
    if (!isNonEmptyString(step.action)) return errors.push(`${at}: needs an "action"`);
    if (!ALL_STEPS.has(step.action)) {
      return errors.push(`${at}: unknown action "${step.action}" - one of ${[...ALL_STEPS].sort().join(', ')}`);
    }
    if (WRITE_STEPS.has(step.action) && flow.writes !== true) {
      errors.push(`${at}: "${step.action}" writes to the backend - set "writes": true on the flow to allow it`);
    }
    if (step.action === 'goto' && !isNonEmptyString(step.route)) {
      errors.push(`${at}: "goto" needs a "route"`);
    }
    const needsSelector = ['click', 'fill', 'press', 'select', 'hover', 'expectVisible', 'expectHidden', 'expectText'];
    if (needsSelector.includes(step.action) && !isNonEmptyString(step.selector)) {
      errors.push(`${at}: "${step.action}" needs a "selector"`);
    }
    if (step.action === 'fill' && typeof step.value !== 'string') {
      errors.push(`${at}: "fill" needs a string "value"`);
    }
    if (step.action === 'expectText' && !isNonEmptyString(step.text)) {
      errors.push(`${at}: "expectText" needs "text"`);
    }
    return undefined;
  });

  return errors;
}

/** Validate a whole spec. `{ ok, errors, flows }` - `flows` is empty when anything failed, so a
 *  caller cannot half-run a broken spec. */
export function validateSpec(spec) {
  const flows = Array.isArray(spec) ? spec : Array.isArray(spec?.flows) ? spec.flows : null;
  if (!flows) return { ok: false, errors: ['spec must be an array of flows, or { "flows": [...] }'], flows: [] };
  if (flows.length === 0) return { ok: false, errors: ['spec contains no flows'], flows: [] };

  const errors = flows.flatMap((f, i) => validateFlow(f, i));
  const names = flows.map((f) => f?.name).filter(isNonEmptyString);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  for (const d of [...new Set(dupes)]) errors.push(`duplicate flow name "${d}" - names key the report`);

  return { ok: errors.length === 0, errors, flows: errors.length === 0 ? flows : [] };
}

/** Does this spec touch the backend? Used to decide whether a run needs the write acknowledgement. */
export const specWrites = (flows) => (Array.isArray(flows) ? flows : []).some((f) => f?.writes === true);

/** Absolute URL for a step's route against the app base. */
export function stepUrl(appBase, route) {
  const base = String(appBase).replace(/\/+$/, '');
  const path = String(route).startsWith('/') ? route : `/${route}`;
  return `${base}${path}`;
}

/**
 * The report `loop.mjs` scores. Mirrors visual-diff's shape on purpose: a `pass` summary plus
 * per-item verdicts, so the rate is recomputed from the items and a tampered summary changes
 * nothing.
 */
export function buildE2eReport({ key, appBase, results, startedAt, finishedAt }) {
  const flows = (Array.isArray(results) ? results : []).map((r) => ({
    name: r.name,
    status: r.status,
    durationMs: r.durationMs ?? null,
    steps: r.steps ?? [],
    failedStep: r.failedStep ?? null,
    error: r.error ?? null,
  }));
  return {
    key,
    appBase,
    startedAt: startedAt ?? null,
    finishedAt: finishedAt ?? null,
    flows,
    // A summary, not the source of truth. passRateFromE2eReport ignores it.
    pass: flows.length > 0 && flows.every((f) => f.status === 'PASS'),
  };
}

/** Flow statuses that count as "we actually ran this". BLOCKED means the flow never executed
 *  (no session, app unreachable), which is an infrastructure failure, not a result. */
const RAN = new Set(['PASS', 'FAIL']);

/**
 * The rate, recomputed from per-flow verdicts. `null` when nothing ran - the caller must treat
 * that as UNMEASURED rather than as a zero, or a broken stack silently scores as a failing app
 * and the loop tries to "repair" code that was never exercised.
 */
export function passRateFromE2eReport(report) {
  const flows = Array.isArray(report?.flows) ? report.flows : [];
  const ran = flows.filter((f) => RAN.has(f?.status));
  if (ran.length === 0) return null;
  return ran.filter((f) => f.status === 'PASS').length / ran.length;
}

/** A one-line summary per failing flow, for the escalation and the PR body. */
export function failureSummary(report) {
  return (Array.isArray(report?.flows) ? report.flows : [])
    .filter((f) => f?.status === 'FAIL' || f?.status === 'BLOCKED')
    .map((f) => {
      const at = f.failedStep != null ? ` at step ${f.failedStep}` : '';
      return `${f.name}: ${f.status}${at}${f.error ? ` - ${f.error}` : ''}`;
    });
}
