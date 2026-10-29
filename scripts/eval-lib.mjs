// Pure logic for the golden-set regression harness (eval.mjs is the IO wrapper). A
// set of already-merged tickets is ground truth; scoreDiff scores a PRODUCED diff
// against one golden entry's expectation so changes to the SKILL/agents get tested
// instead of shipping blind. No filesystem/network here — fully unit-testable.

// INVARIANT: every hard gate weighs strictly MORE than (1 - PASS_BAR) = 0.2, so that
// when the other checks are perfect, a single gate failing on its own (score 0) still
// drops the total below the pass bar. They're correctness/safety gates, not just "nice
// to have" signal like file-overlap. Adding a fifth gate (conventions, 2026-08-09)
// forced a rebalance: four gates at 0.22 leaves 0.12 for file-overlap and keeps
// 1 - 0.22 = 0.78 < 0.8. `weightsRespectPassBar` below asserts this in the test suite —
// if you add a gate, keep the invariant or the harness silently stops gating.
const PASS_BAR = 0.8;
const WEIGHTS = {
  fileOverlap: 0.12,
  mustContain: 0.22,
  noRawHexInComponents: 0.22,
  testCountDelta: 0.22,
  conventions: 0.22,
};
const HARD_GATES = ['mustContain', 'noRawHexInComponents', 'testCountDelta', 'conventions'];

/** Does every hard gate outweigh the slack below the pass bar? Exported so the test
 * suite pins the invariant rather than trusting the comment above it. */
export function weightsRespectPassBar(weights = WEIGHTS, passBar = PASS_BAR) {
  return HARD_GATES.every((g) => weights[g] > 1 - passBar);
}

// #rgb / #rrggbb — a raw hex color literal. Component styles must bind to design
// tokens instead (see conventions.md), so finding one is a hard fail when required.
const RAW_HEX_RE = /#[0-9a-f]{3,6}\b/i;

// A hex inside a COMMENT is documentation, not a binding. Real case that made this
// necessary: Multiselect.module.scss ships `// 1px vertical divider, h16. No token
// lands on the literal #a8a8a8;` — a comment explaining why no token exists. Scoring
// every added line blindly failed a perfectly correct shipped component.
const COMMENT_LINE_RE = /^\s*(\/\/|\/\*|\*)/;

/** Does `file` fall under `prefix`? `prefix` may be a directory (with or without a
 * trailing slash) or a partial/full file path — golden entries record "filesTouched"
 * either way (e.g. a component directory or a specific styles file). */
function underPrefix(file, prefix) {
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return file === prefix || file.startsWith(prefix) || file.startsWith(p);
}

/** Jaccard-style overlap between the files a produced diff actually touched and the
 * expected "filesTouched" prefixes. A produced file counts toward the intersection if
 * it lands under any expected prefix; a produced file matching no prefix, and an
 * expected prefix nothing landed under, both count against the union. */
function fileOverlapScore(filesChanged, filesTouched) {
  if (!filesTouched || filesTouched.length === 0) {
    return { score: 1, detail: 'no expected files specified' };
  }
  const changed = filesChanged || [];
  const matchedPrefixes = filesTouched.filter((prefix) => changed.some((f) => underPrefix(f, prefix)));
  const unmatchedFiles = changed.filter((f) => !filesTouched.some((prefix) => underPrefix(f, prefix)));
  const intersection = matchedPrefixes.length;
  const union = filesTouched.length + unmatchedFiles.length;
  const score = union === 0 ? 1 : intersection / union;
  const detail = `${matchedPrefixes.length}/${filesTouched.length} expected path(s) matched, ${unmatchedFiles.length} unexpected file(s) changed`;
  return { score, detail };
}

/** Every `{file, token}` pair must appear among the produced added lines for a file
 * whose path contains the expected `file` fragment (golden entries use a short suffix
 * like "_tag.scss" rather than a full repo path). */
function mustContainScore(containsByFile, mustContain) {
  if (!mustContain || mustContain.length === 0) {
    return { score: 1, detail: 'no required tokens specified', missing: [] };
  }
  const byFile = containsByFile || {};
  const missing = [];
  for (const { file, token } of mustContain) {
    const matchingKeys = Object.keys(byFile).filter((k) => k.includes(file));
    const found = matchingKeys.some((k) => (byFile[k] || []).some((line) => line.includes(token)));
    if (!found) missing.push(`${file}::${token}`);
  }
  const score = (mustContain.length - missing.length) / mustContain.length;
  const detail = missing.length ? `missing: ${missing.join(', ')}` : `all ${mustContain.length} token(s) found`;
  return { score, detail, missing };
}

/** Scan every added line under `src/components` for a raw hex color literal —
 * component colors must bind to design-token variables instead (conventions.md). */
function rawHexScore(containsByFile, required) {
  if (!required) return { score: 1, detail: 'not required' };
  const byFile = containsByFile || {};
  const offenders = new Set();
  for (const [file, lines] of Object.entries(byFile)) {
    if (!file.includes('src/components')) continue;
    for (const line of lines || []) {
      if (COMMENT_LINE_RE.test(line)) continue; // documenting a hex ≠ binding one
      if (RAW_HEX_RE.test(line)) offenders.add(file);
    }
  }
  const score = offenders.size === 0 ? 1 : 0;
  const detail = offenders.size ? `raw hex found in: ${[...offenders].join(', ')}` : 'no raw hex in components';
  return { score, detail };
}

/** Run the accumulated conventions.md rules over the produced diff via the shared
 * linter (`scripts/conventions-lint-lib.mjs`). The linter is INJECTED rather than
 * imported so this module stays pure and unit-testable; `scripts/eval.mjs` wires the
 * real one in. When a golden entry requires the check and no linter was supplied we
 * fail closed (score 0) rather than waving it through — an unrunnable gate that
 * silently passes is the exact failure mode this harness exists to catch. */
function conventionsScore(containsByFile, required, lintSources) {
  if (!required) return { score: 1, detail: 'not required' };
  if (typeof lintSources !== 'function') {
    return { score: 0, detail: 'conventions check required but no linter was supplied' };
  }
  const sources = Object.entries(containsByFile || {}).map(([path, lines]) => ({
    path,
    text: (lines || []).join('\n'),
  }));
  const { count, violations } = lintSources(sources, { addedLinesOnly: true }) || {};
  const n = count ?? (violations || []).length;
  if (n === 0) return { score: 1, detail: 'no convention violations' };
  const summary = (violations || [])
    .slice(0, 3)
    .map((v) => `${v.rule} (${v.file})`)
    .join(', ');
  return { score: 0, detail: `${n} convention violation(s): ${summary}${n > 3 ? ', …' : ''}` };
}

const SIGN_CHECKS = {
  positive: (n) => n > 0,
  negative: (n) => n < 0,
  zero: (n) => n === 0,
  nonzero: (n) => n !== 0,
};

/** Does the produced test-count delta move in the direction the golden entry expects
 * ("positive"/"negative"/"zero"/"nonzero")? */
function testCountDeltaScore(delta, expected) {
  if (expected === undefined || expected === null) return { score: 1, detail: 'not required' };
  const check = SIGN_CHECKS[expected];
  if (!check) return { score: 0, detail: `unknown expected sign "${expected}"` };
  const n = typeof delta === 'number' ? delta : 0;
  const ok = check(n);
  return { score: ok ? 1 : 0, detail: `expected ${expected}, produced delta ${n}` };
}

/** Score one produced diff against one golden-set expectation.
 * `produced = { filesChanged, additions, deletions, containsByFile, testCountDelta }`.
 * `expected` is a golden-set entry's `expect` block. `opts.lintSources` injects the
 * conventions linter (see conventionsScore). Returns a 0..1 weighted score, a top-level
 * `pass` (score >= 0.8), and a per-check breakdown for a readable report. */
export function scoreDiff(produced, expected, opts = {}) {
  const exp = expected || {};
  const prod = produced || {};

  const fo = fileOverlapScore(prod.filesChanged, exp.filesTouched);
  const mc = mustContainScore(prod.containsByFile, exp.mustContain);
  const rh = rawHexScore(prod.containsByFile, exp.noRawHexInComponents);
  const tc = testCountDeltaScore(prod.testCountDelta, exp.testCountDelta);
  const cv = conventionsScore(prod.containsByFile, exp.conventionsClean, opts.lintSources);

  const checks = [
    { name: 'file-overlap', pass: fo.score >= 0.5, detail: fo.detail, score: +fo.score.toFixed(3) },
    { name: 'must-contain', pass: mc.score === 1, detail: mc.detail, score: +mc.score.toFixed(3) },
    { name: 'no-raw-hex-in-components', pass: rh.score === 1, detail: rh.detail, score: rh.score },
    { name: 'test-count-delta', pass: tc.score === 1, detail: tc.detail, score: tc.score },
    { name: 'conventions', pass: cv.score === 1, detail: cv.detail, score: cv.score },
  ];

  const score =
    WEIGHTS.fileOverlap * fo.score +
    WEIGHTS.mustContain * mc.score +
    WEIGHTS.noRawHexInComponents * rh.score +
    WEIGHTS.testCountDelta * tc.score +
    WEIGHTS.conventions * cv.score;

  return { score: +score.toFixed(3), pass: score >= PASS_BAR, checks };
}

/** Roll a batch of per-ticket `scoreDiff` results (each `{ key, score, pass, checks }`)
 * into a run-level summary for the CLI/CI to report. `worst` lists failed keys, lowest
 * score first. */
export function summarizeEval(results) {
  const list = results || [];
  const failed = list.filter((r) => !r.pass);
  const worst = [...failed].sort((a, b) => a.score - b.score).map((r) => r.key);
  return {
    total: list.length,
    passed: list.length - failed.length,
    failed: failed.length,
    worst,
  };
}

/** Parse a unix/git diff patch into the `produced` shape scoreDiff expects: which
 * files changed, +/- line counts, the added lines per file (for mustContain/hex
 * checks), and a test-count delta approximated by counting added vs removed
 * `it(`/`test(` declarations. Pure text processing — no filesystem access. */
export function parseUnixDiff(patchText) {
  const lines = (patchText || '').split('\n');
  const filesChanged = [];
  const containsByFile = {};
  let additions = 0;
  let deletions = 0;
  let addedTestDecls = 0;
  let removedTestDecls = 0;
  let currentFile = null;
  const TEST_DECL_RE = /\b(it|test)\s*\(/;

  const addFile = (file) => {
    if (file && !filesChanged.includes(file)) filesChanged.push(file);
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      currentFile = m ? m[2] : null;
      addFile(currentFile);
      continue;
    }
    if (line.startsWith('--- ')) continue; // old-file header, not a removed line
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      if (path !== '/dev/null') {
        currentFile = path.startsWith('b/') ? path.slice(2) : path;
        addFile(currentFile);
      }
      continue;
    }
    if (line.startsWith('@@')) continue; // hunk header
    if (line.startsWith('+')) {
      additions++;
      const content = line.slice(1);
      if (currentFile) (containsByFile[currentFile] ??= []).push(content);
      if (TEST_DECL_RE.test(content)) addedTestDecls++;
      continue;
    }
    if (line.startsWith('-')) {
      deletions++;
      if (TEST_DECL_RE.test(line.slice(1))) removedTestDecls++;
      continue;
    }
  }

  return {
    filesChanged,
    additions,
    deletions,
    containsByFile,
    testCountDelta: addedTestDecls - removedTestDecls,
  };
}
