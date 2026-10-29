// Pure conventions linter (Goal A5, GOALS.md). No fs — sources are provided by the
// caller (scripts/conventions-lint.mjs is the IO/CLI wrapper; loop.mjs and eval-lib.mjs
// are the two live consumers wired in docs/INTEGRATION-CONTRACTS.md §4). Every rule
// here traces to a line in conventions.md; this file is the mechanical version of what
// was previously a self-reported integer.
//
// `lintSources(sources, opts) -> { count, violations }`, `sources` = `[{ path, text }]`,
// each `violations[]` entry = `{ rule, file, line, detail }`. `opts.branch` runs
// branch-name-shape; `opts.addedLinesOnly` marks that `text` is diff-extracted added
// lines (line numbers are best-effort, not real file lines) rather than a whole file —
// callers set it so a reader of a report knows not to trust `line` too literally.
//
// False positives are the expensive failure mode here (this now gates real builds and
// the eval harness), so every rule that can plausibly fire on prose-about-code instead
// of code itself (no-raw-hex, no-figma-refs, no-tool-branding) is scoped through the
// shared comment/test-title helpers below rather than a raw substring/line match.

// ---- shared comment-position helper ----

/**
 * Split `text` into per-line records describing which part of each line is CODE vs
 * COMMENT, tracking `/* ... *\/` block state across line boundaries. Does NOT track
 * string literals (a `//`/`/*` inside a string constant would be misclassified as a
 * comment start) — an accepted, documented limitation. Erring toward "ambiguous text
 * reads as comment" is the safer direction for the rules that are only SUPPOSED to fire
 * inside comments (no-raw-hex must NOT fire there); it merely under-fires on the rare
 * rule that wants code, never over-fires and blocks a build on prose.
 */
export function classifyLines(text) {
  const rawLines = (text ?? '').split('\n');
  const out = [];
  let inBlock = false;
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    let code = '';
    let comment = '';
    let idx = 0;
    while (idx < raw.length) {
      if (inBlock) {
        const end = raw.indexOf('*/', idx);
        if (end === -1) {
          comment += raw.slice(idx);
          idx = raw.length;
        } else {
          comment += raw.slice(idx, end + 2);
          idx = end + 2;
          inBlock = false;
        }
        continue;
      }
      const lineIdx = raw.indexOf('//', idx);
      const blockIdx = raw.indexOf('/*', idx);
      if (lineIdx === -1 && blockIdx === -1) {
        code += raw.slice(idx);
        idx = raw.length;
        continue;
      }
      if (blockIdx !== -1 && (lineIdx === -1 || blockIdx < lineIdx)) {
        code += raw.slice(idx, blockIdx);
        inBlock = true;
        idx = blockIdx;
        continue;
      }
      code += raw.slice(idx, lineIdx);
      comment += raw.slice(lineIdx);
      idx = raw.length;
    }
    out.push({ lineNumber: i + 1, raw, code, comment });
  }
  return out;
}

// `it(`/`test(`/`describe(` (and `.only`/`.skip`) string-literal titles — the other
// place, besides comments, that a Figma reference or tool-branding string can hide
// without being a real code identifier.
function extractTestTitles(rawLine) {
  const titles = [];
  const re = /\b(?:it|test|describe)(?:\.(?:only|skip))?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
  let m;
  while ((m = re.exec(rawLine))) titles.push(m[2]);
  return titles;
}

/** For every line in every source, gather the "prose" regions a comment-or-test-title
 * rule is allowed to look at: the comment portion (if non-empty) and any test-title
 * string literals on that line. Shared by no-figma-refs and no-tool-branding so neither
 * re-implements line-level substring matching. */
function commentAndTitleRegions(sources) {
  const regions = [];
  for (const { path, text } of sources) {
    for (const line of classifyLines(text)) {
      if (line.comment.trim()) regions.push({ path, lineNumber: line.lineNumber, kind: 'comment', text: line.comment });
      for (const title of extractTestTitles(line.raw)) {
        regions.push({ path, lineNumber: line.lineNumber, kind: 'test title', text: title });
      }
    }
  }
  return regions;
}

// ---- rules ----

// #rgb / #rrggbb — matches eval-lib.mjs's RAW_HEX_RE so the two hard-hex checks agree.
const HEX_RE = /#[0-9a-f]{3,6}\b/gi;
// Style/script files only — hex in JSON/markdown/etc. is out of scope for this rule.
const STYLE_EXT_RE = /\.(scss|css|less|ts|tsx|js|jsx)$/i;
// Token-DEFINITION files legitimately bind a literal hex to a name (that's their job);
// e.g. packages/erp-next-ui-kit-v2/src/styles/tokens/_tag.scss. Anything with "token"/
// "tokens" as a path or filename component is excluded from this rule.
const TOKEN_FILE_RE = /\btokens?\b/i;
// A real false positive found running this over shipped code: wizardFocus.scss.test.ts
// asserts `background-color: #000000` to verify a TOKEN resolves to the expected
// compiled value — conventions.md itself expects "every token test" to be updated
// when a token's hex changes, so asserting a resolved literal in a spec is the point of
// the test, not an unbound color. Test files are excluded from this rule specifically
// (other rules — e.g. no-figma-refs in a test title — still apply to them).
const TEST_FILE_RE = /\.(test|spec)\.[a-z]+$|(^|\/)(tests|__tests__)\//i;

/** `no-raw-hex` — a literal `#rgb`/`#rrggbb` in a real declaration/value position.
 * Never fires inside a `//` or `/* *\/` comment (that's documentation, not a binding —
 * see the Multiselect.module.scss fixture in the test suite), never in a
 * token-definition file, and never in a test file (asserting a resolved value, not
 * binding one). */
function noRawHex(sources) {
  const violations = [];
  for (const { path, text } of sources) {
    if (!STYLE_EXT_RE.test(path) || TOKEN_FILE_RE.test(path) || TEST_FILE_RE.test(path)) continue;
    for (const line of classifyLines(text)) {
      const matches = line.code.match(/#[0-9a-f]{3,6}\b/gi);
      if (!matches) continue;
      for (const hex of matches) {
        violations.push({
          rule: 'no-raw-hex',
          file: path,
          line: line.lineNumber,
          detail: `raw hex ${hex} in a declaration — bind a design token instead of a literal color value.`,
        });
      }
    }
  }
  return violations;
}

const FIGMA_WORDS_RE = /\bfigma\b|\bspec node\b|\bper figma\b/i;
// Figma node id shapes: "3091-1058" or "1346:2928".
const FIGMA_NODE_ID_RE = /\b\d{2,6}[-:]\d{2,6}\b/;

function findFigmaRefs(str) {
  const hits = [];
  const wordHit = str.match(FIGMA_WORDS_RE);
  if (wordHit) hits.push(wordHit[0]);
  const idHit = str.match(FIGMA_NODE_ID_RE);
  if (idHit) hits.push(idHit[0]);
  return hits;
}

/** `no-figma-refs` — "Figma", "spec node", "per Figma", or a raw node id, but ONLY
 * inside a comment or a test title (conventions.md: "state the fact without the
 * citation" — the rule is about where the design intent came from, not about banning
 * the word in, say, a URL constant or a variable named `figmaExportUrl`). */
function noFigmaRefs(sources) {
  const violations = [];
  for (const region of commentAndTitleRegions(sources)) {
    for (const hit of findFigmaRefs(region.text)) {
      violations.push({
        rule: 'no-figma-refs',
        file: region.path,
        line: region.lineNumber,
        detail: `Figma reference "${hit}" in a ${region.kind} — state the fact without the citation (no Figma name, node id, or "per Figma").`,
      });
    }
  }
  return violations;
}

const BRANDING_RE = /\bautopilot\b|🤖|generated with|co-authored-by/i;

function findBranding(str) {
  const m = str.match(BRANDING_RE);
  return m ? [m[0]] : [];
}

/** `no-tool-branding` — "Autopilot", 🤖, "Generated with…", "Co-authored-by" in a
 * comment or test title. Mirror image of no-figma-refs: same shared regions, same
 * "only where prose can hide, not any code identifier" scoping. */
function noToolBranding(sources) {
  const violations = [];
  for (const region of commentAndTitleRegions(sources)) {
    for (const hit of findBranding(region.text)) {
      violations.push({
        rule: 'no-tool-branding',
        file: region.path,
        line: region.lineNumber,
        detail: `tool branding ("${hit}") in a ${region.kind} — write as a developer on the team would, no bot signature or "Generated with…".`,
      });
    }
  }
  return violations;
}

const TODO_FIXME_RE = /\b(TODO|FIXME)\b/;

/** `no-todo-fixme` — TODO/FIXME anywhere in shipped source (conventions.md doesn't
 * scope this to comments only, and in practice TODO/FIXME almost always live in one). */
function noTodoFixme(sources) {
  const violations = [];
  for (const { path, text } of sources) {
    const lines = (text ?? '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(TODO_FIXME_RE);
      if (!m) continue;
      violations.push({
        rule: 'no-todo-fixme',
        file: path,
        line: i + 1,
        detail: `${m[1]} found in shipped source — track deferrals in the ticket/PR, not the source.`,
      });
    }
  }
  return violations;
}

/** `comment-max-3-lines` — a `//` comment BLOCK (every line in the run is nothing but a
 * `//` comment — not a trailing inline comment after code) longer than 3 consecutive
 * lines. Deliberately `//`-only per conventions.md; JSDoc-style `/** *\/` blocks are a
 * different convention and out of scope here. */
function commentMax3Lines(sources) {
  const violations = [];
  for (const { path, text } of sources) {
    let blockStart = null;
    let blockLen = 0;
    const flush = () => {
      if (blockStart !== null && blockLen > 3) {
        violations.push({
          rule: 'comment-max-3-lines',
          file: path,
          line: blockStart,
          detail: `// comment block spans ${blockLen} lines (max 3) — trim to one concise line covering the non-obvious why.`,
        });
      }
      blockStart = null;
      blockLen = 0;
    };
    for (const line of classifyLines(text)) {
      const isSlashCommentOnly = line.code.trim() === '' && line.comment.trim().startsWith('//');
      if (isSlashCommentOnly) {
        if (blockStart === null) blockStart = line.lineNumber;
        blockLen++;
      } else {
        flush();
      }
    }
    flush();
  }
  return violations;
}

// .../components/<Name>/(components|hooks)/... — a component directory containing its
// own nested components/ or hooks/ subfolder, not the top-level components/ dir itself.
const NESTED_STRUCTURE_RE = /\/components\/[^/]+\/(components|hooks)\//;

/** `flat-component-structure` — a `components/` or `hooks/` subdirectory nested inside
 * a component's own directory. One violation per offending path (structural, not
 * line-based — `line` is null). */
function flatComponentStructure(sources) {
  const violations = [];
  for (const { path } of sources) {
    const m = NESTED_STRUCTURE_RE.exec(path);
    if (!m) continue;
    violations.push({
      rule: 'flat-component-structure',
      file: path,
      line: null,
      detail: `nested "${m[1]}/" subdirectory inside a component dir — flatten to match sibling components (no components/ or hooks/ subfolders).`,
    });
  }
  return violations;
}

// {type}/PROJ-{n}-{kebab-desc} — e.g. fix/PROJ-2996-tag-iconleft-control.
const BRANCH_SHAPE_RE = /^[a-z]+\/PROJ-\d+-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `branch-name-shape` — only runs when a branch name is supplied (CLI `--branch`, or
 * `opts.branch` to `lintSources`); silent otherwise, per contract §4 ("only with
 * `--branch`"). */
function branchNameShape(branch) {
  if (!branch) return [];
  if (BRANCH_SHAPE_RE.test(branch)) return [];
  return [
    {
      rule: 'branch-name-shape',
      file: branch,
      line: null,
      detail: `branch "${branch}" does not match {type}/PROJ-{n}-{kebab-desc} (e.g. fix/PROJ-3016-tag-icon) — rename before opening the PR.`,
    },
  ];
}

/** Run every conventions.md rule (docs/INTEGRATION-CONTRACTS.md §4) over `sources`.
 * `sources` = `[{ path, text }]`. `opts.branch` additionally runs branch-name-shape;
 * `opts.addedLinesOnly` and `opts.repoRoot` are accepted (both live consumers pass one
 * or the other) but don't change detection — they document what `text`/`path` mean to
 * the caller, not to the rules. Returns `{ count, violations }`, each violation
 * `{ rule, file, line, detail }`. */
/**
 * Lint prose that is about to be published under a human's name - a PR comment body.
 *
 * `lintSources` cannot do this job: `noToolBranding` scans only `commentAndTitleRegions`,
 * i.e. `//` comment text and test titles. A markdown body has neither, so a body reading
 * "Autopilot found..." passes it green. Here the branding regex runs over EVERY line.
 *
 * Only `no-tool-branding` applies. Two rules are deliberately excluded:
 *
 * - `no-figma-refs`: a PR comment is exactly where a design citation belongs. Naming the
 *   Figma frame or node the finding came from is how the author checks it, so "Figma" and a
 *   node id are allowed here and nowhere else - `lintSources` still blocks both in code.
 * - `no-todo-fixme`: a finding may legitimately report that the diff left a TODO behind, and
 *   blocking the comment for saying so would be wrong.
 */
export function lintProse(text, { path = 'pr-comment.md' } = {}) {
  const violations = [];
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const hit of findBranding(line)) {
      violations.push({
        rule: 'no-tool-branding',
        file: path,
        line: i + 1,
        detail: `tool branding ("${hit}") in text meant for a PR comment - write as a developer on the team would.`,
      });
    }
  }
  return { count: violations.length, violations };
}

export function lintSources(sources, opts = {}) {
  const list = Array.isArray(sources) ? sources.filter((s) => s && typeof s.path === 'string' && typeof s.text === 'string') : [];
  const violations = [
    ...noRawHex(list),
    ...noFigmaRefs(list),
    ...noTodoFixme(list),
    ...commentMax3Lines(list),
    ...flatComponentStructure(list),
    ...noToolBranding(list),
    ...branchNameShape(opts.branch),
  ];
  return { count: violations.length, violations };
}

/** Reshape a unix/git diff patch into `[{ path, text }]` where `text` is just the
 * ADDED lines of that file, newline-joined (no hunk/line-number metadata — the CLI's
 * `--diff` mode passes `addedLinesOnly: true` to `lintSources` alongside this so
 * consumers know reported `line` numbers are best-effort, not real file lines). Pure
 * text processing, no filesystem access. */
export function sourcesFromUnixDiff(patchText) {
  const lines = (patchText ?? '').split('\n');
  const byFile = new Map();
  let currentFile = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      currentFile = null;
      continue;
    }
    if (line.startsWith('--- ')) continue;
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      currentFile = p === '/dev/null' ? null : p.startsWith('b/') ? p.slice(2) : p;
      if (currentFile && !byFile.has(currentFile)) byFile.set(currentFile, []);
      continue;
    }
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+')) {
      if (currentFile) byFile.get(currentFile).push(line.slice(1));
      continue;
    }
  }
  return [...byFile.entries()].map(([path, addedLines]) => ({ path, text: addedLines.join('\n') }));
}
