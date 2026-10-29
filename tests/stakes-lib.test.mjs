import { describe, expect, it } from 'vitest';

import { classifyStakes, summarizeStakes } from '../scripts/stakes-lib.mjs';

describe('classifyStakes', () => {
  it('is low for a plain component SCSS tweak', () => {
    const r = classifyStakes({
      files: ['packages/erp-next-ui-kit-v2/src/components/Tag/Tag.module.scss'],
      addedLines: ['.tag { padding: 4px 8px; }'],
    });
    expect(r.level).toBe('low');
    expect(r.reasons).toEqual([]);
    expect(r.requiresEscalation).toBe(false);
  });

  it('flags a shared kit-wide token rebind as elevated shared-token', () => {
    const r = classifyStakes({
      files: ['packages/erp-next-ui-kit-v2/src/components/Skeleton/Skeleton.module.scss'],
      addedLines: ['background: var(--skeleton-background);'],
    });
    expect(r.requiresEscalation).toBe(false);
    expect(r.reasons.some((x) => x.code === 'shared-token')).toBe(true);
    expect(r.level).toBe('elevated');
  });

  it('escalates a shared-token change to high when the token definition file itself changes', () => {
    const r = classifyStakes({
      files: ['packages/erp-next-ui-kit-v2/src/styles/tokens/colors.scss'],
      addedLines: ['$skeleton-background: #e0e0e0;'],
    });
    expect(r.level).toBe('high');
    expect(r.requiresEscalation).toBe(true);
    expect(r.reasons.some((x) => x.code === 'shared-token')).toBe(true);
  });

  it('escalates an elevated shared-token change when it also touches a public API', () => {
    const r = classifyStakes({
      files: ['packages/erp-next-ui-kit-v2/src/components/Skeleton/Skeleton.tsx'],
      addedLines: ['background: var(--skeleton-background);', 'export interface SkeletonProps { rows?: number; }'],
    });
    expect(r.requiresEscalation).toBe(true);
    expect(r.level).toBe('elevated');
  });

  it('flags a HIGH a11y-contrast reason and requires escalation for text-disabled (PROJ-2990)', () => {
    const r = classifyStakes({
      files: ['packages/erp-next-ui-kit-v2/src/components/TextInput/TextInput.module.scss'],
      addedLines: ['color: var(--text-disabled);'],
    });
    expect(r.level).toBe('high');
    expect(r.requiresEscalation).toBe(true);
    expect(r.reasons.some((x) => x.code === 'a11y-contrast')).toBe(true);
  });

  it('flags a11y-contrast on the known-risky hex even without the token name', () => {
    const r = classifyStakes({
      files: ['packages/erp-next-ui-kit-v2/src/components/TextInput/TextInput.module.scss'],
      addedLines: ['color: #161616;'],
    });
    expect(r.reasons.some((x) => x.code === 'a11y-contrast')).toBe(true);
    expect(r.requiresEscalation).toBe(true);
  });

  it('flags a11y-contrast for tag-red', () => {
    const r = classifyStakes({
      files: ['packages/erp-next-ui-kit-v2/src/components/Tag/Tag.module.scss'],
      addedLines: ['background: var(--tag-red);'],
    });
    expect(r.reasons.some((x) => x.code === 'a11y-contrast')).toBe(true);
    expect(r.level).toBe('high');
  });

  it('flags a HIGH sensitive-domain reason for an auth/ path', () => {
    const r = classifyStakes({
      files: ['apps/api/src/modules/auth/login.controller.ts'],
      addedLines: ['export function login() {}'],
    });
    expect(r.level).toBe('high');
    expect(r.requiresEscalation).toBe(true);
    expect(r.reasons.some((x) => x.code === 'sensitive-domain')).toBe(true);
  });

  it('flags other sensitive-domain paths (payment, migration, .sql)', () => {
    expect(classifyStakes({ files: ['src/billing/invoice.ts'] }).reasons.some((r) => r.code === 'sensitive-domain')).toBe(true);
    expect(classifyStakes({ files: ['db/migration/2026_add_column.sql'] }).reasons.some((r) => r.code === 'sensitive-domain')).toBe(true);
  });

  it('flags a HIGH security reason for dangerouslySetInnerHTML/eval/secrets', () => {
    const r = classifyStakes({
      files: ['packages/erp-next-ui-kit-v2/src/components/Rich/Rich.tsx'],
      addedLines: ['<div dangerouslySetInnerHTML={{ __html: raw }} />'],
    });
    expect(r.level).toBe('high');
    expect(r.requiresEscalation).toBe(true);
    expect(r.reasons.some((x) => x.code === 'security')).toBe(true);
  });

  it('combines multiple reasons and takes the max severity', () => {
    const r = classifyStakes({
      files: ['apps/api/src/modules/auth/session.ts', 'packages/kit/src/styles/tokens/colors.scss'],
      addedLines: ['const secret = process.env.API_KEY;'],
    });
    expect(r.level).toBe('high');
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it('tolerates missing/empty input', () => {
    const r = classifyStakes({});
    expect(r).toEqual({ level: 'low', reasons: [], requiresEscalation: false });
  });
});

describe('summarizeStakes', () => {
  it('summarizes a clean result', () => {
    expect(summarizeStakes({ level: 'low', reasons: [], requiresEscalation: false })).toContain('low');
  });

  it('summarizes a high-stakes result with the escalation flag', () => {
    const result = classifyStakes({ files: ['auth/login.ts'], addedLines: [] });
    const summary = summarizeStakes(result);
    expect(summary).toContain('HIGH');
    expect(summary).toContain('REQUIRES ESCALATION');
    expect(summary).toContain('sensitive-domain');
  });
});
