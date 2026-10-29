// Pure classification logic for the escaped-defect trace (Goal A7, contract §6) — no
// filesystem, no git, no network, so it's unit-testable with vitest against fixtures.
// scripts/regression-trace.mjs (the IO half) resolves the real inputs — which files a
// ticket touched (git), the ticket's own text (tickets/<KEY>/ticket.md etc.), and the
// curated escapeAgainst ground truth (eval/golden-set.json) — and hands them to this file
// as plain data.
//
// The question this module answers, per ticket-vs-component pair: "is this a UI-FIDELITY
// DEFECT filed against a component an EARLIER ticket already shipped, or is it new work?"
// It is deliberately narrower than "any bug against an existing component" — GOALS.md's
// A7 goal and "The cost" paragraph are both scoped to *design-fidelity* escapes (font,
// geometry, padding, colour, dark-theme, overflow-a11y-naming), not every functional bug.
// PROJ-3000/3016/3021 ([FUNC][ACCESSIBILITY] keyboard bugs, explicitly "no visual/token
// changes required") and PROJ-3020/2996/3026/2997 (behaviour/story-wiring bugs that
// happen to touch a shipped component) must NOT count — see the fixtures in
// tests/regression-trace-lib.test.mjs for the exact shape of both classes.

// Component directory names that actually exist under
// erp-next-ui-monorepo/packages/erp-next-ui-kit-v2/src/components (checked 2026-08-09).
// Kept as a static reference list — not a live fs read — so this file stays pure; the CLI
// may still verify it against the real repo and note drift.
export const CANONICAL_COMPONENTS = [
  'Accordion', 'Avatar', 'AvatarGroup', 'Breadcrumb', 'Button', 'Callout', 'Checkbox',
  'Combobox', 'DataTable', 'DatePicker', 'DateRangePicker', 'DetailList', 'DetailRow',
  'Divider', 'Dropdown', 'Footer', 'IconButton', 'LoginButton', 'Menu', 'Modal',
  'Multiselect', 'Notification', 'NumberInput', 'PasswordInput', 'RadioButton', 'Schedule',
  'SearchInput', 'SelectableCard', 'Spinner', 'Stepper', 'Tag', 'TagGroup', 'TextArea',
  'TextInput', 'Toggle', 'Tooltip', 'Tree', 'Typography',
];

// Shared design-token files that aren't under src/components/<Name>/ but still belong to
// one component's tokens (e.g. PROJ-3025's dark-colour escape touches
// styles/tokens/_tag.scss, not just Tag.module.scss). Extend as more shared token files
// gain component ownership.
const TOKEN_FILE_COMPONENT_MAP = { tag: 'Tag' };

/** Pull canonical component names out of a blob of file paths (a real git diff's
 * `--name-only` output, or prose that happens to quote paths, e.g. route.md/plan.md).
 * Accepts either an array of path-ish strings or one big string; both are just joined and
 * scanned, since the point is "does this text mention a components/<Name>/ path anywhere",
 * not that it's a well-formed path list. */
export function componentsFromFilePaths(pathsOrText, canonical = CANONICAL_COMPONENTS) {
  const text = Array.isArray(pathsOrText) ? pathsOrText.join('\n') : String(pathsOrText || '');
  const canonicalLower = new Map(canonical.map((c) => [c.toLowerCase(), c]));
  const found = new Set();

  const dirRe = /(?:src\/components|stories\/Components|tests\/components)\/([A-Za-z][A-Za-z0-9]*)\//g;
  for (const m of text.matchAll(dirRe)) {
    const hit = canonicalLower.get(m[1].toLowerCase());
    if (hit) found.add(hit);
  }

  const tokenRe = /styles\/tokens\/_([a-zA-Z0-9]+)\.scss/g;
  for (const m of text.matchAll(tokenRe)) {
    const mapped = TOKEN_FILE_COMPONENT_MAP[m[1].toLowerCase()];
    if (mapped) found.add(mapped);
  }

  return [...found].sort();
}

/** Fallback component detection from a ticket title alone (no file-path signal at all —
 * e.g. a ticket that never got as far as BUILD). Builds a `\bTag[\s-]*Group\b`-shaped
 * regex per canonical name so "Radio button", "radio-button" and "RadioButton" all hit
 * the same canonical name. Lower-confidence than path-based extraction: callers should
 * treat this as a secondary signal, not attribute a shipped component to it. */
export function componentsFromTitle(title, canonical = CANONICAL_COMPONENTS) {
  const t = String(title || '');
  // Longest name first, and skip a shorter name whose match range is already covered by a
  // longer match — otherwise "Radio button" (a RadioButton title) also lights up the
  // unrelated "Button" component, because "button" appears as its own word inside it.
  const ordered = [...canonical].sort((a, b) => b.length - a.length);
  const claimed = [];
  const found = new Set();
  for (const name of ordered) {
    const m = aliasRegexFor(name).exec(t);
    if (!m) continue;
    const start = m.index;
    const end = start + m[0].length;
    if (claimed.some(([s, e]) => start < e && end > s)) continue;
    found.add(name);
    claimed.push([start, end]);
  }
  return [...found].sort();
}

function aliasRegexFor(name) {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const pattern = spaced.split(' ').map(escapeRegExp).join('[\\s-]*');
  // Allow a plural on the whole alias ("Tags", "Radio buttons") — Jira titles use plurals
  // casually and this is just component-name detection, not a precise NLP task.
  return new RegExp(`\\b${pattern}s?\\b`, 'i');
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract the ticket's Jira "Type" (Story / Sub-Bug / Bug / Task / ...) from ticket.md's
 * free-form header. Ticket.md has at least three header layouts across the 25 real
 * tickets (`**Type:** Story`, `**Type** · Sub-Bug`, and a bare `Sub-Bug · Backlog · ...`
 * metadata line with no "Type" label at all) — all three are tried in order. Returns
 * `null` when ticket.md is missing/doesn't say (some tickets, e.g. PROJ-2832, PROJ-2908,
 * have no ticket.md at all — a data gap, not a "Story" default). */
export function extractTicketType(ticketMd) {
  if (!ticketMd) return null;
  const labelled = [
    /\*\*Type:?\*\*\s*[·|:]?\s*([A-Za-z][A-Za-z-]*)/i,
    /\bType\b\s*[·|:]\s*([A-Za-z][A-Za-z-]*)/i,
  ];
  for (const re of labelled) {
    const m = ticketMd.match(re);
    if (m) return normalizeType(m[1]);
  }
  // Unlabelled metadata line: "Sub-Bug · Backlog · Medium · ..." right after the title.
  const lines = ticketMd.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 4)) {
    const m = line.match(/^\**\(?\s*(Story|Sub-Bug|Bug|Task|Feature|Epic)\b/i);
    if (m) return normalizeType(m[1]);
  }
  return null;
}
function normalizeType(t) {
  return t.trim().replace(/[.:]+$/, '');
}

// Sections worth reading for "is this describing a design-fidelity defect" — the defect's
// own account of the problem. Deliberately EXCLUDES "## Design" and its siblings
// (Related/Sibling/Open questions/Linked issues/Subtasks/Signals for routing): those
// sections routinely quote the parent ticket's Figma node IDs for context on EVERY
// sub-bug of that parent (see PROJ-3026 and PROJ-3021, which both list Figma nodes in
// "## Design" while describing a pure behaviour bug) — including them would make "mentions
// Figma" nearly universal and useless as a signal.
const INCLUDE_SECTION_RE =
  /^(summary|problem|goal|acceptance criteria|actual|expected|actual result|expected result|actual vs\.? expected|raw description|steps to reproduce|repro(?:duction)?)/i;

/** Reduce a ticket.md (or any similarly-shaped markdown blob) to just the text that
 * describes the defect itself: the title, any preamble before the first "## " header, and
 * sections whose header matches INCLUDE_SECTION_RE. Returns lowercased text (this module
 * only ever regex-matches it, never displays it). Pure string processing — no fs. */
export function extractDescriptionText(ticketMd) {
  if (!ticketMd) return '';
  const lines = String(ticketMd).split('\n');
  const parts = [lines[0] || ''];
  let include = true;
  let buf = [];
  const flush = () => {
    if (include) parts.push(buf.join('\n'));
    buf = [];
  };
  for (let i = 1; i < lines.length; i++) {
    const h = lines[i].match(/^##\s+(.*)$/);
    if (h) {
      flush();
      include = INCLUDE_SECTION_RE.test(h[1].trim());
      continue;
    }
    buf.push(lines[i]);
  }
  flush();
  return parts.join('\n').toLowerCase();
}

const FIGMA_RE = /\bfigma\b/i;
const VISUAL_RE =
  /\b(padding|margin|colou?rs?|font(?:-family)?|typograph\w*|geometry|width|height|spacing|border(?:s|-width)?|contrast|radius|alignment|shadow|opacity|size)\b/i;
const MISMATCH_RE = /\b(mismatch(?:es)?|discrepanc\w*|doesn'?t match|does not match|different from|inconsistent with)\b/i;
const NEW_WORK_TYPE_RE = /\b(story|task|feature|epic)\b/i;

/** The core, explainable classifier: given a ticket's Jira type and its (already
 * section-filtered) description text, decide whether it reads as a design-fidelity
 * defect — as opposed to net-new work, or a purely functional/behavioural/a11y-keyboard
 * bug with no visual claim at all. Every branch returns `reasons` so a human can see (and
 * argue with) exactly why.
 *
 * Deliberately conservative: requires an explicit "Figma" mention (so it never flags a
 * ticket that has no stated design reference at all) AND either a visual-property word or
 * an explicit mismatch phrase (so a ticket that merely CITES Figma for context, e.g. every
 * sub-bug's inherited "## Design" node list, doesn't count on that alone — see
 * extractDescriptionText, which already strips that section out before this ever runs). */
export function classifyFidelityDefect({ type, descriptionText } = {}) {
  const reasons = [];
  if (type && NEW_WORK_TYPE_RE.test(type)) {
    reasons.push(`ticket type "${type}" reads as net-new work, not a defect report`);
    return { isFidelityDefect: false, reasons };
  }

  const text = descriptionText || '';
  if (!FIGMA_RE.test(text)) {
    reasons.push(
      'no "Figma" reference in the defect description (title/summary/AC/actual-expected, excluding the ' +
        'boilerplate Design section) — cannot confirm a design-fidelity mismatch from this text alone',
    );
    return { isFidelityDefect: false, reasons };
  }

  const visualHit = VISUAL_RE.exec(text);
  const mismatchHit = MISMATCH_RE.exec(text);
  if (!visualHit && !mismatchHit) {
    reasons.push('mentions Figma but no visual-property or mismatch language in the defect description');
    return { isFidelityDefect: false, reasons };
  }

  reasons.push('defect description mentions "Figma"' +
    (visualHit ? ` + visual-property term "${visualHit[0]}"` : '') +
    (mismatchHit ? ` + mismatch phrase "${mismatchHit[0]}"` : ''));
  if (type) reasons.push(`ticket type "${type}" is a defect report, not new work`);
  return { isFidelityDefect: true, reasons };
}

function ticketNum(key) {
  const m = /(\d+)\s*$/.exec(String(key || ''));
  return m ? Number(m[1]) : 0;
}

/** For every component, find its SHIPPER: the earliest merged ticket that touched it.
 * Ordering uses the ticket's numeric Jira key, not parsed timestamps — this project's keys
 * were issued in increasing order over real time (verified against actual merge-commit
 * dates in the target repo for every ticket in this trace), and status.json's `mergedAt`
 * is inconsistently formatted/present across tickets (date-only, full ISO, or absent
 * entirely — see PROJ-2832, which has no status.json at all). Ticket-number order is the
 * more robust of the two, and is stated here so a human can dispute the assumption.
 * `tickets`: [{ key, merged: boolean, components: string[] }]. */
export function buildComponentShipMap(tickets) {
  const merged = (tickets || [])
    .filter((t) => t.merged)
    .slice()
    .sort((a, b) => ticketNum(a.key) - ticketNum(b.key));

  const shipMap = new Map();
  for (const t of merged) {
    for (const component of t.components || []) {
      if (!shipMap.has(component)) {
        shipMap.set(component, { component, shippedBy: t.key });
      }
    }
  }
  return shipMap;
}

/** The full trace: for every (ticket, component) pair where the ticket is NOT that
 * component's shipper and comes chronologically after it, decide escape/not — combining
 * curated ground truth (`goldenByKey[key].escapeAgainst`, from eval/golden-set.json, which
 * the task treats as a first-class local data source, not just a test oracle) with the
 * independent lexical heuristic above. Golden ground truth always wins when present (it's
 * a human's read of the actual defect); the heuristic is what generalizes to tickets the
 * golden set has never seen. Both are recorded per escape so disagreement is visible.
 *
 * `tickets`: [{ key, merged, components, type, descriptionText, rubricScore }]
 * `goldenByKey`: { [key]: { escapeAgainst?, lesson? } } */
export function traceRegressions({ tickets = [], goldenByKey = {} } = {}) {
  const shipMap = buildComponentShipMap(tickets);
  const byComponent = new Map();
  for (const { component, shippedBy } of shipMap.values()) {
    byComponent.set(component, { component, shippedBy, escapes: [], nonEscapes: [] });
  }
  // Tickets that ship at least one component elsewhere in this pass (e.g. PROJ-2908
  // shipping Combobox also touches Menu/Multiselect for keyboard-parity reasons as part
  // of the SAME build). Treat those side-touches as constructive/parity work, not a
  // defect report, for the heuristic path — golden-set ground truth still overrides this
  // if a curator has explicitly said otherwise.
  const shipperKeys = new Set([...shipMap.values()].map((v) => v.shippedBy));

  const considered = [];
  for (const t of tickets) {
    for (const component of t.components || []) {
      const shipInfo = shipMap.get(component);
      if (!shipInfo) continue; // no known shipper for this component — nothing to escape against
      if (shipInfo.shippedBy === t.key) continue; // this ticket IS the shipper
      if (ticketNum(t.key) <= ticketNum(shipInfo.shippedBy)) continue; // not chronologically later

      const golden = goldenByKey[t.key];
      const goldenMatches = Boolean(golden?.escapeAgainst) && golden.escapeAgainst === component;
      const isShipperElsewhere = shipperKeys.has(t.key);
      const heuristic = isShipperElsewhere
        ? { isFidelityDefect: false, reasons: [`${t.key} ships a different component in this same pass — its touch on "${component}" reads as parity/side-effect work, not a defect report`] }
        : classifyFidelityDefect({ type: t.type, descriptionText: t.descriptionText });

      const isEscape = goldenMatches || heuristic.isFidelityDefect;
      const reasons = [];
      let source = null;
      if (goldenMatches) {
        source = heuristic.isFidelityDefect ? 'golden+heuristic' : 'golden-only';
        reasons.push(
          `golden-set curated ground truth: escapeAgainst="${component}"` +
            (golden.lesson ? ` — ${golden.lesson}` : ''),
        );
      }
      if (heuristic.isFidelityDefect) {
        if (!source) source = 'heuristic-only';
        reasons.push(...heuristic.reasons);
      } else if (!goldenMatches) {
        reasons.push(...heuristic.reasons);
      }

      const entry = {
        key: t.key,
        component,
        shippedBy: shipInfo.shippedBy,
        isEscape,
        source,
        reasons,
        // The heuristic's OWN verdict for this (ticket, component) pair, context-aware
        // (post shipper-suppression) but independent of golden-set ground truth — kept
        // separate from `isEscape` so a caller can measure the heuristic's accuracy
        // against golden-set without the golden signal contaminating the comparison.
        heuristicFired: heuristic.isFidelityDefect,
      };
      considered.push(entry);
      (isEscape ? byComponent.get(component).escapes : byComponent.get(component).nonEscapes).push(entry);
    }
  }

  const escapeEntries = considered.filter((e) => e.isEscape);
  const escapedKeys = new Set(escapeEntries.map((e) => e.key));
  const shipped = tickets.filter((t) => t.merged).length;
  const escaped = escapedKeys.size;

  return {
    shipped,
    escaped,
    escapedDefectRate: shipped ? round3(escaped / shipped) : 0,
    byComponent: [...byComponent.values()].map((c) => ({
      component: c.component,
      shippedBy: c.shippedBy,
      escapes: c.escapes.map((e) => e.key),
      nonEscapes: c.nonEscapes.map((e) => e.key),
    })),
    escapeDetails: escapeEntries,
    consideredDetails: considered,
    escapedKeys: [...escapedKeys],
  };
}

/** Correlate rubricScore against escape status. Deliberately reports both directions:
 * (1) the shipper's own score for components that later escaped — this is the number
 * GOALS.md's "cost" paragraph is actually about ("rubric reported >=0.965... while these
 * were later filed as defects") — and (2) among tickets that DO carry a recorded score,
 * whether escape-fix tickets score any differently from clean ones. Reports `null` means
 * (not zero) rather than hiding a missing-data problem inside an average. */
export function correlateRubricEscapes({ tickets = [], byComponent = [] } = {}) {
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  const escapedComponents = byComponent.filter((c) => c.escapes.length > 0);

  const shipperScores = escapedComponents.map((c) => ({
    component: c.component,
    shippedBy: c.shippedBy,
    rubricScore: byKey.get(c.shippedBy)?.rubricScore ?? null,
  }));

  const escapeKeySet = new Set(escapedComponents.flatMap((c) => c.escapes));
  const scored = tickets.filter((t) => typeof t.rubricScore === 'number');
  const escapeScored = scored.filter((t) => escapeKeySet.has(t.key));
  const cleanScored = scored.filter((t) => !escapeKeySet.has(t.key));

  const mean = (arr) => (arr.length ? round3(arr.reduce((s, t) => s + t.rubricScore, 0) / arr.length) : null);

  return {
    shipperScoresForEscapedComponents: shipperScores,
    shippersMissingScore: shipperScores.filter((s) => s.rubricScore == null).map((s) => s.shippedBy),
    ticketsWithRubricScore: scored.length,
    ticketsMissingRubricScore: tickets.length - scored.length,
    escapeFixTickets: { count: escapeScored.length, meanScore: mean(escapeScored), scores: escapeScored.map((t) => ({ key: t.key, score: t.rubricScore })) },
    cleanTickets: { count: cleanScored.length, meanScore: mean(cleanScored), scores: cleanScored.map((t) => ({ key: t.key, score: t.rubricScore })) },
  };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}
