import { describe, expect, it } from 'vitest';

import {
  allowedActions, branchAdvice, manifestCommands, ownerOf, parseLog, parseStatus, parseWorktreeList, pickFiles,
  validBranch, validMessage, worktreeDirFor,
} from '../scripts/workspace-lib.mjs';

describe('git output', () => {
  it('parses the worktree list', () => {
    const w = parseWorktreeList([
      'worktree /ws/erp-next-backend', 'HEAD abc', 'branch refs/heads/dev', '',
      'worktree /ws/.wt/PROJ-1-erp-next-backend', 'HEAD def', 'detached', '',
      'worktree /ws/.wt/pr-erp-next-backend-9', 'HEAD 123', 'branch refs/heads/fix/PROJ-9-x', 'locked', '',
    ].join('\n'));
    expect(w).toEqual([
      { path: '/ws/erp-next-backend', head: 'abc', branch: 'dev', detached: false, bare: false, locked: false, prunable: false },
      { path: '/ws/.wt/PROJ-1-erp-next-backend', head: 'def', branch: null, detached: true, bare: false, locked: false, prunable: false },
      { path: '/ws/.wt/pr-erp-next-backend-9', head: '123', branch: 'fix/PROJ-9-x', detached: false, bare: false, locked: true, prunable: false },
    ]);
  });

  it('parses porcelain v2 status with renames, untracked and conflicts', () => {
    const z = [
      '# branch.oid 0123', '# branch.head feat/PROJ-1-a', '# branch.upstream origin/feat/PROJ-1-a', '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb src/a b.ts',
      '1 A. N... 000000 100644 100644 000 ccc src/new.ts',
      '2 R. N... 100644 100644 100644 ddd eee R100 src/renamed.ts', 'src/old.ts',
      'u UU N... 100644 100644 100644 100644 f g h src/conflict.ts',
      '? notes.md', '',
    ].join('\0');
    const s = parseStatus(z);
    expect(s).toMatchObject({ branch: 'feat/PROJ-1-a', upstream: 'origin/feat/PROJ-1-a', ahead: 2, behind: 1, head: '0123' });
    expect(s.files).toEqual([
      { path: 'src/a b.ts', staged: false, unstaged: true, kind: 'modified' },
      { path: 'src/new.ts', staged: true, unstaged: false, kind: 'added' },
      { path: 'src/renamed.ts', staged: true, unstaged: false, kind: 'renamed', from: 'src/old.ts' },
      { path: 'src/conflict.ts', staged: false, unstaged: true, kind: 'conflict' },
      { path: 'notes.md', staged: false, unstaged: true, kind: 'untracked' },
    ]);
    expect(parseStatus('# branch.oid 1\0# branch.head (detached)\0').branch).toBeNull();
  });

  it('parses the log', () => {
    expect(parseLog('abc\x1fab\x1fZ\x1f2026-10-29T10:00:00+05:30\x1ffix: a | b\n')).toEqual([
      { sha: 'abc', short: 'ab', author: 'Z', at: '2026-10-29T10:00:00+05:30', subject: 'fix: a | b' },
    ]);
  });
});

describe('workspace rules', () => {
  it('knows who owns a worktree folder', () => {
    expect(ownerOf('PROJ-3643-erp-next-backend')).toEqual({ kind: 'ticket', id: 'PROJ-3643', repo: 'erp-next-backend' });
    expect(ownerOf('pr-erp-next-ui-monorepo-1056')).toEqual({ kind: 'pr', id: '1056', repo: 'erp-next-ui-monorepo' });
    expect(ownerOf(worktreeDirFor('erp-next-backend', 'fix/PROJ-9-serial check'))).toEqual({ kind: 'branch', id: 'fix-PROJ-9-serial-check', repo: 'erp-next-backend' });
    expect(ownerOf('scratch').kind).toBe('other');
  });

  it('turns manifest commands into runnable ones and drops anything shell-like', () => {
    const cmds = manifestCommands({
      commands: {
        install: 'yarn install  (requires NODE_AUTH_TOKEN)',
        dev: 'yarn dev:watch',
        test: 'NODE_ENV=dev lerna run test',
        perKit: { uiKitV2: { typecheck: 'yarn typecheck:uikit-v2' } },
        evil: 'yarn test; rm -rf ~',
        prose: 'see the README',
        run: 'uvicorn app.main:app --reload --port 6000',
      },
    });
    expect(cmds.map((c) => c.id)).toEqual(['install', 'dev', 'test', 'perKit.uiKitV2.typecheck', 'run']);
    expect(cmds[0]).toMatchObject({ cmd: 'yarn install', note: 'requires NODE_AUTH_TOKEN', longRunning: false });
    expect(cmds.find((c) => c.id === 'dev').longRunning).toBe(true);
    expect(cmds.find((c) => c.id === 'run').longRunning).toBe(true);
  });

  it('refuses branch names git or a shell could misread', () => {
    expect(validBranch('fix/PROJ-2996-tag-iconleft')).toBeNull();
    for (const bad of ['', '-x', '--force', 'a..b', 'a b', 'a~1', 'x.lock', '/a', 'a/', 'a@{1}', 'a:b']) expect(validBranch(bad), bad).toBeTruthy();
    expect(branchAdvice('fix/PROJ-1-a')).toBeNull();
    expect(branchAdvice('my-branch')).toMatch(/convention/);
  });

  it('only acts on files git reported', () => {
    const st = { files: [{ path: 'a.ts' }, { path: 'b.ts' }] };
    expect(pickFiles(['a.ts'], st)).toEqual({ files: ['a.ts'] });
    expect(pickFiles(['../../etc/passwd'], st).error).toMatch(/Not a changed file/);
    expect(pickFiles([], st).error).toMatch(/at least one/);
    expect(validMessage('  ')).toMatch(/Write/);
  });

  it('keeps primary checkouts and never-modify repos read-only', () => {
    expect(allowedActions({ readOnlyRepo: true, isPrimary: true })).toEqual({ fetch: true });
    expect(allowedActions({ isPrimary: true, dirty: true })).toEqual({ fetch: true, pull: false, newWorktree: true });
    const wt = allowedActions({ isPrimary: false, dirty: true, ahead: 0, hasUpstream: true, branch: 'b' });
    expect(wt).toMatchObject({ commit: true, discard: true, push: false, remove: false, pull: false, run: true, chat: true });
    expect(allowedActions({ isPrimary: false, dirty: false, ahead: 2, hasUpstream: true, branch: 'b' })).toMatchObject({ push: true, pr: false, remove: true });
    expect(allowedActions({ isPrimary: false, dirty: false, ahead: 0, hasUpstream: false, branch: 'b' })).toMatchObject({ push: true, pr: false });
    expect(allowedActions({ isPrimary: false, dirty: false, ahead: 0, hasUpstream: true, branch: null })).toMatchObject({ push: false, pr: false });
  });
});

describe('secrets', async () => {
  const { maskSecrets, secretsAdded } = await import('../scripts/workspace-lib.mjs');
  const FAKE = `ghp_${'a1B2'.repeat(9)}`;

  it('masks credential shapes and leaves env references alone', () => {
    expect(maskSecrets(`npmAuthToken: ${FAKE}`)).not.toContain(FAKE);
    expect(maskSecrets('npmAuthToken: "${NPM_TOKEN}"')).toBe('npmAuthToken: "${NPM_TOKEN}"');
    expect(maskSecrets('password = "hunter2hunter2hunter2"')).toContain('•••• (hidden)');
    expect(maskSecrets('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----')).not.toContain('abc');
    expect(maskSecrets('const tokenCount = items.length')).toBe('const tokenCount = items.length');
  });

  it('finds credentials only on added lines', () => {
    const diff = ['--- a/.yarnrc.yml', '+++ b/.yarnrc.yml', `-npmAuthToken: "\${NPM_TOKEN}"`, `+npmAuthToken: ${FAKE}`].join('\n');
    const hits = secretsAdded(diff);
    expect(hits).toHaveLength(1);
    expect(hits[0].hint).not.toContain(FAKE);
    expect(secretsAdded(`-npmAuthToken: ${FAKE}`)).toEqual([]);
  });
});
