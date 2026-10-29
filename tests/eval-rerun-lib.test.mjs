import { describe, expect, it } from 'vitest';

import {
  repoForEntry,
  baseRefFor,
  evalWorktreeName,
  evalBranchName,
  parseCmdTemplate,
  buildRerunArgv,
  rerunPlan,
  rerunCacheKey,
} from '../scripts/eval-rerun-lib.mjs';

const MANIFEST = {
  repos: [
    {
      id: 'erp-next-ui-monorepo',
      subPackages: {
        app: { path: 'frontend' },
        uiKitV1: { path: 'packages/erp-next-ui-kit' },
        uiKitV2: { path: 'packages/erp-next-ui-kit-v2' },
      },
    },
    { id: 'erp-next-backend' },
  ],
};

describe('repoForEntry', () => {
  it('prefers an explicit repo field', () => {
    expect(repoForEntry({ key: 'X', repo: 'erp-next-backend', expect: {} }, MANIFEST)).toBe('erp-next-backend');
  });

  it('infers the monorepo from a sub-package path in filesTouched', () => {
    const entry = { key: 'X', expect: { filesTouched: ['packages/erp-next-ui-kit-v2/src/components/Tag/'] } };
    expect(repoForEntry(entry, MANIFEST)).toBe('erp-next-ui-monorepo');
  });

  it('infers a repo whose id is itself the path prefix', () => {
    const entry = { key: 'X', expect: { filesTouched: ['erp-next-backend/src/routes/foo.ts'] } };
    expect(repoForEntry(entry, MANIFEST)).toBe('erp-next-backend');
  });

  it('throws with a helpful message when it cannot determine the repo', () => {
    const entry = { key: 'PROJ-9', expect: { filesTouched: ['some/unknown/path.ts'] } };
    expect(() => repoForEntry(entry, MANIFEST)).toThrow(/PROJ-9/);
  });

  it('throws when there is nothing to infer from', () => {
    expect(() => repoForEntry({ key: 'PROJ-1', expect: {} }, MANIFEST)).toThrow(/repo/);
  });
});

describe('baseRefFor', () => {
  it('builds against the PARENT of the merged commit', () => {
    const r = baseRefFor({ mergedCommit: '2d324f8b' });
    expect(r).toMatchObject({ ref: '2d324f8b^', kind: 'commit' });
  });

  it('falls back to the base branch when no mergedCommit', () => {
    expect(baseRefFor({}, 'dev')).toMatchObject({ ref: 'dev', kind: 'branch' });
    expect(baseRefFor({ mergedCommit: '   ' }, 'main')).toMatchObject({ ref: 'main', kind: 'branch' });
  });
});

describe('worktree + branch naming', () => {
  it('namespaces both away from real runs', () => {
    expect(evalWorktreeName('PROJ-2825', 'erp-next-ui-monorepo')).toBe('eval-PROJ-2825-erp-next-ui-monorepo');
    expect(evalBranchName('PROJ-2825')).toBe('eval/PROJ-2825');
  });
});

describe('parseCmdTemplate', () => {
  it('returns null for an empty/absent template', () => {
    expect(parseCmdTemplate('', {})).toBeNull();
    expect(parseCmdTemplate(undefined, {})).toBeNull();
  });

  it('splits argv and substitutes {KEY}/{REPO}, honoring double-quotes', () => {
    const out = parseCmdTemplate('node stub.mjs {KEY} --repo {REPO} --msg "hello world"', { key: 'PROJ-1', repo: 'r1' });
    expect(out).toEqual({ cmd: 'node', args: ['stub.mjs', 'PROJ-1', '--repo', 'r1', '--msg', 'hello world'] });
  });
});

describe('buildRerunArgv', () => {
  it('defaults to a BUILD-only, side-effect-free resolve-ticket invocation', () => {
    const { cmd, args } = buildRerunArgv('PROJ-2825', 'erp-next-ui-monorepo');
    expect(cmd).toBe('claude');
    const prompt = args[args.indexOf('-p') + 1];
    expect(prompt).toBe('/resolve-ticket PROJ-2825 --repo erp-next-ui-monorepo --until build --yes');
    expect(prompt).not.toContain('--auto-ship'); // never ships in eval
  });

  it('adds --settings only when a settings path is given', () => {
    expect(buildRerunArgv('K', 'r', {}).args).not.toContain('--settings');
    expect(buildRerunArgv('K', 'r', { settingsPath: '/tmp/s.json' }).args).toContain('/tmp/s.json');
  });

  it('is fully overridable via a command template', () => {
    const out = buildRerunArgv('PROJ-1', 'r1', { buildCmdTemplate: 'echo built {KEY} in {REPO}' });
    expect(out).toEqual({ cmd: 'echo', args: ['built', 'PROJ-1', 'in', 'r1'] });
  });
});

describe('rerunCacheKey', () => {
  it('composes goldenKey::baseSha::promptHash and is stable', () => {
    expect(rerunCacheKey('PROJ-1', 'abc123', 'deadbeef')).toBe('PROJ-1::abc123::deadbeef');
  });
  it('changes when any of the three inputs changes (base tree or prompts)', () => {
    const a = rerunCacheKey('PROJ-1', 'sha1', 'p1');
    expect(rerunCacheKey('PROJ-1', 'sha2', 'p1')).not.toBe(a); // base moved
    expect(rerunCacheKey('PROJ-1', 'sha1', 'p2')).not.toBe(a); // prompts changed
    expect(rerunCacheKey('PROJ-2', 'sha1', 'p1')).not.toBe(a); // different ticket
  });
});

describe('rerunPlan', () => {
  it('assembles a full deterministic plan', () => {
    const entry = { key: 'PROJ-2825', mergedCommit: '2d324f8b', repo: 'erp-next-ui-monorepo', expect: {} };
    const plan = rerunPlan(entry, MANIFEST, { baseBranch: 'dev' });
    expect(plan).toMatchObject({
      key: 'PROJ-2825',
      repo: 'erp-next-ui-monorepo',
      base: { ref: '2d324f8b^', kind: 'commit' },
      worktree: 'eval-PROJ-2825-erp-next-ui-monorepo',
      branch: 'eval/PROJ-2825',
    });
    expect(plan.build.cmd).toBe('claude');
  });
});
