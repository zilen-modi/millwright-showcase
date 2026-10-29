/**
 * ValidationTour browser sweep — 44 scenarios against a running Storybook.
 *
 *   node scripts/validation-tour-sweep.mjs            # expects Storybook on :6013
 *   VT_SWEEP_BASE=http://localhost:6012 node scripts/validation-tour-sweep.mjs
 *
 * Exits non-zero when anything fails, so it can gate a run.
 * Drives the real Storybook in headless Chromium so
 * requestAnimationFrame and ResizeObserver actually run (the in-app preview pane pauses
 * both while hidden, which masks exactly the bugs this is looking for).
 *
 * Every check is isolated: a throw is recorded as a FAIL and the sweep continues, because
 * the deliverable is the full list of what's broken, not the first thing that breaks.
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const AXE_PATH =
  process.env.VT_SWEEP_AXE ??
  '~/workspace/.wt/PROJ-2910-erp-next-ui-monorepo/node_modules/axe-core/axe.min.js';

const ORIGIN = process.env.VT_SWEEP_BASE ?? 'http://localhost:6013';
const BASE = `${ORIGIN}/iframe.html?viewMode=story&id=`;
const STORY = {
  transfer: 'components-validationtour--transfer-order',
  business: 'components-validationtour--business-form-validation',
  accordions: 'components-validationtour--fields-in-accordions',
};

const results = [];
let current = null;

const check = async (name, fn) => {
  current = { name, status: 'pass', detail: '' };
  try {
    await fn();
  } catch (error) {
    current.status = 'fail';
    current.detail = String(error.message ?? error).split('\n').slice(0, 4).join(' ').slice(0, 400);
  }
  results.push(current);
  const mark = current.status === 'pass' ? '  ok  ' : ' FAIL ';
  console.log(`${mark} ${name}${current.detail ? `\n         ${current.detail}` : ''}`);
};

const note = (detail) => {
  if (current) current.detail = current.detail ? `${current.detail} | ${detail}` : detail;
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const eq = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
};

// ── page helpers ────────────────────────────────────────────────────────────────
const open = async (page, id) => {
  await page.goto(BASE + id, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('form', { timeout: 15000 });
  await page.waitForTimeout(250);
};

const submit = async (page) => {
  await page.getByRole('button', { name: /^save/i }).first().click();
  await page.waitForTimeout(250);
};

/** The summary panel's rows — scoped to the list that sits beside the fix action. */
const panelRows = (page) =>
  page.evaluate(() => {
    const action = [...document.querySelectorAll('button')].find((b) =>
      /fix error/i.test(b.textContent ?? ''),
    );
    const panel = action?.closest('div')?.parentElement ?? action?.parentElement;
    const list = panel?.querySelector('ol');
    return list ? [...list.querySelectorAll('li')].map((li) => li.textContent.trim()) : [];
  });

const startTour = async (page) => {
  await page.getByRole('button', { name: /fix error/i }).click();
  await page.waitForSelector('.driver-popover', { timeout: 10000 });
  await page.waitForTimeout(400);
};

const tour = (page) =>
  page.evaluate(() => {
    const pop = document.querySelector('.driver-popover');
    if (!pop) return { open: false };
    const desc = pop.querySelector('.driver-popover-description');
    return {
      open: true,
      title: pop.querySelector('.driver-popover-title')?.textContent?.trim() ?? '',
      description: desc?.textContent?.trim() ?? '',
      bullets: desc ? [...desc.querySelectorAll('li')].map((li) => li.textContent.trim()) : [],
      progress: pop.querySelector('.driver-popover-progress-text')?.textContent?.trim() ?? '',
    };
  });

const clickNext = async (page) => {
  await page.click('.driver-popover-next-btn');
  await page.waitForTimeout(400);
};

const clickPrev = async (page) => {
  await page.click('.driver-popover-prev-btn');
  await page.waitForTimeout(400);
};

/** The highlight cutout: driver.js punches a rounded rect out of its overlay path. */
const cutout = (page) =>
  page.evaluate(() => {
    const path = document.querySelector('.driver-overlay path')?.getAttribute('d');
    if (!path) return null;
    const m = path.match(/M([\d.]+),([\d.]+) h([\d.]+).*?v([\d.]+)/s);
    return m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4] } : null;
  });

/** Which field the current step is on, taken from the step's own element. */
const activeField = (page) =>
  page.evaluate(() => {
    const actives = [...document.querySelectorAll('.driver-active-element')];
    // The class accumulates on every visited element, so prefer the one the popover points at.
    const pop = document.querySelector('.driver-popover');
    if (!pop || !actives.length) return null;
    const popBox = pop.getBoundingClientRect();
    let best = null;
    let bestGap = Infinity;
    for (const el of actives) {
      const b = el.getBoundingClientRect();
      const gap = Math.min(
        Math.abs(b.top - popBox.bottom),
        Math.abs(popBox.top - b.bottom),
        Math.abs(b.left - popBox.right),
        Math.abs(popBox.left - b.right),
      );
      if (gap < bestGap) {
        bestGap = gap;
        best = el;
      }
    }
    return best
      ? {
          fieldId: best.getAttribute('data-error-field'),
          rect: (({ x, y, width, height }) => ({ x, y, width, height }))(best.getBoundingClientRect()),
        }
      : null;
  });

const fieldBox = (page, fieldId) =>
  page.evaluate((id) => {
    const el = document.querySelector(`[data-error-field="${id}"]`);
    if (!el) return null;
    const { x, y, width, height } = el.getBoundingClientRect();
    return { x, y, width, height };
  }, fieldId);

const inlineError = (page, fieldId) =>
  page.evaluate((id) => {
    const wrap = document.querySelector(`[data-error-field="${id}"]`);
    if (!wrap) return null;
    const texts = [
      ...new Set(
        [...wrap.querySelectorAll('div,span,p')]
          .map((e) => e.textContent.trim())
          .filter((t) => t && t.length < 120),
      ),
    ];
    return texts[texts.length - 1] ?? null;
  }, fieldId);

const openListboxes = (page) => page.locator('[role="listbox"]').count();
const openCalendars = (page) => page.locator('.flatpickr-calendar.open').count();
const openMenuCount = async (page) => (await openListboxes(page)) + (await openCalendars(page));

// ── the sweep ───────────────────────────────────────────────────────────────────
const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.log(`   [page error] ${String(e).slice(0, 200)}`));

  const toTransferTour = async () => {
    await open(page, STORY.transfer);
    await submit(page);
    await startTour(page);
  };

  const walkTo = async (fieldId) => {
    for (let i = 0; i < 12; i++) {
      const f = await activeField(page);
      if (f?.fieldId === fieldId) return true;
      await clickNext(page);
    }
    return false;
  };

  // ══ A. summary panel ══════════════════════════════════════════════════════════
  console.log('\n── A. summary panel');

  await check('A1 no summary panel before the first submit', async () => {
    await open(page, STORY.transfer);
    eq(await page.locator('button', { hasText: /fix error/i }).count(), 0, 'panels visible');
  });

  await check('A2 submit lists every invalid field', async () => {
    await submit(page);
    const rows = await panelRows(page);
    note(`${rows.length} rows`);
    assert(rows.length >= 9, `only ${rows.length} rows`);
    assert(
      rows.some((r) => /From Branch/.test(r)),
      'From Branch missing from the panel',
    );
  });

  await check('A3 a fixed field drops off the panel', async () => {
    const before = await panelRows(page);
    await page.click('[data-error-field="fromBranch"] input');
    await page.waitForTimeout(200);
    await page.getByRole('option', { name: /METHUEN/ }).click();
    await page.waitForTimeout(400);
    const after = await panelRows(page);
    note(`${before.length} → ${after.length} rows`);
    assert(
      !after.some((r) => /From Branch/.test(r)),
      'From Branch still listed after being fixed',
    );
    eq(after.length, before.length - 1, 'row count');
  });

  await check('A4 the fixed field shows no inline error', async () => {
    const text = await inlineError(page, 'fromBranch');
    assert(!/is required/.test(text ?? ''), `inline error still reads "${text}"`);
  });

  // ══ B. tour lifecycle ═════════════════════════════════════════════════════════
  console.log('\n── B. tour lifecycle');

  await check('B1 the panel action opens the tour on the first unresolved field', async () => {
    await open(page, STORY.transfer);
    await submit(page);
    await startTour(page);
    const t = await tour(page);
    note(`${t.progress} — ${t.title}`);
    assert(t.open, 'no popover');
    eq(t.title, 'From Branch', 'first step title');
    assert(/1 of \d+/.test(t.progress), `progress reads "${t.progress}"`);
  });

  await check('B2 the popover quotes the field message', async () => {
    const t = await tour(page);
    const inline = await inlineError(page, 'fromBranch');
    note(`popover "${t.description}" vs field "${inline}"`);
    assert(
      inline?.includes(t.description) || t.description.includes('is required'),
      'popover and field disagree',
    );
  });

  await check('B3 Next advances a step', async () => {
    await clickNext(page);
    const t = await tour(page);
    note(`${t.progress} — ${t.title}`);
    assert(/2 of/.test(t.progress), `progress reads "${t.progress}"`);
  });

  await check('B4 Previous goes back a step', async () => {
    await clickPrev(page);
    const t = await tour(page);
    note(`${t.progress} — ${t.title}`);
    assert(/1 of/.test(t.progress), `progress reads "${t.progress}"`);
  });

  await check('B5 the close button ends the tour', async () => {
    await page.click('.driver-popover-close-btn');
    await page.waitForTimeout(500);
    eq(await page.locator('.driver-popover').count(), 0, 'popover count');
  });

  await check('B6 closing mid-fix brings the summary back', async () => {
    const rows = await panelRows(page);
    note(`${rows.length} rows`);
    assert(rows.length > 0, 'summary did not return');
  });

  await check('B7 Escape ends the tour', async () => {
    await startTour(page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    eq(await page.locator('.driver-popover').count(), 0, 'popover count');
  });

  await check('B8 a click on the dim overlay ends the tour', async () => {
    await startTour(page);
    await page.mouse.click(20, 700);
    await page.waitForTimeout(500);
    eq(await page.locator('.driver-popover').count(), 0, 'popover count');
  });

  // ══ C. focus ══════════════════════════════════════════════════════════════════
  console.log('\n── C. focus');

  await check('C1 focus lands inside the highlighted field', async () => {
    await open(page, STORY.transfer);
    await submit(page);
    await startTour(page);
    const inside = await page.evaluate(() => {
      const wrap = document.querySelector('[data-error-field="fromBranch"]');
      return !!wrap && wrap.contains(document.activeElement);
    });
    assert(inside, `focus is on ${await page.evaluate(() => document.activeElement?.tagName)}`);
  });

  await check('C2 focus cannot escape the highlighted field', async () => {
    await page.evaluate(() => {
      document.querySelector('[data-error-field="quantity"] input')?.focus();
    });
    await page.waitForTimeout(200);
    const stillInside = await page.evaluate(() => {
      const wrap = document.querySelector('[data-error-field="fromBranch"]');
      return !!wrap && wrap.contains(document.activeElement);
    });
    assert(stillInside, 'focus escaped to another field');
  });

  await check('C3 the popover buttons are not tab stops', async () => {
    const idx = await page.evaluate(() =>
      ['next', 'prev', 'close'].map(
        (k) => document.querySelector(`.driver-popover-${k}-btn`)?.tabIndex ?? null,
      ),
    );
    note(`tabIndex next/prev/close = ${idx.join('/')}`);
    assert(
      idx.every((v) => v === -1),
      `expected all -1, got ${idx.join('/')}`,
    );
  });

  // ══ D. keyboard ═══════════════════════════════════════════════════════════════
  console.log('\n── D. keyboard');

  await check('D1 Tab does not advance while the field is still invalid', async () => {
    const before = (await tour(page)).progress;
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);
    const after = (await tour(page)).progress;
    note(`${before} → ${after}`);
    eq(after, before, 'progress');
  });

  await check('D2 Tab advances once the field is fixed', async () => {
    await page.click('[data-error-field="fromBranch"] input');
    await page.waitForTimeout(200);
    await page.getByRole('option', { name: /METHUEN/ }).click();
    await page.waitForTimeout(500);
    const before = (await tour(page)).progress;
    await page.evaluate(() => {
      document.querySelector('[data-error-field="fromBranch"] input')?.focus();
    });
    await page.keyboard.press('Tab');
    await page.waitForTimeout(500);
    const after = (await tour(page)).progress;
    note(`${before} → ${after}`);
    assert(after !== before, `still on ${after}`);
  });

  await check('D3 arrow keys inside the field do not change step', async () => {
    const before = (await tour(page)).progress;
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(300);
    const after = (await tour(page)).progress;
    note(`${before} → ${after}`);
    eq(after, before, 'progress');
  });

  // ══ E. floating surfaces ══════════════════════════════════════════════════════
  console.log('\n── E. floating surfaces');

  const menuClosesOnNext = async (label, fieldId, opener) => {
    await check(`E ${label}: an open menu closes when the tour moves on`, async () => {
      await open(page, STORY.transfer);
      await submit(page);
      await startTour(page);
      // Walk to the step for this field.
      for (let i = 0; i < 12; i++) {
        const f = await activeField(page);
        if (f?.fieldId === fieldId) break;
        await clickNext(page);
      }
      const f = await activeField(page);
      eq(f?.fieldId, fieldId, 'reached the right step');
      await opener();
      await page.waitForTimeout(300);
      const opened = await openMenuCount(page);
      assert(opened > 0, 'the menu never opened, so the check proves nothing');
      await clickNext(page);
      // Scope to THIS field's surface. The tour focuses whatever it lands on next, and a
      // DatePicker opens its own calendar on focus — counting every surface on the page
      // would blame this field for the next one's.
      const left = await page.evaluate((id) => {
        const field = document.querySelector(`[data-error-field="${id}"]`);
        const own = [...document.querySelectorAll('[role="listbox"], .flatpickr-calendar.open')].filter(
          (surface) => {
            if (field?.contains(surface)) return true;
            // Portalled surfaces sit at body level, so match by horizontal overlap with the field.
            const f = field?.getBoundingClientRect();
            const s = surface.getBoundingClientRect();
            return !!f && s.left < f.right && s.right > f.left && Math.abs(s.top - f.bottom) < 120;
          },
        );
        return own.length;
      }, fieldId);
      note(`open before Next = ${opened}, this field's after = ${left}`);
      eq(left, 0, "this field's menu is still open");
    });
  };

  await menuClosesOnNext('combobox', 'toBranch', async () => {
    await page.click('[data-error-field="toBranch"] input');
  });

  await menuClosesOnNext('dropdown', 'shipVia', async () => {
    await page.click('[data-error-field="shipVia"] button');
  });

  await menuClosesOnNext('multiselect', 'handling', async () => {
    await page.click('[data-error-field="handling"] input');
  });

  await check('E4 Tab with a combobox list open closes the list', async () => {
    await open(page, STORY.transfer);
    await page.click('[data-error-field="toBranch"] input');
    await page.waitForTimeout(300);
    assert((await openMenuCount(page)) > 0, 'list never opened');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);
    eq(await openMenuCount(page), 0, 'list still open after Tab');
  });

  // ══ F. highlight geometry ═════════════════════════════════════════════════════
  console.log('\n── F. highlight geometry');

  await check('F1 the cutout covers the highlighted field on every step', async () => {
    await open(page, STORY.transfer);
    await submit(page);
    await startTour(page);
    const bad = [];
    for (let i = 0; i < 10; i++) {
      const t = await tour(page);
      if (!t.open) break;
      const f = await activeField(page);
      const c = await cutout(page);
      if (f && c) {
        const dh = Math.abs(c.h - (f.rect.height + 10));
        if (dh > 2) bad.push(`${t.progress} ${f.fieldId}: cutout ${c.h} vs field ${f.rect.height}`);
      }
      if (!/(\d+) of \1/.test(t.progress.replace(/\s/g, ' '))) await clickNext(page);
      else break;
    }
    note(bad.length ? bad.join(' ; ') : 'all steps matched');
    eq(bad.length, 0, 'steps with a mismatched cutout');
  });

  await check('F2 the cutout tracks a field that grows (multiselect tags wrap)', async () => {
    await open(page, STORY.transfer);
    await submit(page);
    await startTour(page);
    for (let i = 0; i < 12; i++) {
      const f = await activeField(page);
      if (f?.fieldId === 'handling') break;
      await clickNext(page);
    }
    const before = await cutout(page);
    await page.click('[data-error-field="handling"] input');
    await page.waitForTimeout(300);
    for (const name of [/Fragile/, /Hazmat/, /Refrigerated/]) {
      await page.getByRole('option', { name }).click();
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(600);
    const after = await cutout(page);
    const box = await fieldBox(page, 'handling');
    note(`cutout ${before?.h} → ${after?.h}, field ${box?.height}`);
    assert(after.h > before.h, 'cutout did not grow');
    assert(Math.abs(after.h - (box.height + 10)) <= 2, 'cutout does not match the grown field');
  });

  await check('F3 the popover stays clear of the field it points at', async () => {
    const overlap = await page.evaluate(() => {
      const pop = document.querySelector('.driver-popover')?.getBoundingClientRect();
      const el = document.querySelector('[data-error-field="handling"]')?.getBoundingClientRect();
      if (!pop || !el) return null;
      const x = Math.max(0, Math.min(pop.right, el.right) - Math.max(pop.left, el.left));
      const y = Math.max(0, Math.min(pop.bottom, el.bottom) - Math.max(pop.top, el.top));
      return Math.round(x * y);
    });
    note(`overlap area = ${overlap}px²`);
    eq(overlap, 0, 'popover overlaps the field');
  });

  // ══ G. message sync and bullets ═══════════════════════════════════════════════
  console.log('\n── G. message sync and bullets');

  await check('G1 the popover follows the field when its message changes', async () => {
    await open(page, STORY.transfer);
    await submit(page);
    await startTour(page);
    assert(await walkTo('quantity'), 'never reached the quantity step');
    const before = (await tour(page)).description;
    await page.fill('[data-error-field="quantity"] input', '0');
    await page.waitForTimeout(900); // the watcher polls every 300ms
    const after = (await tour(page)).description;
    const inline = await inlineError(page, 'quantity');
    note(`popover "${before}" → "${after}"; field "${inline}"`);
    assert(after !== before, 'popover text never changed');
    assert(inline?.includes(after) || after.includes(inline ?? '#'), 'popover and field disagree');
  });

  await check('G2 several problems at once render one bullet each', async () => {
    await page.fill('[data-error-field="quantity"] input', '-1.5');
    await page.waitForTimeout(900);
    const t = await tour(page);
    note(`bullets: ${JSON.stringify(t.bullets)}`);
    eq(t.bullets.length, 2, 'bullet count');
  });

  await check('G3 the panel and the popover list the same problems', async () => {
    const t = await tour(page);
    await page.click('.driver-popover-close-btn');
    await page.waitForTimeout(500);
    const rows = await panelRows(page);
    const quantityRow = rows.find((r) => /Quantity/.test(r)) ?? '';
    note(`panel "${quantityRow}" vs popover ${JSON.stringify(t.bullets)}`);
    for (const bullet of t.bullets) {
      assert(quantityRow.includes(bullet), `panel is missing "${bullet}"`);
    }
  });

  // ══ H. accordions and focus handback ══════════════════════════════════════════
  console.log('\n── H. accordions and focus handback');

  await check('H1 a collapsed section is expanded before its field is highlighted', async () => {
    await open(page, STORY.transfer);
    // A collapsed accordion keeps its content in the DOM at full height, so presence proves
    // nothing about whether it is open — read the section's own aria-expanded.
    const expanded = () =>
      page.evaluate(() => {
        const section = [...document.querySelectorAll('button')].find(
          (b) => b.textContent.trim() === 'Handling',
        );
        return section?.getAttribute('aria-expanded') ?? null;
      });
    const before = await expanded();
    assert(before === 'false', `Handling was not collapsed to begin with (aria-expanded=${before})`);
    await submit(page);
    await startTour(page);
    const after = await expanded();
    note(`Handling aria-expanded ${before} → ${after}`);
    eq(after, 'true', 'the section holding a tour step');
    assert(await walkTo('handling'), 'never reached the field inside it');
  });

  await check('H2 finishing the tour does not leave focus on the wrong field', async () => {
    await open(page, STORY.transfer);
    await submit(page);
    const before = await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 60));
    await startTour(page);
    for (let i = 0; i < 14; i++) {
      const t = await tour(page);
      if (!t.open) break;
      await clickNext(page);
    }
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      field: document.activeElement?.closest('[data-error-field]')?.getAttribute('data-error-field'),
      tourOpen: !!document.querySelector('.driver-popover'),
    }));
    note(`before ${before} → after ${JSON.stringify(after)}`);
    assert(!after.tourOpen, 'the tour never finished');
    assert(after.tag !== 'BODY', 'focus was dropped on <body>');
  });

  // ══ J. harder cases ══════════════════════════════════════════════════════════
  console.log('\n── J. harder cases');

  const fixCombobox = async (fieldId) => {
    await page.click(`[data-error-field="${fieldId}"] input`);
    await page.waitForTimeout(250);
    await page.getByRole('option').first().click();
    await page.waitForTimeout(400);
  };

  await check('J1 the overlay keeps the user out of every field but the current one', async () => {
    await toTransferTour();
    const reachable = await page.evaluate(() => {
      const input = document.querySelector('[data-error-field="toBranch"] input');
      const r = input.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        isTheInput: top === input,
        pointerEvents: getComputedStyle(input.closest('[data-error-field]')).pointerEvents,
      };
    });
    note(`off-step field pointer-events=${reachable.pointerEvents}, hit-testable=${reachable.isTheInput}`);
    assert(!reachable.isTheInput, 'an off-step field is clickable through the overlay');
  });

  await check('J2 fixing the last field and pressing Tab ends the tour', async () => {
    await toTransferTour();
    // Quantity is the final step; nothing unresolved follows it, so Tab must finish the tour.
    for (let i = 0; i < 12; i++) {
      const f = await activeField(page);
      if (f?.fieldId === 'quantity') break;
      await clickNext(page);
    }
    const at = await tour(page);
    note(`at ${at.progress}`);
    await page.fill('[data-error-field="quantity"] input', '5');
    await page.waitForTimeout(500);
    await page.evaluate(() =>
      document.querySelector('[data-error-field="quantity"] input')?.focus(),
    );
    await page.keyboard.press('Tab');
    await page.waitForTimeout(700);
    const after = await tour(page);
    note(`tour open after Tab = ${after.open}`);
    assert(!after.open, 'the tour stayed open after the last error was fixed');
  });

  await check('J3 Escape with a combobox list open closes the list, not the tour', async () => {
    await toTransferTour();
    for (let i = 0; i < 6; i++) {
      if (/To Branch/.test((await tour(page)).title ?? '')) break;
      await clickNext(page);
    }
    await page.click('[data-error-field="toBranch"] input');
    await page.waitForTimeout(300);
    assert((await openListboxes(page)) > 0, 'the list never opened');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const listboxes = await openListboxes(page);
    const stillTouring = (await tour(page)).open;
    note(`after Escape: listboxes=${listboxes}, tour open=${stillTouring}`);
    eq(listboxes, 0, 'the list stayed open');
    assert(stillTouring, 'Escape ended the whole tour instead of just closing the list');
  });

  await check('J4 Escape with a datepicker calendar open closes the calendar, not the tour', async () => {
    await toTransferTour();
    for (let i = 0; i < 6; i++) {
      if (/Date Required/.test((await tour(page)).title ?? '')) break;
      await clickNext(page);
    }
    await page.waitForTimeout(300);
    const openedByFocus = await openCalendars(page);
    if (!openedByFocus) {
      await page.click('[data-error-field="dateRequired"] input');
      await page.waitForTimeout(300);
    }
    assert((await openCalendars(page)) > 0, 'no calendar open to test with');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const calendars = await openCalendars(page);
    const stillTouring = (await tour(page)).open;
    note(`calendar auto-opened on focus=${!!openedByFocus}; after Escape: calendars=${calendars}, tour open=${stillTouring}`);
    eq(calendars, 0, 'the calendar stayed open');
    assert(stillTouring, 'Escape ended the whole tour instead of just closing the calendar');
  });

  await check('J5 Next closes an open datepicker calendar', async () => {
    await toTransferTour();
    for (let i = 0; i < 6; i++) {
      if (/Date Required/.test((await tour(page)).title ?? '')) break;
      await clickNext(page);
    }
    await page.waitForTimeout(300);
    if (!(await openCalendars(page))) {
      await page.click('[data-error-field="dateRequired"] input');
      await page.waitForTimeout(300);
    }
    assert((await openCalendars(page)) > 0, 'no calendar open to test with');
    await clickNext(page);
    const calendars = await openCalendars(page);
    note(`calendars after Next = ${calendars}`);
    eq(calendars, 0, 'the calendar outlived its step');
  });

  await check('J6 clicking inside the popover does not dismiss the tour', async () => {
    await toTransferTour();
    await page.click('.driver-popover-title');
    await page.waitForTimeout(400);
    assert((await tour(page)).open, 'clicking the popover killed the tour');
  });

  await check('J7 scrolling keeps the popover anchored to its field', async () => {
    await toTransferTour();
    for (let i = 0; i < 8; i++) {
      const f = await activeField(page);
      if (f?.fieldId === 'reason') break;
      await clickNext(page);
    }
    const gapBefore = await page.evaluate(() => {
      const p = document.querySelector('.driver-popover')?.getBoundingClientRect();
      const f = document.querySelector('[data-error-field="reason"]')?.getBoundingClientRect();
      return p && f ? Math.round(p.top - f.top) : null;
    });
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(600);
    const gapAfter = await page.evaluate(() => {
      const p = document.querySelector('.driver-popover')?.getBoundingClientRect();
      const f = document.querySelector('[data-error-field="reason"]')?.getBoundingClientRect();
      return p && f ? Math.round(p.top - f.top) : null;
    });
    note(`popover-to-field offset ${gapBefore} → ${gapAfter}`);
    assert(gapAfter !== null && Math.abs(gapAfter - gapBefore) <= 4, 'the popover drifted from its field');
  });

  await check('J8 the cutout shrinks back when the multiselect loses its tags', async () => {
    await toTransferTour();
    for (let i = 0; i < 10; i++) {
      const f = await activeField(page);
      if (f?.fieldId === 'handling') break;
      await clickNext(page);
    }
    const start = await cutout(page);
    await page.click('[data-error-field="handling"] input');
    await page.waitForTimeout(250);
    for (const name of [/Fragile/, /Hazmat/, /Refrigerated/]) {
      await page.getByRole('option', { name }).click();
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(500);
    const grown = await cutout(page);
    // Remove them again through the tag pills' own close buttons.
    for (let i = 0; i < 3; i++) {
      const pill = page.locator('[data-error-field="handling"] [class*="tagPill"] button').first();
      if (!(await pill.count())) break;
      await pill.click();
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(600);
    const back = await cutout(page);
    const box = await fieldBox(page, 'handling');
    note(`cutout ${start?.h} → ${grown?.h} → ${back?.h}, field now ${box?.height}`);
    assert(grown.h > start.h, 'never grew');
    assert(Math.abs(back.h - (box.height + 10)) <= 2, 'cutout did not follow the field back down');
  });

  await check('J9 radio step: arrow keys still pick an option', async () => {
    await toTransferTour();
    for (let i = 0; i < 8; i++) {
      const f = await activeField(page);
      if (f?.fieldId === 'priority') break;
      await clickNext(page);
    }
    await page.waitForTimeout(300);
    const before = await page.evaluate(
      () => document.querySelectorAll('[data-error-field="priority"] input:checked').length,
    );
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({
      checked: document.querySelectorAll('[data-error-field="priority"] input:checked').length,
      value: document.querySelector('[data-error-field="priority"] input:checked')?.value ?? null,
      progress: document.querySelector('.driver-popover-progress-text')?.textContent?.trim(),
    }));
    note(`checked ${before} → ${after.checked} (${after.value}), ${after.progress}`);
    assert(after.checked > before, 'arrow keys cannot select a radio while the tour is running');
  });

  await check('J10 the tour can be restarted after being closed', async () => {
    await toTransferTour();
    await page.click('.driver-popover-close-btn');
    await page.waitForTimeout(500);
    eq(await page.locator('.driver-popover').count(), 0, 'first tour did not close');
    await startTour(page);
    const t = await tour(page);
    note(`${t.progress} — ${t.title}`);
    assert(t.open, 'the tour would not restart');
  });

  await check('J11 the popover is exposed as a dialog with a name', async () => {
    await toTransferTour();
    const dialog = await page.evaluate(() => {
      const pop = document.querySelector('.driver-popover');
      if (!pop) return null;
      return {
        role: pop.getAttribute('role'),
        labelledby: pop.getAttribute('aria-labelledby'),
        describedby: pop.getAttribute('aria-describedby'),
        ariaLabel: pop.getAttribute('aria-label'),
      };
    });
    note(JSON.stringify(dialog));
    eq(dialog?.role, 'dialog', 'popover role');
    assert(
      dialog.labelledby || dialog.ariaLabel,
      'the dialog has no accessible name (no aria-labelledby / aria-label)',
    );
  });

  await check('J12 rapid Next clicks do not desync the step counter', async () => {
    await toTransferTour();
    for (let i = 0; i < 5; i++) await page.click('.driver-popover-next-btn');
    await page.waitForTimeout(900);
    const t = await tour(page);
    const f = await activeField(page);
    note(`${t.progress} — popover "${t.title}", highlight on "${f?.fieldId}"`);
    assert(t.open, 'the tour died under rapid clicks');
    const stepNumber = Number((t.progress.match(/(\d+) of/) ?? [])[1]);
    eq(stepNumber, 6, 'step after five Next clicks');
  });

  // ══ K. gaps: accessibility, the remaining field types, keyboard, viewport, theme ══
  console.log('\n── K. accessibility, remaining field types, viewport, theme');

  /** Runs axe against a subtree and returns serious/critical violations only. */
  const axeOn = async (selector) => {
    await page.addScriptTag({ content: readFileSync(AXE_PATH, 'utf8') });
    return page.evaluate(async (sel) => {
      if (!document.querySelector(sel)) return { skipped: `${sel} not present` };
      // eslint-disable-next-line no-undef
      const run = await window.axe.run(sel, {
        resultTypes: ['violations'],
        rules: { region: { enabled: false } },
      });
      return {
        violations: run.violations
          .filter((v) => v.impact === 'serious' || v.impact === 'critical')
          .map((v) => `${v.id} (${v.impact}) ×${v.nodes.length}: ${v.help}`),
        allCount: run.violations.length,
      };
    }, selector);
  };

  await check('K1 the tour popover has no serious accessibility violations', async () => {
    await open(page, STORY.transfer);
    await submit(page);
    await startTour(page);
    const result = await axeOn('.driver-popover');
    note(result.skipped ?? `${result.violations.length} serious/critical of ${result.allCount} total`);
    assert(!result.skipped, result.skipped);
    eq(result.violations.length, 0, `violations: ${result.violations.join(' ; ')}`);
  });

  await check('K2 the highlighted field has no serious accessibility violations', async () => {
    const result = await axeOn('[data-error-field="fromBranch"]');
    note(result.skipped ?? `${result.violations.length} serious/critical of ${result.allCount} total`);
    eq(result.violations.length, 0, `violations: ${result.violations.join(' ; ')}`);
  });

  await check('K3 the whole form under a running tour has no serious violations', async () => {
    const result = await axeOn('form');
    note(result.skipped ?? `${result.violations.length} serious/critical of ${result.allCount} total`);
    eq(result.violations.length, 0, `violations: ${result.violations.join(' ; ')}`);
  });

  /** Fix the field the tour is on, then Tab, and report whether the step moved. */
  const resolveThenTab = async (fieldId, fix) => {
    await toTransferTour();
    assert(await walkTo(fieldId), `never reached the ${fieldId} step`);
    const before = (await tour(page)).progress;
    await fix();
    await page.waitForTimeout(600);
    await page.evaluate((id) => {
      const wrap = document.querySelector(`[data-error-field="${id}"]`);
      wrap?.querySelector('input:not([aria-hidden="true"]),textarea')?.focus();
    }, fieldId);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(700);
    const after = await tour(page);
    note(`${before} → ${after.open ? after.progress : 'tour finished'}`);
    assert(
      !after.open || after.progress !== before,
      `Tab did not move on after fixing ${fieldId}`,
    );
  };

  await check('K4 checkbox step: ticking the box lets Tab move on', async () => {
    await resolveThenTab('confirmations', async () => {
      await page.evaluate(() => {
        const box = [...document.querySelectorAll('[data-error-field="confirmations"] input')].find(
          (i) => /manager/i.test(i.closest('label')?.textContent ?? ''),
        );
        box?.click();
      });
    });
  });

  await check('K5 textarea step: typing enough text lets Tab move on', async () => {
    await resolveThenTab('reason', async () => {
      await page.fill(
        '[data-error-field="reason"] textarea',
        'Stock rebalancing between branches after the quarterly count.',
      );
    });
  });

  await check('K6 text input step: a valid value lets Tab move on', async () => {
    await resolveThenTab('invoiceNumber', async () => {
      await page.fill('[data-error-field="invoiceNumber"] input', 'INV-45217');
    });
  });

  await check('K7 Shift+Tab keeps the user on the current step', async () => {
    await toTransferTour();
    const before = (await tour(page)).progress;
    await page.keyboard.press('Shift+Tab');
    await page.waitForTimeout(500);
    const after = await tour(page);
    const insideField = await page.evaluate(() => {
      const wrap = document.querySelector('[data-error-field="fromBranch"]');
      return !!wrap && wrap.contains(document.activeElement);
    });
    note(`${before} → ${after.open ? after.progress : 'closed'}; focus still in the field: ${insideField}`);
    assert(after.open, 'Shift+Tab ended the tour');
    eq(after.progress, before, 'step after Shift+Tab');
  });

  await check('K8 narrow viewport: the popover stays on screen', async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await toTransferTour();
    const fit = await page.evaluate(() => {
      const p = document.querySelector('.driver-popover')?.getBoundingClientRect();
      if (!p) return null;
      return {
        left: Math.round(p.left),
        right: Math.round(p.right),
        top: Math.round(p.top),
        bottom: Math.round(p.bottom),
        vw: window.innerWidth,
        vh: window.innerHeight,
      };
    });
    note(JSON.stringify(fit));
    assert(fit, 'no popover at this size');
    assert(fit.left >= -1 && fit.right <= fit.vw + 1, 'the popover runs off the side');
    assert(fit.top >= -1 && fit.bottom <= fit.vh + 1, 'the popover runs off the top or bottom');
  });

  await check('K9 narrow viewport: the highlight still matches its field', async () => {
    const f = await activeField(page);
    const c = await cutout(page);
    note(`cutout ${c?.h} vs field ${f?.rect.height}`);
    assert(c && f, 'no cutout to compare');
    assert(Math.abs(c.h - (f.rect.height + 10)) <= 2, 'cutout does not match the field');
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await check('K10 dark theme: the popover is themed, not left on light colours', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await open(page, STORY.transfer);
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await submit(page);
    await startTour(page);
    const colours = await page.evaluate(() => {
      const pop = document.querySelector('.driver-popover');
      const cs = getComputedStyle(pop);
      return { background: cs.backgroundColor, color: cs.color };
    });
    note(JSON.stringify(colours));
    // Light theme renders the popover on white; dark must not still be white.
    assert(
      !/^rgba?\(255,\s*255,\s*255/.test(colours.background),
      `popover background stayed light: ${colours.background}`,
    );
  });

  await check('K11 dark theme: no serious contrast violations in the popover', async () => {
    const result = await axeOn('.driver-popover');
    note(result.skipped ?? `${result.violations.length} serious/critical of ${result.allCount} total`);
    eq(result.violations.length, 0, `violations: ${result.violations.join(' ; ')}`);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  });

  await check('K12 the invalid attribute stays stripped after a re-measure', async () => {
    await toTransferTour();
    assert(await walkTo('handling'), 'never reached the multiselect step');
    // Growing the field triggers a re-measure, which re-runs the library's own highlight.
    await page.click('[data-error-field="handling"] input');
    await page.waitForTimeout(250);
    for (const name of [/Fragile/, /Hazmat/, /Refrigerated/]) {
      await page.getByRole('option', { name }).click();
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(700);
    const attrs = await page.evaluate(() => {
      const el = document.querySelector('.driver-active-element');
      return { role: el?.getAttribute('role'), expanded: el?.getAttribute('aria-expanded') };
    });
    note(JSON.stringify(attrs));
    eq(attrs.expanded, null, 'aria-expanded after a re-measure');
    const result = await axeOn('[data-error-field="handling"]');
    eq(result.violations.length, 0, `violations: ${result.violations.join(' ; ')}`);
  });

  // ══ I. the other two stories still work ═══════════════════════════════════════
  console.log('\n── I. the other tour stories');

  for (const [name, id, submitLabel] of [
    ['business form', STORY.business, 'Submit Invoice'],
    ['fields in accordions', STORY.accordions, 'Save Transfer'],
  ]) {
    await check(`I ${name}: submit opens a tour that can be stepped through`, async () => {
      await open(page, id);
      // Both carry a Storybook play function that submits on render, so the tour may
      // already be up; only submit when it isn't.
      await page.waitForTimeout(900);
      if (!(await page.locator('.driver-popover').count())) {
        await page.getByRole('button', { name: submitLabel }).click();
        await page.waitForTimeout(600);
        const hasPanel = (await page.locator('button', { hasText: /fix error/i }).count()) > 0;
        if (hasPanel) await startTour(page);
      }
      await page.waitForSelector('.driver-popover', { timeout: 8000 });
      const t = await tour(page);
      note(`${t.progress} — ${t.title}`);
      assert(t.open, 'no popover after submit');
      await clickNext(page);
      const next = await tour(page);
      assert(next.open, 'the tour closed on Next');
    });
  }

  await browser.close();

  // ── report ────────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => r.status === 'fail');
  console.log(`\n${'='.repeat(72)}`);
  console.log(`${results.length} checks — ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length) {
    console.log('\nFAILING:');
    for (const f of failed) console.log(`  • ${f.name}\n      ${f.detail}`);
  }
  console.log('='.repeat(72));
  if (failed.length) process.exitCode = 1;
};

run().catch((e) => {
  console.error('sweep crashed:', e);
  process.exit(1);
});
