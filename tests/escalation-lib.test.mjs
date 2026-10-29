import { describe, expect, it } from 'vitest';

import { buildEscalation, escalationCommentAdf, escalationRecord } from '../scripts/escalation-lib.mjs';

describe('buildEscalation', () => {
  it('builds a blocking, high-severity handoff for a budget stop', () => {
    const e = buildEscalation({ key: 'PROJ-1', kind: 'budget', reason: 'budget exhausted before target reached' });
    expect(e.blocking).toBe(true);
    expect(e.severity).toBe('high');
    expect(e.question).toContain('PROJ-1');
    expect(e.question).toContain('How should Autopilot proceed?');
  });

  it('builds a crisp answerable question with 2-4 options for a design-conflict escalation', () => {
    const e = buildEscalation({
      key: 'PROJ-XXXX',
      kind: 'design-conflict',
      reason: 'binding `text-disabled` matches Figma but fails WCAG AA + is invisible in dark',
      options: ['Ship as-is', 'keep the safe `text-on-color-disabled`', 'escalate to design'],
    });
    expect(e.severity).toBe('high');
    expect(e.question).toBe(
      'PROJ-XXXX: binding `text-disabled` matches Figma but fails WCAG AA + is invisible in dark. Ship as-is / keep the safe `text-on-color-disabled` / escalate to design?',
    );
  });

  it('defaults elevated severity for stall/low-confidence/ambiguous-ac', () => {
    expect(buildEscalation({ key: 'K', kind: 'stall', reason: 'no improvement' }).severity).toBe('elevated');
    expect(buildEscalation({ key: 'K', kind: 'low-confidence', reason: 'route unsure' }).severity).toBe('elevated');
    expect(buildEscalation({ key: 'K', kind: 'ambiguous-ac', reason: 'AC unclear' }).severity).toBe('elevated');
  });

  it('defaults high severity for rounds/stakes', () => {
    expect(buildEscalation({ key: 'K', kind: 'rounds', reason: 'max rounds hit' }).severity).toBe('high');
    expect(buildEscalation({ key: 'K', kind: 'stakes', reason: 'sensitive-domain touch' }).severity).toBe('high');
  });

  it('throws on an unknown kind', () => {
    expect(() => buildEscalation({ key: 'K', kind: 'bogus', reason: 'x' })).toThrow(/unknown kind/);
  });

  it('does not double-punctuate a reason that already ends with a terminator', () => {
    const e = buildEscalation({ key: 'K', kind: 'stall', reason: 'no improvement for 3 rounds.' });
    expect(e.question).toBe('K: no improvement for 3 rounds. How should Autopilot proceed?');
  });
});

describe('escalationCommentAdf', () => {
  it('produces an ADF doc with the question and a mention node for the owner', () => {
    const escalation = buildEscalation({ key: 'PROJ-1', kind: 'stakes', reason: 'high-stakes change' });
    const doc = escalationCommentAdf({ escalation, ownerAccountId: '712020:abc' });

    expect(doc.type).toBe('doc');
    expect(doc.version).toBe(1);
    const paragraph = doc.content[0];
    expect(paragraph.type).toBe('paragraph');

    const mention = paragraph.content.find((n) => n.type === 'mention');
    expect(mention).toBeTruthy();
    expect(mention.attrs.id).toBe('712020:abc');

    const text = paragraph.content.find((n) => n.type === 'text');
    expect(text.text).toContain('PROJ-1');
  });
});

describe('escalationRecord', () => {
  it('builds an open record with a placeholder timestamp (never calls Date)', () => {
    const rec = escalationRecord({ key: 'PROJ-1', kind: 'stakes', reason: 'r', question: 'q?' });
    expect(rec).toEqual({
      key: 'PROJ-1',
      kind: 'stakes',
      reason: 'r',
      question: 'q?',
      status: 'open',
      raisedAtField: '<ISO placeholder>',
    });
  });
});
