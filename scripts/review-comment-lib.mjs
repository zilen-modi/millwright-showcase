// Turns an LLM-authored `pr-reviews/<ref>/review.md` (structure varies run to run) into
// a plain, unbranded, developer-voiced PR comment body. Pipeline: extractFindings (parse)
// -> scrubInternals (de-jargon) -> renderPrComment (render); bodyFits guards the size cap.

/**
 * @typedef {Object} Finding
 * @property {string} text - the finding's own description, inline `code` refs kept as-is.
 * @property {string|null} fix - the suggested fix (a "-> ..." line), glyph stripped, or
 *   null when the source finding didn't carry one.
 */

/**
 * @typedef {Object} FindingBuckets
 * @property {Finding[]} high
 * @property {Finding[]} medium
 * @property {Finding[]} low
 */

const SEVERITY_WORD_MAP = { critical: 'high', high: 'high', medium: 'medium', low: 'low', grill: 'grill' };

// Broad emoji strip used only for BUCKET-HEADING classification (a heading can be
// prefixed by any status/severity emoji, not just the fixed set scrubInternals rewrites
// in rendered copy). Covers the common emoji blocks plus the variation-selector.
const GENERIC_EMOJI_RE = /[\u{2190}-\u{2BFF}\u{1F000}-\u{1FFFF}️]/gu;

/** Strip emoji/leading "N." numbering from a `###` heading (or a bare "**High**" line)
 * and decide whether the leftover text opens with a severity word. Handles three real
 * shapes: a bare bucket word ("High", "🟡 Medium"), a bucket word followed by unrelated
 * decoration ("Grill (deep correctness...)"), and an inline-tagged per-finding heading
 * ("1. [MEDIUM · dry] Roving-focus boilerplate..." - the bracket tag IS the bucket, and
 * whatever follows it is that one finding's own title). Returns `null` when the heading
 * isn't a severity bucket at all (e.g. "Verdict", "Verified clean"). */
function classifySeverityText(raw) {
  let t = String(raw ?? '')
    .replace(GENERIC_EMOJI_RE, '')
    .trim();
  t = t.replace(/^\d+\.\s*/, '').trim();
  if (!t) return null;

  const bracket = t.match(/^\[([^\]]*)\]\s*(.*)$/);
  let word;
  let leftoverTitle;
  if (bracket) {
    word = (bracket[1].split(/[\s·:,-]+/).filter(Boolean)[0] || '').toLowerCase();
    leftoverTitle = bracket[2].trim();
  } else {
    const m = t.match(/^(\w+)\b\s*(.*)$/);
    word = m ? m[1].toLowerCase() : '';
    leftoverTitle = m ? m[2].trim() : '';
  }

  const severity = SEVERITY_WORD_MAP[word];
  if (!severity) return null;
  return { severity, leftoverTitle };
}

/** Detect and strip a bullet-level inline severity tag ("**[medium]**", "[MEDIUM · dry]")
 * that overrides whatever bucket it's nested under. Returns the original text unchanged
 * when no recognizable tag is found (e.g. "[clean - verified]" - not a severity word). */
function stripInlineTag(text) {
  const str = String(text ?? '');
  const m = str.match(/^(\*{0,2})\[([^\]]+)\](\*{0,2})\s*(.*)$/);
  if (!m) return { severity: null, rest: str };
  const word = (m[2].split(/[\s·:,-]+/).filter(Boolean)[0] || '').toLowerCase();
  const severity = SEVERITY_WORD_MAP[word];
  if (!severity || severity === 'grill') return { severity: null, rest: str };
  let rest = m[4];
  // `**[medium] Lead text** detail` opens its bold BEFORE the tag, so stripping the tag takes
  // the opener with it and leaves an orphan `**` mid-sentence. Re-open the bold so the lead
  // still renders as a lead instead of shipping unbalanced markdown to a PR.
  const openedBold = m[1] === '**' && m[3] !== '**';
  if (openedBold && (rest.match(/\*\*/g) || []).length % 2 === 1) rest = `**${rest}`;
  return { severity, rest };
}

function findH2Headings(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##(?!#)\s*(.*)$/);
    if (m) out.push({ index: i, title: m[1].trim() });
  }
  return out;
}

function findH3Headings(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^###(?!#)\s*(.*)$/);
    if (m) out.push({ index: i, title: m[1].trim() });
  }
  return out;
}

// A bold line with nothing else on it ("**High**", "**Verified clean:**") acts like a
// `###` heading for bucket purposes: classifySeverityText decides open-bucket vs reset.
const BOLD_LINE_ONLY_RE = /^\*\*([^*]+?)\*\*:?\s*$/;
const ARROW_LINE_RE = /^→\s*(.*)$/;
const DASH_BULLET_RE = /^-\s+(.*)$/;
const NUMBERED_BULLET_RE = /^(?:\*\*)?\d+\.\s*(.*)$/;

/** Find a recommendation line: prefer an inline `**Recommendation:**` sentence inside
 * the findings section itself (the common case), else fall back to a standalone
 * `## Recommendation` section anywhere in the document. Returns `null` when neither
 * shape is present - callers should not invent one. */
function extractRecommendation(fullText, sectionLines) {
  const inlineRe = /^\*\*Recommendation:?\*\*:?\s*(.*)$/i;
  for (const line of sectionLines) {
    const m = line.trim().match(inlineRe);
    if (m && m[1].trim()) return m[1].trim();
  }

  const lines = fullText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Recommendation\b/i.test(lines[i])) {
      const body = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^#{1,6}\s/.test(lines[j])) break;
        if (lines[j].trim()) body.push(lines[j].trim());
      }
      const text = body.join(' ').trim();
      if (text) return text;
    }
  }

  for (const line of lines) {
    const m = line.trim().match(inlineRe);
    if (m && m[1].trim()) return m[1].trim();
  }

  return null;
}

/** Tolerantly parse an LLM-authored review.md into severity buckets. Locates the first
 * `##` heading matching /findings/i (else falls back to the first `##` at all, warning
 * about it), then walks its `###` sub-headings (and bare "**High**"-style bold lines) as
 * severity buckets, and its `- `/numbered bullets as individual findings. An inline
 * bracket tag on a bullet or a numbered heading ("[MEDIUM · dry] ...") always overrides
 * the enclosing bucket. Content that looks like a finding but can't be classified is
 * reported in `unclassified` UNLESS no bucket was ever found anywhere in the section, in
 * which case classification itself is deemed unreliable and only a warning is raised
 * (never a pile of unclassified noise) - see PROJ-808-shaped inputs with no findings
 * section at all. */
export function extractFindings(reviewMd) {
  const text = String(reviewMd ?? '');
  const lines = text.split(/\r?\n/);
  const warnings = [];
  const buckets = { high: [], medium: [], low: [] };

  const h2 = findH2Headings(lines);
  if (h2.length === 0) {
    warnings.push('No "##" section headings found in the review; cannot locate a findings section.');
    return { buckets, recommendation: extractRecommendation(text, []), unclassified: [], warnings };
  }

  let chosen = h2.find((h) => /findings/i.test(h.title));
  if (!chosen) {
    chosen = h2[0];
    warnings.push(`No "##" heading matched /findings/i; used the first section ("${chosen.title}") as a fallback.`);
  }

  const chosenPos = h2.indexOf(chosen);
  const sectionStart = chosen.index + 1;
  const sectionEnd = chosenPos + 1 < h2.length ? h2[chosenPos + 1].index : lines.length;
  const sectionLines = lines.slice(sectionStart, sectionEnd);
  const h3 = findH3Headings(sectionLines);
  const h3Indexes = new Set(h3.map((h) => h.index));

  let bucketDefaultSeverity = null;
  let sawAnyBucket = false;
  let current = null;
  const strayCandidates = [];

  const commit = () => {
    if (!current) return;
    const finding = current;
    current = null;
    const finText = finding.textParts.join(' ').replace(/\s+/g, ' ').trim();
    if (!finText) return;
    const fix = finding.fixParts.length ? finding.fixParts.join(' ').replace(/\s+/g, ' ').trim() : null;
    const severity = finding.severityOverride || finding.bucketDefaultSeverity;
    if (severity === 'high' || severity === 'medium' || severity === 'low') {
      buckets[severity].push({ text: finText, fix });
    } else {
      strayCandidates.push(finText);
    }
  };

  const startFinding = (rest) => {
    const { severity: tagSeverity, rest: cleanedRest } = stripInlineTag(rest);
    current = {
      severityOverride: tagSeverity,
      bucketDefaultSeverity,
      textParts: [cleanedRest],
      fixParts: [],
    };
  };

  const openBucket = (severity, leftoverTitle) => {
    sawAnyBucket = true;
    bucketDefaultSeverity = severity === 'grill' ? 'medium' : severity;
    if (severity !== 'grill' && leftoverTitle) {
      // The heading itself IS the one finding (e.g. "1. [MEDIUM · dry] Title...").
      current = { severityOverride: null, bucketDefaultSeverity, textParts: [leftoverTitle], fixParts: [] };
    } else {
      current = null;
    }
  };

  for (let i = 0; i < sectionLines.length; i++) {
    const raw = sectionLines[i];

    if (h3Indexes.has(i)) {
      commit();
      const heading = raw.match(/^###(?!#)\s*(.*)$/)[1].trim();
      const cls = classifySeverityText(heading);
      if (cls) openBucket(cls.severity, cls.leftoverTitle);
      else {
        bucketDefaultSeverity = null;
        current = null;
      }
      continue;
    }

    const trimmed = raw.trim();
    if (!trimmed) continue;

    const boldOnly = trimmed.match(BOLD_LINE_ONLY_RE);
    if (boldOnly) {
      commit();
      const cls = classifySeverityText(boldOnly[1]);
      if (cls) openBucket(cls.severity, cls.leftoverTitle);
      else {
        bucketDefaultSeverity = null;
        current = null;
      }
      continue;
    }

    const arrowMatch = trimmed.match(ARROW_LINE_RE);
    if (arrowMatch) {
      if (current) current.fixParts.push(arrowMatch[1].trim());
      continue;
    }

    const dashMatch = trimmed.match(DASH_BULLET_RE);
    const numMatch = !dashMatch ? trimmed.match(NUMBERED_BULLET_RE) : null;
    if (dashMatch || numMatch) {
      commit();
      startFinding(dashMatch ? dashMatch[1] : numMatch[1]);
      continue;
    }

    // Plain continuation text attaches to the currently open finding; narrative prose
    // before any bullet/heading has nothing to attach to and is intentionally ignored.
    if (current) current.textParts.push(trimmed);
  }
  commit();

  const unclassified = sawAnyBucket ? strayCandidates : [];
  if (!sawAnyBucket) {
    warnings.push(
      `No severity buckets (high/medium/low/critical) could be identified inside "${chosen.title}"; returning empty findings.`,
    );
  }

  return {
    buckets,
    recommendation: extractRecommendation(text, sectionLines),
    unclassified,
    warnings,
  };
}

const AGENT_NAME_RE = /\b(?:quality-agent|review-agent|coder-agent|verifier-agent|intake-agent|router-agent)\b/i;
const IDENTITY_LINE_RE = /\bidentity\b.*\b(?:author|reviewer|authenticated)\b/i;
const LINE_DELETE_RE = new RegExp(
  [
    AGENT_NAME_RE.source,
    '\\bcodeQualityScore\\b',
    '\\brubric\\b',
    '\\bvisualDiff\\w*\\b',
    '\\breport-only\\b',
    '\\bunmeasured\\b',
  ].join('|'),
  'i',
);

const PATH_PREFIX_RE = /\b(?:millwright|autopilot)\//g;
const DUP_SCAN_RE = /\bdup-scan(?:-report)?(?:\.\w+)?\b|\bjscpd\b/gi;
const CONVENTIONS_LINT_RE = /\bconventions-lint(?:\.mjs)?\b/gi;
// Status/severity emoji that show up verbatim in review.md prose; stripped from any
// rendered copy so a human-posted comment never carries pipeline-status iconography.
const SEVERITY_STATUS_EMOJI_RE = /[\u{1F534}\u{1F7E1}\u{1F7E2}⚪✅\u{1F512}\u{1F916}]/gu;

/** Anything left over after Tier 1's mechanical substitutions/deletions that still
 * reads as internal tooling jargon - a caller reuses this to gate posting until a human
 * edits the flagged line. Deliberately narrow (bare internal-only nouns) so it doesn't
 * false-positive on ordinary code tokens like a CSS custom property named `--cell-min-width`. */
export const INTERNAL_JARGON_RE = /\b(?:worktree|playbook|resolve-ticket|millwright|autopilot|orchestrator)\b/i;

/** Tier-1 mechanical scrub (safe substitutions + whole-line deletions of internal-only
 * content) plus Tier-2 detection: anything still matching `INTERNAL_JARGON_RE` after
 * Tier 1 is reported in `unresolved` with its (1-based, pre-deletion) line number rather
 * than silently rewritten - this module does not attempt clever sentence surgery. */
export function scrubInternals(text) {
  const input = String(text ?? '');
  const lines = input.split(/\r?\n/);
  const unresolved = [];
  const outLines = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (LINE_DELETE_RE.test(raw) || IDENTITY_LINE_RE.test(raw)) continue;

    let line = raw;
    line = line.replace(PATH_PREFIX_RE, '');
    line = line.replace(DUP_SCAN_RE, 'a duplication scan');
    line = line.replace(CONVENTIONS_LINT_RE, "the repo's lint rules");
    line = line.replace(SEVERITY_STATUS_EMOJI_RE, '');
    // conventions.md's external-output rule: human-visible text uses " - ", not an em dash.
    line = line.replace(/\s*\u2014\s*/g, ' - ');
    line = line.replace(/ {2,}/g, ' ').replace(/[ \t]+$/, '');

    const jargonHit = line.match(INTERNAL_JARGON_RE);
    if (jargonHit) unresolved.push({ line: i + 1, hit: jargonHit[0] });

    outLines.push(line);
  }

  return { text: outLines.join('\n'), unresolved };
}

const SEVERITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };

/** Render the selected severity buckets as a plain developer-voiced PR comment body: an
 * unbranded opening line, one `**Label**` section per selected severity with one `- `
 * bullet per finding (file:line refs stay as inline code, a fix becomes a nested
 * `- Suggested: ...` sub-bullet), then the recommendation if one exists. Returns `''`
 * when the selected severities contain zero findings - never fabricates an "LGTM". */
export function renderPrComment({ buckets = {}, severities = [], recommendation = null } = {}) {
  const sections = [];

  for (const sev of severities) {
    const label = SEVERITY_LABEL[sev];
    if (!label) continue;
    const findings = Array.isArray(buckets?.[sev]) ? buckets[sev] : [];
    const bulletLines = [];
    for (const finding of findings) {
      const title = String(finding?.text ?? '').trim();
      if (!title) continue;
      bulletLines.push(`- ${title}`);
      if (finding?.fix) bulletLines.push(`  - Suggested: ${String(finding.fix).trim()}`);
    }
    if (bulletLines.length === 0) continue;
    sections.push(`**${label}**\n${bulletLines.join('\n')}`);
  }

  if (sections.length === 0) return '';

  const parts = ['A few things worth a look before merge:', ...sections];
  const recText = String(recommendation ?? '').trim();
  if (recText) parts.push(recText);

  return parts.join('\n\n');
}

const BODY_BYTE_LIMIT = 65536;

/** GitHub PR-comment bodies cap at 65536 bytes, measured in UTF-8 - not JS string
 * `.length`, which undercounts every non-ASCII character (arrows, curly quotes, emoji)
 * a review comment is full of. */
export function bodyFits(text) {
  const bytes = Buffer.byteLength(String(text ?? ''), 'utf8');
  return { ok: bytes <= BODY_BYTE_LIMIT, bytes, limit: BODY_BYTE_LIMIT };
}
