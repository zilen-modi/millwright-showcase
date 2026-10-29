import { describe, expect, it } from 'vitest';

import { TOPIC_MAX, isSlug, markdownToHtml, parseSubject, renderExplainerHtml } from '../scripts/explain-lib.mjs';

describe('parseSubject', () => {
  it('reads a ticket key, bare or inside a Jira link', () => {
    expect(parseSubject('proj-3907')).toEqual({ type: 'ticket', id: 'PROJ-3907', slug: 'proj-3907', label: 'PROJ-3907' });
    expect(parseSubject('https://acme.atlassian.net/browse/PROJ-12')).toMatchObject({ type: 'ticket', id: 'PROJ-12' });
  });

  it('reads a GitHub PR link', () => {
    expect(parseSubject('https://github.com/acme-it-erp/erp-next-backend/pull/740')).toEqual({
      type: 'pr', id: 'https://github.com/acme-it-erp/erp-next-backend/pull/740',
      slug: 'pr-acme-it-erp-erp-next-backend-740', label: 'erp-next-backend#740',
    });
    expect(parseSubject('https://example.com/x').error).toMatch(/not a GitHub pull request/);
  });

  it('treats words as a topic, with a stable kebab slug', () => {
    expect(parseSubject('  Branch   transfers ')).toEqual({ type: 'topic', id: 'Branch transfers', slug: 'topic-branch-transfers', label: 'Branch transfers' });
    expect(parseSubject('Ship via & will-call').slug).toBe('topic-ship-via-will-call');
    expect(parseSubject("How does PROJ-3907's screen work?").type).toBe('topic'); // a key inside a sentence is a topic
  });

  it('refuses empty, overlong and path- or shell-like topics', () => {
    expect(parseSubject('').error).toBeTruthy();
    expect(parseSubject('a'.repeat(TOPIC_MAX + 1)).error).toMatch(/under/);
    for (const bad of ['../../etc/passwd', '--dangerously-skip', '$(rm -rf ~)', '`id`', 'a;b', '~/x']) {
      expect(parseSubject(bad).error, bad).toBeTruthy();
    }
  });

  it('only ever produces slugs that are safe path segments', () => {
    for (const s of ['PROJ-1', 'https://github.com/a/b/pull/2', 'Ship via', 'Über Lagerumbuchung 2']) {
      const r = parseSubject(s);
      expect(isSlug(r.slug), s).toBe(true);
    }
    expect(isSlug('../x')).toBe(false);
    expect(isSlug('topic-a/b')).toBe(false);
    expect(isSlug('pr-a..b')).toBe(true); // dots alone never leave the folder: no slash
  });
});

describe('HTML export', () => {
  it('escapes everything that is not markup', () => {
    const html = markdownToHtml('Hello <script>alert(1)</script> and `x<y>` **bold**\n\n- one\n- <img src=x onerror=alert(1)>');
    expect(html).not.toMatch(/<script>|<img/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<code>x&lt;y&gt;</code>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<li>&lt;img src=x onerror=alert(1)&gt;</li>');
  });

  it('renders tables, headings and only http(s) links', () => {
    const html = markdownToHtml('## Old vs new\n\n| Old | New |\n|---|---|\n| a \\| b | c |\n\n[ok](https://x.y) [bad](javascript:alert(1))');
    expect(html).toContain('<h3>Old vs new</h3>');
    expect(html).toContain('<td>a | b</td>');
    expect(html).toContain('<a href="https://x.y">ok</a>');
    expect(html).not.toContain('href="javascript');
  });

  it('is a self-contained page', () => {
    const page = renderExplainerHtml({ title: 'Branch <transfers>', markdown: '# Title\n\nBody', subject: 'topic', generatedAt: '2026-10-29T10:00:00Z' });
    expect(page).toContain('<title>Branch &lt;transfers&gt;</title>');
    expect(page).not.toMatch(/<(script|link|img)\b/);
    expect(page).not.toMatch(/https?:\/\/(?!x)/); // no external requests
  });
});
