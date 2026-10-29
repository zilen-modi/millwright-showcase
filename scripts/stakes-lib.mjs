// Pure escalation/stakes classification — no filesystem, no I/O — so it's unit-testable
// with vitest. Given the files a change touches and the added lines it introduces,
// decides how much blast radius/risk the change carries and whether it needs a human
// sign-off before shipping, even if every other gate is green.
//
// Seeds come from conventions.md's accumulated lessons (a11y-contrast) and the shared
// component-kit layout (styles/tokens/, sensitive-domain paths).

const SEVERITY_RANK = { low: 0, elevated: 1, high: 2 };

/** Tokens whose kit-wide consumption gives even a small edit a wide blast radius —
 * enumerated consumers, not just the token file itself. Seeded from conventions.md's
 * "shared-token change" lesson; extend here as more kit-wide tokens are learned. */
const SHARED_TOKEN_NAMES = ['skeleton-background', 'border-interactive', 'interactive'];

/** Known contrast-risky tokens (conventions.md "Design fidelity vs. judgement"): binding
 * or altering these — by name or by the hex Figma resolves them to — must never ship
 * silently, even when it "matches Figma". */
const A11Y_RISKY_TOKENS = {
  'text-disabled': { hexes: ['#161616'], detail: '#161616 @25% alpha fails WCAG AA and is invisible in dark theme' },
  'tag-red': { hexes: [], detail: 'light-theme pair measures 3.46:1, below WCAG AA' },
};

const SENSITIVE_DOMAIN_RE =
  /(^|[\\/])(auth|login|session|password|payment|billing|pricing|checkout|invoice|legal|terms|gdpr|consent|permission|role|token-store|migration|schema)([\\/]|\.|$)|\.sql$/i;

const SECURITY_RE =
  /dangerouslySetInnerHTML|\beval\s*\(|access-control-allow-origin|\bcors\b|content-security-policy|\bcsp\b|\bsecret\b|api[_-]?key|client[_-]?secret|password\s*[:=]|auth(?:orization)?[_-]?token\s*[:=]/i;

const TOKENS_DIR_RE = /(^|[\\/])styles[\\/]tokens[\\/]/i;

/** True for a component's own main file (PascalCase.tsx/.ts) as opposed to its
 * styles/stories/tests/variants — the surface a "public API" change would live in. */
function isComponentMainFile(file) {
  return /[\\/][A-Z][A-Za-z0-9]*\.tsx?$/.test(file) && !/\.(stories|test|spec|cva)\.tsx?$/.test(file);
}

const PUBLIC_API_RE = /export\s+(interface|type|const|function|class)\b/;

/** Build a set of regexes that match a token name however it shows up in source: the
 * literal kebab-case name, an SCSS/CSS custom-property form, or its camelCase JS form. */
function tokenNamePatterns(name) {
  const camel = name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
  return [new RegExp(`\\b${name}\\b`, 'i'), new RegExp(`--${name}\\b`, 'i'), new RegExp(`\\b${camel}\\b`)];
}

function linesMatchToken(addedLines, name) {
  const patterns = tokenNamePatterns(name);
  return addedLines.some((line) => patterns.some((re) => re.test(line)));
}

/** Classify the stakes of a change from the files it touches and the lines it adds.
 * Returns `{level, reasons, requiresEscalation}` — `level` is the max severity across
 * `reasons` (each `{code, detail}`); `requiresEscalation` is true whenever any reason is
 * HIGH, or a shared-token change also touches a component's public API. */
export function classifyStakes({ files = [], addedLines = [] } = {}) {
  const fileList = Array.isArray(files) ? files : [];
  const lines = Array.isArray(addedLines) ? addedLines : [];
  const reasons = [];

  // shared-token — wide blast radius. Editing the token definition itself is the
  // widest radius (every consumer changes at once); consuming/rebinding a shared token
  // in a component is still risky but more contained.
  const tokenFileHits = fileList.filter((f) => TOKENS_DIR_RE.test(f));
  const tokenNameHits = SHARED_TOKEN_NAMES.filter((name) => linesMatchToken(lines, name));
  if (tokenFileHits.length) {
    reasons.push({
      code: 'shared-token',
      detail: `token definition file(s) changed (${tokenFileHits.join(', ')}) — every consumer is affected`,
      severity: 'high',
    });
  } else if (tokenNameHits.length) {
    reasons.push({
      code: 'shared-token',
      detail: `rebinds kit-wide token(s) consumed by many components: ${tokenNameHits.join(', ')}`,
      severity: 'elevated',
    });
  }

  // a11y-contrast — a known-risky token bound/altered anywhere in the diff.
  const a11yHits = Object.entries(A11Y_RISKY_TOKENS).filter(
    ([name, { hexes }]) => linesMatchToken(lines, name) || hexes.some((hex) => lines.some((l) => l.includes(hex))),
  );
  for (const [name, { detail }] of a11yHits) {
    reasons.push({ code: 'a11y-contrast', detail: `binds/alters "${name}" — ${detail}`, severity: 'high' });
  }

  // sensitive-domain — the file path itself is in a high-stakes area.
  const sensitiveFileHits = fileList.filter((f) => SENSITIVE_DOMAIN_RE.test(f));
  if (sensitiveFileHits.length) {
    reasons.push({
      code: 'sensitive-domain',
      detail: `touches sensitive-domain path(s): ${sensitiveFileHits.join(', ')}`,
      severity: 'high',
    });
  }

  // security — added lines touching secrets/CORS/CSP/dangerouslySetInnerHTML/eval.
  const securityLineHits = lines.filter((l) => SECURITY_RE.test(l));
  if (securityLineHits.length) {
    reasons.push({
      code: 'security',
      detail: `added line(s) touch secrets/CORS/CSP/dangerouslySetInnerHTML/eval (${securityLineHits.length} line(s))`,
      severity: 'high',
    });
  }

  const level = reasons.reduce((max, r) => (SEVERITY_RANK[r.severity] > SEVERITY_RANK[max] ? r.severity : max), 'low');

  const hasHigh = reasons.some((r) => r.severity === 'high');
  const sharedTokenElevated = reasons.some((r) => r.code === 'shared-token' && r.severity === 'elevated');
  const touchesPublicApi = fileList.some(isComponentMainFile) && lines.some((l) => PUBLIC_API_RE.test(l));
  const requiresEscalation = hasHigh || (sharedTokenElevated && touchesPublicApi);

  return {
    level,
    reasons: reasons.map(({ code, detail }) => ({ code, detail })),
    requiresEscalation,
  };
}

/** One-line, human-readable summary of a `classifyStakes` result for logs/CLI output. */
export function summarizeStakes({ level, reasons, requiresEscalation } = {}) {
  if (!reasons || reasons.length === 0) return 'low — no risk signals';
  const codes = reasons.map((r) => r.code).join(', ');
  const flag = requiresEscalation ? ' — REQUIRES ESCALATION' : '';
  return `${String(level).toUpperCase()}${flag} (${codes}): ${reasons[0].detail}`;
}
