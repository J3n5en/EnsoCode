import { parseProfile } from '@shared/secretary/parse';
import type { ProjectAuthority } from '@shared/types/agent';
import type { SecretaryAuditEntry, SecretaryProfile } from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import {
  createSecretaryGithubOpsHandlers,
  type GithubOpsCommandResult,
  type GithubOpsPorts,
  PROTECTED_BRANCHES,
  parseGithubRepo,
  parsePrView,
  resolveGithubScope,
} from './githubOps';

function project(projectId: string, canonicalPath: string): ProjectAuthority {
  return { projectId, canonicalPath, state: 'active', version: 1 };
}

function profile(): SecretaryProfile {
  const parsed = parseProfile({});
  if (!parsed) throw new Error('default profile');
  return parsed;
}

const NOW = 1_700_000_000_000;

interface Harness {
  ports: GithubOpsPorts;
  ghCalls: string[][];
  gitCalls: Array<{ cwd: string; args: string[] }>;
  audits: SecretaryAuditEntry[];
  /** 替换 gh 的应答逻辑；默认全部成功空输出 */
  answerGh(fn: (args: readonly string[]) => GithubOpsCommandResult | null): void;
  answerGit(fn: (cwd: string, args: readonly string[]) => GithubOpsCommandResult): void;
}

function harness(
  origins: Record<string, string | null>,
  extra: { projects?: ProjectAuthority[] } = {}
): Harness {
  const ghCalls: string[][] = [];
  const gitCalls: Array<{ cwd: string; args: string[] }> = [];
  const audits: SecretaryAuditEntry[] = [];
  const projects = extra.projects ?? Object.keys(origins).map((id) => project(id, `/repo/${id}`));
  let ghAnswer: (args: readonly string[]) => GithubOpsCommandResult | null = () => ({
    code: 0,
    stdout: '{}',
    stderr: '',
  });
  let gitAnswer: (cwd: string, args: readonly string[]) => GithubOpsCommandResult = (cwd, args) => {
    if (args[0] === 'remote' && args[1] === 'get-url') {
      const match = Object.entries(origins).find(([id]) => cwd === `/repo/${id}`);
      const url = match?.[1];
      return url
        ? { code: 0, stdout: `${url}\n`, stderr: '' }
        : { code: 1, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const ports: GithubOpsPorts = {
    gh: (args) => {
      ghCalls.push([...args]);
      return Promise.resolve(ghAnswer(args));
    },
    git: (cwd, args) => {
      gitCalls.push({ cwd, args: [...args] });
      return Promise.resolve(gitAnswer(cwd, args));
    },
    projects: () => projects,
    profile: () => profile(),
    audit: (entry) => audits.push(entry),
    now: () => NOW,
  };
  return {
    ports,
    ghCalls,
    gitCalls,
    audits,
    answerGh: (fn) => {
      ghAnswer = fn;
    },
    answerGit: (fn) => {
      gitAnswer = fn;
    },
  };
}

const ctx = { secretaryConversationId: 'conv-1' };

function prViewBody(state: string, mergeStateStatus = 'CLEAN', autoMergeRequest: unknown = null) {
  return JSON.stringify({ number: 42, state, mergeStateStatus, autoMergeRequest });
}

describe('parseGithubRepo', () => {
  it('parses ssh, git@ and https remotes', () => {
    expect(parseGithubRepo('git@github.com:Owner/repo.git')).toBe('Owner/repo');
    expect(parseGithubRepo('git@github.com:Owner/repo')).toBe('Owner/repo');
    expect(parseGithubRepo('ssh://git@github.com/Owner/repo.git')).toBe('Owner/repo');
    expect(parseGithubRepo('https://github.com/Owner/repo.git')).toBe('Owner/repo');
    expect(parseGithubRepo('https://github.com/Owner/repo/')).toBe('Owner/repo');
    expect(parseGithubRepo('https://github.com/Owner/repo\n')).toBe('Owner/repo');
  });

  it('rejects non-github and malformed remotes', () => {
    expect(parseGithubRepo('https://gitlab.com/Owner/repo.git')).toBeUndefined();
    expect(parseGithubRepo('https://github.com/Owner')).toBeUndefined();
    expect(parseGithubRepo('https://github.com/Owner/repo/extra')).toBeUndefined();
    expect(parseGithubRepo('')).toBeUndefined();
  });
});

describe('parsePrView', () => {
  it('reads state, mergeStateStatus and autoMergeRequest', () => {
    const view = parsePrView(prViewBody('OPEN', 'BLOCKED', { enabledAt: 'x' }));
    expect(view).toEqual({ state: 'OPEN', mergeStateStatus: 'BLOCKED', autoMergeRequested: true });
    expect(parsePrView(prViewBody('MERGED'))?.autoMergeRequested).toBe(false);
  });

  it('returns null for unparseable output', () => {
    expect(parsePrView('not json')).toBeNull();
    expect(parsePrView('[]')).toBeNull();
  });
});

describe('resolveGithubScope', () => {
  it('resolves the single visible project origin when repo is omitted', async () => {
    const h = harness({ p1: 'git@github.com:Owner/repo.git' });
    const outcome = await resolveGithubScope(h.ports, {});
    expect(outcome).toEqual({
      ok: true,
      scope: { repo: 'Owner/repo', cwd: '/repo/p1', projectId: 'p1' },
    });
  });

  it('requires repo when several distinct origins are visible, but matches case-insensitively', async () => {
    const h = harness({
      p1: 'git@github.com:Owner/one.git',
      p2: 'https://github.com/Owner/two.git',
    });
    expect(await resolveGithubScope(h.ports, {})).toEqual({ ok: false, error: 'repo-required' });
    const hit = await resolveGithubScope(h.ports, { repo: 'owner/TWO' });
    expect(hit.ok && hit.scope.projectId).toBe('p2');
  });

  it('refuses a repo that matches no visible project origin', async () => {
    const h = harness({ p1: 'git@github.com:Owner/repo.git' });
    expect(await resolveGithubScope(h.ports, { repo: 'other/repo' })).toEqual({
      ok: false,
      error: 'repo-not-visible-project-origin',
    });
  });

  it('refuses malformed repo slugs and unknown projectIds', async () => {
    const h = harness({ p1: 'git@github.com:Owner/repo.git' });
    expect(await resolveGithubScope(h.ports, { repo: 'no-slash' })).toEqual({
      ok: false,
      error: 'invalid-repo',
    });
    expect(await resolveGithubScope(h.ports, { projectId: 'nope' })).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('scopes by projectId and reports a project without github origin', async () => {
    const h = harness({ p1: null, p2: 'git@github.com:Owner/repo.git' });
    const hit = await resolveGithubScope(h.ports, { projectId: 'p2' });
    expect(hit.ok && hit.scope.repo).toBe('Owner/repo');
    expect(await resolveGithubScope(h.ports, { projectId: 'p1' })).toEqual({
      ok: false,
      error: 'no-github-origin',
    });
  });
});

describe('github_merge_pr', () => {
  function openPrHarness() {
    const h = harness({ p1: 'git@github.com:Owner/repo.git' });
    h.answerGh((args) => {
      if (args[1] === 'view') {
        return {
          code: 0,
          stdout: prViewBody('OPEN', 'CLEAN', args.includes('42') ? null : null),
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    return h;
  }

  it('merges with squash, auto and delete-branch in one gh call', async () => {
    const h = openPrHarness();
    const handlers = createSecretaryGithubOpsHandlers(h.ports);
    const result = await handlers.github_merge_pr({ repo: 'Owner/repo', number: 42 }, ctx);
    expect(result.ok).toBe(true);
    const merge = h.ghCalls.find((args) => args[1] === 'merge');
    expect(merge).toEqual([
      'pr',
      'merge',
      '42',
      '--repo',
      'Owner/repo',
      '--squash',
      '--delete-branch',
      '--auto',
    ]);
    // 永不出现 merge/rebase 方法与 --admin
    expect(merge).not.toContain('--merge');
    expect(merge).not.toContain('--rebase');
    expect(merge).not.toContain('--admin');
    expect(result.ok && result.result).toMatchObject({
      repo: 'Owner/repo',
      number: 42,
      method: 'squash',
      auto: true,
      stateBefore: 'OPEN',
      mergeStateStatusBefore: 'CLEAN',
    });
    const audit = h.audits.find((entry) => entry.ok);
    expect(audit).toMatchObject({ op: 'github_merge_pr', targetId: 'Owner/repo#42', ok: true });
  });

  it('drops --auto when auto is false', async () => {
    const h = openPrHarness();
    const handlers = createSecretaryGithubOpsHandlers(h.ports);
    const result = await handlers.github_merge_pr(
      { repo: 'Owner/repo', number: 42, auto: false },
      ctx
    );
    expect(result.ok).toBe(true);
    const merge = h.ghCalls.find((args) => args[1] === 'merge');
    expect(merge).not.toContain('--auto');
  });

  it('refuses a method other than squash before touching gh', async () => {
    const h = openPrHarness();
    const handlers = createSecretaryGithubOpsHandlers(h.ports);
    const result = await handlers.github_merge_pr(
      { repo: 'Owner/repo', number: 42, method: 'merge' },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.ok || result.error).toContain('only squash');
    expect(h.ghCalls.some((args) => args[1] === 'merge')).toBe(false);
  });

  it('refuses non-positive numbers', async () => {
    const h = openPrHarness();
    const handlers = createSecretaryGithubOpsHandlers(h.ports);
    for (const number of [0, -1, 1.5, '42']) {
      const result = await handlers.github_merge_pr({ repo: 'Owner/repo', number }, ctx);
      expect(result.ok).toBe(false);
    }
  });

  it('refuses a PR that is not open and audits the failure', async () => {
    const h = harness({ p1: 'git@github.com:Owner/repo.git' });
    h.answerGh(() => ({ code: 0, stdout: prViewBody('MERGED'), stderr: '' }));
    const handlers = createSecretaryGithubOpsHandlers(h.ports);
    const result = await handlers.github_merge_pr({ repo: 'Owner/repo', number: 42 }, ctx);
    expect(result).toEqual({ ok: false, error: 'pr-not-open:merged' });
    expect(h.ghCalls.some((args) => args[1] === 'merge')).toBe(false);
    expect(h.audits[0]).toMatchObject({ ok: false, detail: 'pr-not-open:merged' });
  });

  it('reads the PR before merging and reports autoMergeRequest after', async () => {
    const h = harness({ p1: 'git@github.com:Owner/repo.git' });
    let merged = false;
    h.answerGh((args) => {
      if (args[1] === 'view') {
        return {
          code: 0,
          stdout: prViewBody(
            'OPEN',
            merged ? 'UNSTABLE' : 'BLOCKED',
            merged ? { enabledAt: 'x' } : null
          ),
          stderr: '',
        };
      }
      merged = true;
      return { code: 0, stdout: '', stderr: '' };
    });
    const handlers = createSecretaryGithubOpsHandlers(h.ports);
    const result = await handlers.github_merge_pr({ repo: 'Owner/repo', number: 42 }, ctx);
    expect(result.ok && result.result).toMatchObject({
      mergeStateStatusBefore: 'BLOCKED',
      mergeStateStatusAfter: 'UNSTABLE',
      autoMergeRequested: true,
    });
    const views = h.ghCalls.filter((args) => args[1] === 'view');
    expect(views).toHaveLength(2);
    expect(views[0].join(' ')).toContain('mergeStateStatus');
  });

  it('reports gh merge failure with stderr and audits it', async () => {
    const h = harness({ p1: 'git@github.com:Owner/repo.git' });
    h.answerGh((args) => {
      if (args[1] === 'view') return { code: 0, stdout: prViewBody('OPEN'), stderr: '' };
      return { code: 1, stdout: '', stderr: 'auto merge is not allowed for this repository' };
    });
    const handlers = createSecretaryGithubOpsHandlers(h.ports);
    const result = await handlers.github_merge_pr({ repo: 'Owner/repo', number: 42 }, ctx);
    expect(result).toEqual({ ok: false, error: 'auto merge is not allowed for this repository' });
    expect(h.audits[0]).toMatchObject({
      ok: false,
      detail: 'auto merge is not allowed for this repository',
    });
  });

  it('reports gh-unavailable without crashing', async () => {
    const h = harness({ p1: 'git@github.com:Owner/repo.git' });
    h.answerGh(() => null);
    const handlers = createSecretaryGithubOpsHandlers(h.ports);
    const result = await handlers.github_merge_pr({ repo: 'Owner/repo', number: 42 }, ctx);
    expect(result).toEqual({ ok: false, error: 'gh-unavailable' });
  });

  it('refuses a repo outside the visible projects before touching gh', async () => {
    const h = openPrHarness();
    const handlers = createSecretaryGithubOpsHandlers(h.ports);
    const result = await handlers.github_merge_pr({ repo: 'evil/repo', number: 42 }, ctx);
    expect(result).toEqual({ ok: false, error: 'repo-not-visible-project-origin' });
    expect(h.ghCalls).toHaveLength(0);
    expect(h.audits[0]).toMatchObject({ ok: false, detail: 'repo-not-visible-project-origin' });
  });
});

describe('github_delete_branch', () => {
  function cleanBranchHarness() {
    const h = harness({ p1: 'git@github.com:Owner/repo.git' });
    h.answerGit((_cwd, args) => {
      if (args[0] === 'remote')
        return { code: 0, stdout: 'git@github.com:Owner/repo.git\n', stderr: '' };
      if (args[0] === 'ls-remote') {
        return { code: 0, stdout: 'abc123\trefs/heads/feat/done\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    h.answerGh(() => ({ code: 0, stdout: '[]', stderr: '' }));
    return h;
  }

  it('deletes the remote branch with git push origin --delete', async () => {
    const h = cleanBranchHarness();
    const handlers = createSecretaryGithubOpsHandlers(h.ports);
    const result = await handlers.github_delete_branch(
      { repo: 'Owner/repo', branch: 'feat/done' },
      ctx
    );
    expect(result).toEqual({
      ok: true,
      result: { repo: 'Owner/repo', branch: 'feat/done', deleted: 'remote' },
    });
    const push = h.gitCalls.find((call) => call.args[0] === 'push');
    expect(push?.args).toEqual(['push', 'origin', '--delete', 'feat/done']);
    // 不碰本地分支
    expect(h.gitCalls.some((call) => call.args[0] === 'branch')).toBe(false);
    const listed = h.ghCalls.find((args) => args[1] === 'list');
    expect(listed).toEqual([
      'pr',
      'list',
      '--repo',
      'Owner/repo',
      '--head',
      'feat/done',
      '--state',
      'open',
      '--json',
      'number',
    ]);
    expect(h.audits.at(-1)).toMatchObject({
      op: 'github_delete_branch',
      targetId: 'Owner/repo:feat/done',
      ok: true,
    });
  });

  it.each([...PROTECTED_BRANCHES])(
    'refuses the protected branch %s before any command',
    async (branch) => {
      const h = cleanBranchHarness();
      const handlers = createSecretaryGithubOpsHandlers(h.ports);
      const result = await handlers.github_delete_branch({ repo: 'Owner/repo', branch }, ctx);
      expect(result).toEqual({ ok: false, error: `protected-branch: ${branch}` });
      expect(h.gitCalls.filter((call) => call.args[0] !== 'remote')).toHaveLength(0);
      expect(h.ghCalls).toHaveLength(0);
      expect(h.audits[0]).toMatchObject({ ok: false, detail: 'protected-branch' });
    }
  );

  it('refuses a branch with open PRs and names them', async () => {
    const h = cleanBranchHarness();
    h.answerGh(() => ({
      code: 0,
      stdout: JSON.stringify([{ number: 296 }, { number: 12 }]),
      stderr: '',
    }));
    const handlers = createSecretaryGithubOpsHandlers(h.ports);
    const result = await handlers.github_delete_branch(
      { repo: 'Owner/repo', branch: 'feat/busy' },
      ctx
    );
    expect(result).toEqual({ ok: false, error: 'has-open-pr:296,12' });
    expect(h.gitCalls.some((call) => call.args[0] === 'push')).toBe(false);
    expect(h.audits.at(-1)).toMatchObject({ ok: false, detail: 'has-open-pr:296,12' });
  });

  it('refuses a branch missing on the remote', async () => {
    const h = cleanBranchHarness();
    h.answerGit((_cwd, args) => {
      if (args[0] === 'remote')
        return { code: 0, stdout: 'git@github.com:Owner/repo.git\n', stderr: '' };
      if (args[0] === 'ls-remote') return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const handlers = createSecretaryGithubOpsHandlers(h.ports);
    const result = await handlers.github_delete_branch(
      { repo: 'Owner/repo', branch: 'feat/gone' },
      ctx
    );
    expect(result).toEqual({ ok: false, error: 'branch-not-on-remote' });
    expect(h.gitCalls.some((call) => call.args[0] === 'push')).toBe(false);
  });

  it('reports a failed push with stderr', async () => {
    const h = cleanBranchHarness();
    h.answerGit((_cwd, args) => {
      if (args[0] === 'remote')
        return { code: 0, stdout: 'git@github.com:Owner/repo.git\n', stderr: '' };
      if (args[0] === 'ls-remote')
        return { code: 0, stdout: 'abc\trefs/heads/feat/done\n', stderr: '' };
      return { code: 1, stdout: '', stderr: 'remote ref does not exist' };
    });
    const handlers = createSecretaryGithubOpsHandlers(h.ports);
    const result = await handlers.github_delete_branch(
      { repo: 'Owner/repo', branch: 'feat/done' },
      ctx
    );
    expect(result).toEqual({ ok: false, error: 'remote ref does not exist' });
    expect(h.audits.at(-1)).toMatchObject({ ok: false });
  });

  it('rejects unsafe branch names', async () => {
    const h = cleanBranchHarness();
    const handlers = createSecretaryGithubOpsHandlers(h.ports);
    for (const branch of ['-x', 'a..b', 'a b', '', 42]) {
      const result = await handlers.github_delete_branch({ repo: 'Owner/repo', branch }, ctx);
      expect(result.ok).toBe(false);
    }
    expect(h.gitCalls.some((call) => call.args[0] === 'push')).toBe(false);
  });

  it('refuses a repo outside the visible projects', async () => {
    const h = cleanBranchHarness();
    const handlers = createSecretaryGithubOpsHandlers(h.ports);
    const result = await handlers.github_delete_branch(
      { repo: 'evil/repo', branch: 'feat/x' },
      ctx
    );
    expect(result).toEqual({ ok: false, error: 'repo-not-visible-project-origin' });
    expect(h.ghCalls).toHaveLength(0);
  });
});
