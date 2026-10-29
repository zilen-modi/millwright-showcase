# UX-flow — usability loop

A second, orthogonal check on top of visual-diff (VISUAL-DIFF.md): visual-diff catches
"does it *look* right"; this loop catches "does it *work* right" — can a real user
actually operate the flow with a keyboard, does focus go somewhere sane, does escape
get you out, do error states let you recover. Like visual-diff, this script only
**scores** pre-collected results — it does not drive a browser itself (no Playwright
dependency); driving the browser is the orchestrator's job, via its Figma/browser MCP
tools.

## 1. Drive the flow in a real browser

For each story/flow the plan calls out, the reviewer (orchestrator, via MCP) opens the
rendered story and works through it like a real user would:

- **Tab** through every interactive element in order; confirm nothing is skipped and
  nothing traps focus.
- Confirm the currently-focused element has a **visible** focus indicator at every step.
- Press **Escape** on any dismissible surface (modal, popover, menu) and confirm it
  closes and focus returns somewhere sensible.
- Inspect the accessibility tree (or `aria-*` attributes) to confirm interactive
  elements expose the **roles** their behaviour implies (button, dialog, listbox, etc).
- Follow every path through the flow to confirm there's no **dead end** — no state the
  user can land in with no visible way forward or back.
- Trigger an **error** (bad input, a forced failure) and confirm the user can recover
  without a full reload/reset.

## 2. Record one pass/fail per required check

Each item above maps to one entry of `config.ux.requiredChecks`:
`keyboard-operable`, `focus-visible`, `escape-closes`, `roles-correct`,
`no-dead-ends`, `error-recoverable`. Record a plain `{ [checkName]: boolean }` map —
a check that wasn't actually exercised should be **left out**, not guessed at; `scoreFlow`
treats a missing check as a fail rather than letting an untested flow pass silently.

## 3. Score it

```js
import { scoreFlow, flowSummary } from './ux-lib.mjs';

const result = scoreFlow(checkResults, config.ux.requiredChecks, config.ux.target);
console.log(flowSummary(result));
```

`scoreFlow` is **binary-gated** like the Phase 1 rubric's conventions/a11y dimensions:
`score` is the passed/total ratio, but `pass` also requires zero failing required
checks — one hard-failing (or untested) check fails the flow outright even if the score
alone would clear `target`.

## 4. Feed failures into the repair loop

A `failing` entry re-enters the repair loop the same way a visual-diff FAIL does: fix
the named check(s), re-drive the flow, re-score. Don't touch checks that already pass.

## 5. Halt + escalate on legal/pricing copy

If a flow's screens or error/empty states touch **legal or pricing copy** (terms,
consent, GDPR, invoice/checkout/billing copy, etc), **stop and escalate** instead of
auto-fixing the wording — reuse the Phase-2 stakes gate
(`scripts/stakes-lib.mjs`'s `classifyStakes`, whose `SENSITIVE_DOMAIN_RE` already covers
`legal`/`pricing`/`billing`/`checkout`/`invoice`/`terms`/`consent`/`gdpr`) so the same
"needs a human" verdict fires here that fires on a code diff touching those paths. A
usability fix is safe to ship on its own; a copy change in a high-stakes domain is not.
