import type { ProjectAuthority } from '@shared/types/agent';
import type {
  CleanupItem,
  CleanupListDetail,
  CleanupListSummary,
  SecretaryAuditEntry,
  SecretaryDispatchFile,
} from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import type { RetireResult } from '../worktree/trash';
import {
  applyCleanup,
  branchItemId,
  CLEANUP_DETAIL_MAX_CHARS,
  CLEANUP_DETAIL_PAGE_SIZE,
  CLEANUP_IDLE_MS,
  CLEANUP_SUMMARY_MAX_CHARS,
  CLEANUP_SUMMARY_PER_KIND,
  type CleanupPorts,
  cleanupReportText,
  collectCleanupItems,
  createSecretaryCleanupHandlers,
  type MergedPull,
  memoizeAsync,
  parseMergedPulls,
  readCleanupRepo,
  selectCleanupItems,
  sessionItemId,
  worktreeItemId,
  worktreeState,
} from './cleanup';
import type { GitResult } from './repoStatus';

const ROOT = '/repo/alpha';
const WT_ROOT = '/home/me/project/worktree';

interface FakeWorktree {
  path: string;
  branch: string | null;
  dirty?: boolean;
  /** git status --porcelain 的原样输出，优先于 dirty */
  status?: string;
  /** .git 文件丢了：rev-parse --show-toplevel 找到的是外层仓库 */
  lostGitFile?: boolean;
}

interface FakeRepo {
  root: string;
  current: string;
  /** 分支 → 已合入的基线 */
  branches: Record<string, string[]>;
  worktrees: FakeWorktree[];
  /** 每个分支的最后提交时间（秒） */
  commits?: Record<string, number>;
  /** 分支 tip 的提交号，缺省为 oid-<分支名> */
  tips?: Record<string, string>;
}

const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' });
const fail = (code = 1): GitResult => ({ code, stdout: '', stderr: 'fatal' });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const tipOf = (repo: FakeRepo, name: string) => repo.tips?.[name] ?? `oid-${name}`;

function makePorts(options: {
  repos?: FakeRepo[];
  rows?: Record<string, Record<string, unknown>>;
  file?: SecretaryDispatchFile;
  sizes?: Record<string, number>;
  now?: number;
  roots?: string[];
  /** 每次 git 调用的延迟，模拟大仓库 */
  gitDelayMs?: number;
  /** 每次 du 的延迟，模拟带 node_modules 的 worktree */
  sizeDelayMs?: number;
  /** 这些仓库的 git 永远不返回 */
  hangRepos?: string[];
  /** GitHub 上已合并的 PR；null 表示 gh 不可用 */
  pulls?: Record<string, MergedPull[] | null>;
  /** removeWorktree 的结果，缺省 trashed */
  retire?: RetireResult['status'];
}) {
  const repos = options.repos ?? [];
  const calls: string[] = [];
  const sizeCalls: string[] = [];
  const archived: { conversationId: string; at: number; via: string }[] = [];
  const audits: SecretaryAuditEntry[] = [];
  const retired: { repoPath: string; target: string; root: string }[] = [];
  const repoOf = (cwd: string): FakeRepo | undefined =>
    repos.find(
      (repo) => repo.root === cwd || repo.worktrees.some((worktree) => worktree.path === cwd)
    );
  const ports: CleanupPorts = {
    async git(cwd, args) {
      calls.push(`${cwd} ${args.join(' ')}`);
      const repo = repoOf(cwd);
      if (!repo) return fail(128);
      if (options.hangRepos?.includes(repo.root)) return new Promise<GitResult>(() => {});
      if (options.gitDelayMs) await sleep(options.gitDelayMs);
      const [command, ...rest] = args;
      if (command === 'rev-parse' && rest[0] === '--show-toplevel') {
        const worktree = repo.worktrees.find((entry) => entry.path === cwd);
        return ok(worktree && !worktree.lostGitFile ? worktree.path : repo.root);
      }
      if (command === 'rev-parse' && rest[0] === '--abbrev-ref') return ok(repo.current);
      if (command === 'for-each-ref') {
        const mergedFlag = rest.find((arg) => arg.startsWith('--merged='));
        const names = Object.keys(repo.branches);
        if (mergedFlag) {
          const base = mergedFlag.slice('--merged='.length).replace(/^refs\/heads\//u, '');
          if (!(base in repo.branches)) return fail(129);
          const merged = names.filter(
            (name) => name === base || (repo.branches[name] ?? []).includes(base)
          );
          return ok(merged.map((name) => `refs/heads/${name}`).join('\n'));
        }
        return ok(
          names
            .map((name) => `refs/heads/${name} ${tipOf(repo, name)} ${repo.commits?.[name] ?? ''}`)
            .join('\n')
        );
      }
      if (command === 'worktree' && rest[0] === 'list') {
        const blocks = [
          `worktree ${repo.root}\nHEAD abc\nbranch refs/heads/${repo.current}`,
          ...repo.worktrees.map(
            (worktree) =>
              `worktree ${worktree.path}\nHEAD def\n${
                worktree.branch ? `branch refs/heads/${worktree.branch}` : 'detached'
              }`
          ),
        ];
        return ok(blocks.join('\n\n'));
      }
      if (command === 'status') {
        const worktree = repo.worktrees.find((entry) => entry.path === cwd);
        if (!worktree) return ok();
        if (worktree.status !== undefined) return ok(worktree.status);
        return worktree.dirty ? ok('?? scratch.txt\n') : ok();
      }
      if (command === 'branch' && rest[0] === '-D') {
        const name = rest[1] ?? '';
        delete repo.branches[name];
        return ok();
      }
      if (command === 'worktree' && rest[0] === 'remove') {
        const target = rest.at(-1);
        repo.worktrees = repo.worktrees.filter((entry) => entry.path !== target);
        return ok();
      }
      if (command === 'worktree' && rest[0] === 'prune') return ok();
      return fail();
    },
    async realpath(target) {
      return target;
    },
    worktreeRoots: () => options.roots ?? [WT_ROOT],
    async size(target) {
      sizeCalls.push(target);
      if (options.sizeDelayMs) await sleep(options.sizeDelayMs);
      return options.sizes?.[target] ?? null;
    },
    async mergedPulls(root) {
      return options.pulls && root in options.pulls ? (options.pulls[root] ?? null) : [];
    },
    projects: () => [project()],
    rows: () => options.rows ?? {},
    dispatchFile: () => options.file ?? emptyFile(),
    archive: (conversationId, at, via) => {
      archived.push({ conversationId, at, via });
    },
    unarchive: () => {},
    // 与生产一致：改名进回收目录后用 git worktree remove 注销登记
    async removeWorktree(repoPath, target, root) {
      retired.push({ repoPath, target, root });
      const status = options.retire ?? 'trashed';
      if (status === 'failed') return { status, reason: 'rename-failed' };
      if (status === 'background') return { status };
      await ports.git(repoPath, ['worktree', 'remove', '--force', target]);
      return { status, trashPath: `${root}/.trash/x` };
    },
    audit: (entry) => audits.push(entry),
    now: () => options.now ?? 10 * CLEANUP_IDLE_MS,
  };
  return { ports, calls, sizeCalls, archived, audits, retired };
}

function project(): ProjectAuthority {
  return {
    projectId: 'p1',
    canonicalPath: ROOT,
    state: 'active',
    kind: 'local',
  } as unknown as ProjectAuthority;
}

function emptyFile(): SecretaryDispatchFile {
  return { version: 1, dispatched: {}, named: [], proposals: {}, outbox: [] };
}

function baseRepo(overrides: Partial<FakeRepo> = {}): FakeRepo {
  return {
    root: ROOT,
    current: 'feat/secretary-agent',
    branches: {
      'feat/secretary-agent': [],
      main: [],
      'feat/done': ['feat/secretary-agent'],
      'feat/open': [],
      'chore/merged': ['main'],
    },
    worktrees: [],
    commits: { 'feat/done': 1_700_000_000, 'feat/open': 1_700_000_100 },
    ...overrides,
  };
}

describe('readCleanupRepo', () => {
  it('只列 feat/ fix/ chore/ 前缀的本地分支，基线自己不算', async () => {
    const { ports } = makePorts({ repos: [baseRepo()] });
    const repo = await readCleanupRepo(ports, ROOT);
    expect(repo?.branches.map((branch) => branch.name)).toEqual([
      'feat/done',
      'feat/open',
      'chore/merged',
    ]);
    expect(repo?.currentBranch).toBe('feat/secretary-agent');
  });

  it('不是仓库时返回 null', async () => {
    const { ports } = makePorts({ repos: [] });
    expect(await readCleanupRepo(ports, ROOT)).toBeNull();
  });
});

describe('collectCleanupItems', () => {
  it('已合入的分支可清理，未合入的带 not-merged', async () => {
    const { ports } = makePorts({ repos: [baseRepo()] });
    const items = await collectCleanupItems(ports);
    const merged = items.find((item) => item.name === 'feat/done');
    const open = items.find((item) => item.name === 'feat/open');
    expect(merged).toMatchObject({ kind: 'branch', mergedInto: ['feat/secretary-agent'] });
    expect(merged?.blocked).toBeUndefined();
    expect(open).toMatchObject({ blocked: 'not-merged' });
    expect(open?.mergedInto).toEqual([]);
  });

  it('当前检出的分支与被 worktree 占用的分支都带 blocked', async () => {
    const { ports } = makePorts({
      repos: [
        baseRepo({
          current: 'feat/done',
          worktrees: [{ path: `${WT_ROOT}/wt-1`, branch: 'chore/merged' }],
        }),
      ],
      sizes: { [`${WT_ROOT}/wt-1`]: 2048 },
    });
    const items = await collectCleanupItems(ports);
    expect(items.find((item) => item.name === 'feat/done')?.blocked).toBe('current-branch');
    expect(items.find((item) => item.name === 'chore/merged')?.blocked).toBe('used-by-worktree');
    const worktree = items.find((item) => item.kind === 'worktree');
    expect(worktree).toMatchObject({
      path: `${WT_ROOT}/wt-1`,
      sizeBytes: 2048,
      mergedInto: ['main'],
    });
  });

  it('回收目录里的与正在后台删的 worktree 不再列', async () => {
    const { ports } = makePorts({
      repos: [
        baseRepo({
          worktrees: [
            { path: `${WT_ROOT}/.trash/wt-old-1`, branch: 'feat/done' },
            { path: `${WT_ROOT}/wt-moving`, branch: 'chore/merged' },
            { path: `${WT_ROOT}/wt-2`, branch: 'chore/merged' },
          ],
        }),
      ],
    });
    const removing = new Set([`${WT_ROOT}/wt-moving`]);
    const items = await collectCleanupItems(
      { ...ports, removingWorktree: (target) => removing.has(target) },
      { sizeBudgetMs: false }
    );
    expect(items.filter((item) => item.kind === 'worktree').map((item) => item.path)).toEqual([
      `${WT_ROOT}/wt-2`,
    ]);
  });

  it('worktree 根之外的检出不算会话 worktree', async () => {
    const { ports } = makePorts({
      repos: [
        baseRepo({
          worktrees: [
            { path: '/Users/me/somewhere/else', branch: 'feat/done' },
            { path: `${WT_ROOT}/wt-2`, branch: 'feat/done' },
          ],
        }),
      ],
    });
    const items = await collectCleanupItems(ports);
    const worktrees = items.filter((item) => item.kind === 'worktree');
    expect(worktrees.map((item) => item.path)).toEqual([`${WT_ROOT}/wt-2`]);
  });

  it('会话只在 goal-complete 且空闲超过一天时进清单', async () => {
    const now = 10 * CLEANUP_IDLE_MS;
    const file: SecretaryDispatchFile = {
      ...emptyFile(),
      dispatched: {
        'c-done': record('c-done', 'goal-complete', 'idle', now - CLEANUP_IDLE_MS - 1),
        'c-fresh': record('c-fresh', 'goal-complete', 'idle', now - 1000),
        'c-running': record('c-running', 'goal-complete', 'running', now - CLEANUP_IDLE_MS - 1),
        'c-turn': record('c-turn', 'turn-ended', 'idle', now - CLEANUP_IDLE_MS - 1),
      },
    };
    const { ports } = makePorts({
      repos: [],
      file,
      now,
      rows: {
        'c-done': { title: '写发布说明' },
        'c-fresh': { title: '刚做完' },
        'c-running': { title: '还在跑' },
        'c-turn': { title: '只结束了一轮' },
      },
    });
    const items = await collectCleanupItems(ports);
    expect(items.map((item) => item.id)).toEqual([sessionItemId('c-done')]);
    expect(items[0]).toMatchObject({
      kind: 'session',
      name: '写发布说明',
      lastActivityAt: now - CLEANUP_IDLE_MS - 1,
    });
  });

  it('已归档的会话不重复列', async () => {
    const now = 10 * CLEANUP_IDLE_MS;
    const file: SecretaryDispatchFile = {
      ...emptyFile(),
      dispatched: {
        'c-done': record('c-done', 'goal-complete', 'idle', now - CLEANUP_IDLE_MS - 1),
      },
    };
    const { ports } = makePorts({
      repos: [],
      file,
      now,
      rows: { 'c-done': { title: '写发布说明', archived: true } },
    });
    expect(await collectCleanupItems(ports)).toEqual([]);
  });
});

function record(
  conversationId: string,
  kind: 'goal-complete' | 'turn-ended',
  lastState: 'idle' | 'running',
  at: number
) {
  return {
    conversationId,
    projectId: 'p1',
    secretaryConversationId: 'sec-1',
    createdAt: at,
    turn: 1,
    lastState,
    lastEventAt: at,
    lastResult: { kind, turn: 1, at },
  };
}

describe('selectCleanupItems', () => {
  it('未知 id 直接拒绝，什么都不删', async () => {
    const { ports, calls } = makePorts({ repos: [baseRepo()] });
    const result = await selectCleanupItems(ports, ['branch|/repo/alpha|nope']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unknown cleanup id');
    expect(calls.some((call) => call.includes('branch -D'))).toBe(false);
  });

  it('未合入的分支拒绝并说明原因', async () => {
    const { ports } = makePorts({ repos: [baseRepo()] });
    const result = await selectCleanupItems(ports, [branchItemId(ROOT, 'feat/open')]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('feat/open: not-merged');
      expect(result.error).toContain('feat/secretary-agent or main');
    }
  });

  it('当前分支与在用分支同样拒绝', async () => {
    const { ports } = makePorts({
      repos: [
        baseRepo({
          current: 'feat/done',
          worktrees: [{ path: `${WT_ROOT}/wt-1`, branch: 'chore/merged' }],
        }),
      ],
    });
    const result = await selectCleanupItems(ports, [
      branchItemId(ROOT, 'feat/done'),
      branchItemId(ROOT, 'chore/merged'),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('current-branch');
      expect(result.error).toContain('used-by-worktree');
    }
  });

  it('只选可清理的条目时按 id 原样返回', async () => {
    const { ports } = makePorts({ repos: [baseRepo()] });
    const result = await selectCleanupItems(ports, [branchItemId(ROOT, 'feat/done')]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items.map((item) => item.name)).toEqual(['feat/done']);
  });

  it('空列表与超量都拒绝', async () => {
    const { ports } = makePorts({ repos: [baseRepo()] });
    expect((await selectCleanupItems(ports, [])).ok).toBe(false);
    const many = Array.from({ length: 101 }, (_, index) => `branch|${ROOT}|b${index}`);
    expect((await selectCleanupItems(ports, many)).ok).toBe(false);
  });
});

describe('applyCleanup', () => {
  const item = (overrides: Partial<CleanupItem>): CleanupItem => ({
    id: 'x',
    kind: 'branch',
    name: 'feat/done',
    ...overrides,
  });

  it('有未提交改动的 worktree 跳过并报告，不删目录', async () => {
    const repo = baseRepo({
      worktrees: [{ path: `${WT_ROOT}/wt-1`, branch: 'feat/done', dirty: true }],
    });
    const { ports, calls, audits } = makePorts({ repos: [repo] });
    const result = await applyCleanup(ports, {
      items: [
        item({
          id: worktreeItemId(`${WT_ROOT}/wt-1`),
          kind: 'worktree',
          name: 'feat/done',
          path: `${WT_ROOT}/wt-1`,
          repoPath: ROOT,
        }),
      ],
    });
    expect(result.skipped).toBe(1);
    expect(result.report[0]).toMatchObject({ action: 'skipped', reason: 'uncommitted-changes' });
    expect(calls.some((call) => call.includes('worktree remove'))).toBe(false);
    expect(audits[0]).toMatchObject({ op: 'cleanup_worktree', ok: false });
  });

  it('先删 worktree 再删分支：同一次清理里分支不再被占用', async () => {
    const repo = baseRepo({
      worktrees: [{ path: `${WT_ROOT}/wt-1`, branch: 'feat/done' }],
    });
    const { ports, calls } = makePorts({ repos: [repo] });
    const result = await applyCleanup(ports, {
      items: [
        item({
          id: branchItemId(ROOT, 'feat/done'),
          kind: 'branch',
          name: 'feat/done',
          repoPath: ROOT,
        }),
        item({
          id: worktreeItemId(`${WT_ROOT}/wt-1`),
          kind: 'worktree',
          name: 'feat/done',
          path: `${WT_ROOT}/wt-1`,
          repoPath: ROOT,
        }),
      ],
    });
    expect(result.deleted).toBe(2);
    const removeAt = calls.findIndex((call) => call.includes('worktree remove'));
    const deleteAt = calls.findIndex((call) => call.includes('branch -D'));
    expect(removeAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(removeAt);
  });

  const worktreeItem = (target: string) =>
    item({
      id: worktreeItemId(target),
      kind: 'worktree',
      name: 'feat/done',
      path: target,
      repoPath: ROOT,
    });

  it('worktree 走改名进回收目录：报告已删、空间后台释放，审计带上', async () => {
    const target = `${WT_ROOT}/wt-1`;
    const { ports, retired, audits } = makePorts({
      repos: [baseRepo({ worktrees: [{ path: target, branch: 'feat/done' }] })],
    });
    const result = await applyCleanup(ports, { items: [worktreeItem(target)] });
    expect(retired).toEqual([{ repoPath: ROOT, target, root: WT_ROOT }]);
    expect(result.report[0]).toMatchObject({ action: 'deleted', background: 'free-space' });
    expect(cleanupReportText(result)).toContain('freed in the background');
    expect(audits[0]?.detail).toContain('background: free-space');
  });

  it('半删残局（只剩 " D" 删除）判定为可清理', async () => {
    const target = `${WT_ROOT}/wt-1`;
    const status = ' D src/a.ts\n D src/b.ts\n D package.json\n';
    const { ports, retired, audits } = makePorts({
      repos: [baseRepo({ worktrees: [{ path: target, branch: 'feat/done', status }] })],
    });
    expect(await worktreeState(ports, target)).toBe('half-removed');
    const result = await applyCleanup(ports, { items: [worktreeItem(target)] });
    expect(retired).toHaveLength(1);
    expect(result.report[0]).toMatchObject({ action: 'deleted', halfRemoved: true });
    expect(audits[0]?.detail).toContain('half-removed');
  });

  it.each([
    ['夹着一个修改', ' D src/a.ts\n M src/b.ts\n'],
    ['夹着一个未跟踪文件', ' D src/a.ts\n?? notes.md\n'],
    ['暂存区里的删除', 'D  src/a.ts\n'],
    ['删除又暂存了改动', 'MD src/a.ts\n'],
  ])('残局里%s照旧跳过', async (_label, status) => {
    const target = `${WT_ROOT}/wt-1`;
    const { ports, retired } = makePorts({
      repos: [baseRepo({ worktrees: [{ path: target, branch: 'feat/done', status }] })],
    });
    const result = await applyCleanup(ports, { items: [worktreeItem(target)] });
    expect(result.report[0]).toMatchObject({ action: 'skipped', reason: 'uncommitted-changes' });
    expect(retired).toEqual([]);
  });

  it('.git 文件也被删了、git 落到外层仓库时不按外层状态判', async () => {
    const target = `${WT_ROOT}/wt-1`;
    const { ports, retired } = makePorts({
      repos: [baseRepo({ worktrees: [{ path: target, branch: 'feat/done', lostGitFile: true }] })],
    });
    const result = await applyCleanup(ports, { items: [worktreeItem(target)] });
    expect(result.report[0]).toMatchObject({ action: 'skipped', reason: 'uncommitted-changes' });
    expect(retired).toEqual([]);
  });

  it('不在 worktree 根下的不删', async () => {
    const target = '/private/tmp/author/wt-1';
    const { ports, retired } = makePorts({
      repos: [baseRepo({ worktrees: [{ path: target, branch: 'feat/done' }] })],
    });
    const result = await applyCleanup(ports, { items: [worktreeItem(target)] });
    expect(result.report[0]).toMatchObject({
      action: 'skipped',
      reason: 'outside-worktree-root',
    });
    expect(retired).toEqual([]);
  });

  it('跨卷退回后台删除：报告 background remove', async () => {
    const target = `${WT_ROOT}/wt-1`;
    const { ports } = makePorts({
      repos: [baseRepo({ worktrees: [{ path: target, branch: 'feat/done' }] })],
      retire: 'background',
    });
    const result = await applyCleanup(ports, { items: [worktreeItem(target)] });
    expect(result.report[0]).toMatchObject({ action: 'deleted', background: 'remove' });
    expect(cleanupReportText(result)).toContain('removed in the background');
  });

  it('改名失败：跳过并报告，原样保留', async () => {
    const target = `${WT_ROOT}/wt-1`;
    const { ports } = makePorts({
      repos: [baseRepo({ worktrees: [{ path: target, branch: 'feat/done' }] })],
      retire: 'failed',
    });
    const result = await applyCleanup(ports, { items: [worktreeItem(target)] });
    expect(result.report[0]).toMatchObject({
      action: 'skipped',
      reason: 'remove-failed: rename-failed',
    });
  });

  it('未合入的分支在执行时也拒绝', async () => {
    const { ports, calls } = makePorts({ repos: [baseRepo()] });
    const result = await applyCleanup(ports, {
      items: [
        item({
          id: branchItemId(ROOT, 'feat/open'),
          kind: 'branch',
          name: 'feat/open',
          repoPath: ROOT,
        }),
      ],
    });
    expect(result.report[0]).toMatchObject({ action: 'skipped', reason: 'not-merged' });
    expect(calls.some((call) => call.includes('branch -D'))).toBe(false);
  });

  it('会话只归档，不删除', async () => {
    const now = 10 * CLEANUP_IDLE_MS;
    const { ports, archived, audits } = makePorts({
      repos: [],
      now,
      rows: { 'c-done': { title: '写发布说明' } },
    });
    const result = await applyCleanup(ports, {
      items: [item({ id: sessionItemId('c-done'), kind: 'session', name: '写发布说明' })],
    });
    expect(result.archived).toBe(1);
    // 记下是清理归档的：之后秘书能用 session_unarchive 拉回来
    expect(archived).toEqual([{ conversationId: 'c-done', at: now, via: 'cleanup_apply' }]);
    expect(audits[0]).toMatchObject({ op: 'cleanup_session', ok: true });
    expect(cleanupReportText(result)).toContain('archived 1');
  });
});

describe('cleanup_apply 走确认卡', () => {
  function harness() {
    const { ports, calls, audits } = makePorts({ repos: [baseRepo()] });
    const proposals: CleanupItem[][] = [];
    const handlers = createSecretaryCleanupHandlers({
      ...ports,
      saveProposal: async (items) => {
        proposals.push(items);
        return { proposalId: 'proposal-1', reused: false };
      },
    });
    return { handlers, calls, audits, proposals };
  }

  it('只落提案，不删任何东西', async () => {
    const { handlers, calls, proposals, audits } = harness();
    const result = await handlers.cleanup_apply(
      { ids: [branchItemId(ROOT, 'feat/done')] },
      { secretaryConversationId: 'sec-1' }
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.result).toMatchObject({
        status: 'awaiting_confirmation',
        proposalId: 'proposal-1',
      });
    expect(proposals[0]?.map((item) => item.name)).toEqual(['feat/done']);
    expect(calls.some((call) => call.includes('branch -D'))).toBe(false);
    expect(audits.at(-1)).toMatchObject({ op: 'cleanup_apply', detail: 'awaiting_confirmation' });
  });

  it('未合入的分支连提案都不落', async () => {
    const { handlers, proposals } = harness();
    const result = await handlers.cleanup_apply(
      { ids: [branchItemId(ROOT, 'feat/open')] },
      { secretaryConversationId: 'sec-1' }
    );
    expect(result.ok).toBe(false);
    expect(proposals).toEqual([]);
  });

  it('同类卡已经在等时把复用结果原样回给秘书', async () => {
    const { ports, audits } = makePorts({ repos: [baseRepo()] });
    const handlers = createSecretaryCleanupHandlers({
      ...ports,
      saveProposal: async () => ({
        proposalId: 'proposal-1',
        reused: true,
        note: 'A card for this exact request is already waiting for you (proposalId=proposal-1).',
      }),
    });
    const result = await handlers.cleanup_apply(
      { ids: [branchItemId(ROOT, 'feat/done')] },
      { secretaryConversationId: 'sec-1' }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toMatchObject({
      status: 'awaiting_confirmation',
      proposalId: 'proposal-1',
      reused: true,
    });
    expect((result.result as { note?: string }).note).toContain('proposalId=proposal-1');
    expect(audits.at(-1)).toMatchObject({ detail: 'awaiting_confirmation (existing)' });
  });

  it('cleanup_list 只读，返回条目与审计', async () => {
    const { handlers, audits } = harness();
    const result = await handlers.cleanup_list({}, { secretaryConversationId: 'sec-1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const summary = result.result as CleanupListSummary;
      expect(summary.mode).toBe('summary');
      expect(summary.items.some((entry) => entry.name === 'feat/done')).toBe(true);
    }
    expect(audits.at(-1)).toMatchObject({ op: 'cleanup_list', ok: true });
  });
});

describe('cleanup_apply 不用确认', () => {
  function direct(
    skip: boolean | undefined,
    repo: FakeRepo = baseRepo(),
    busy: ReadonlySet<string> = new Set()
  ) {
    const made = makePorts({ repos: [repo] });
    const proposals: CleanupItem[][] = [];
    const handlers = createSecretaryCleanupHandlers({
      ...made.ports,
      busyWorktrees: () => busy,
      ...(skip === undefined ? {} : { skipConfirm: () => skip }),
      saveProposal: async (items) => {
        proposals.push(items);
        return { proposalId: 'proposal-1', reused: false };
      },
    });
    return { ...made, handlers, proposals };
  }
  const ctx = { secretaryConversationId: 'sec-1' };
  const deletes = (calls: string[]) => calls.filter((call) => call.includes('branch -D'));

  it('开关缺省或关着时照旧落确认卡', async () => {
    for (const skip of [undefined, false]) {
      const h = direct(skip);
      const result = await h.handlers.cleanup_apply(
        { ids: [branchItemId(ROOT, 'feat/done')] },
        ctx
      );
      expect(result.ok && result.result).toMatchObject({ status: 'awaiting_confirmation' });
      expect(h.proposals.length).toBe(1);
      expect(deletes(h.calls)).toEqual([]);
    }
  });

  it('开着时不落卡，直接删并回报每一项的结果', async () => {
    const h = direct(true);
    const result = await h.handlers.cleanup_apply(
      { ids: [branchItemId(ROOT, 'feat/done'), branchItemId(ROOT, 'chore/merged')] },
      ctx
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toMatchObject({
      status: 'applied',
      total: 2,
      deleted: 2,
      skipped: 0,
      items: [
        { kind: 'branch', name: 'feat/done', result: 'deleted' },
        { kind: 'branch', name: 'chore/merged', result: 'deleted' },
      ],
    });
    expect(h.proposals).toEqual([]);
    expect(deletes(h.calls).length).toBe(2);
    expect(h.audits.at(-1)).toMatchObject({
      op: 'cleanup_apply',
      secretaryConversationId: 'sec-1',
      ok: true,
    });
    expect(h.audits.at(-1)?.detail).toContain('without confirmation');
    expect(h.audits.at(-1)?.detail).toContain('deleted 2');
    expect(
      h.audits.filter((entry) => entry.op === 'cleanup_branch').map((entry) => entry.targetId)
    ).toEqual([branchItemId(ROOT, 'feat/done'), branchItemId(ROOT, 'chore/merged')]);
  });

  it('开着时未合入、当前分支与基线分支照样拒绝，什么都不删', async () => {
    for (const name of ['feat/open', 'feat/secretary-agent', 'main']) {
      const h = direct(true);
      const result = await h.handlers.cleanup_apply({ ids: [branchItemId(ROOT, name)] }, ctx);
      expect(result.ok).toBe(false);
      expect(deletes(h.calls)).toEqual([]);
      expect(h.audits.at(-1)).toMatchObject({ op: 'cleanup_apply', ok: false });
    }
    const current = direct(true, baseRepo({ current: 'feat/done' }));
    const refused = await current.handlers.cleanup_apply(
      { ids: [branchItemId(ROOT, 'feat/done')] },
      ctx
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain('current-branch');
    expect(deletes(current.calls)).toEqual([]);
  });

  it('开着时正在使用的 worktree 拒绝，刚列过清单也按现在的事实判', async () => {
    const target = `${WT_ROOT}/wt-1`;
    const busy = new Set<string>();
    const h = direct(true, baseRepo({ worktrees: [{ path: target, branch: 'feat/done' }] }), busy);
    await h.handlers.cleanup_list({}, ctx);
    busy.add(target);
    const result = await h.handlers.cleanup_apply({ ids: [worktreeItemId(target)] }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('in-use');
    expect(h.calls.some((call) => call.includes('worktree remove'))).toBe(false);
  });

  it('开着时有未提交改动的 worktree 跳过并带原因', async () => {
    const target = `${WT_ROOT}/wt-1`;
    const h = direct(
      true,
      baseRepo({ worktrees: [{ path: target, branch: 'feat/done', dirty: true }] })
    );
    const result = await h.handlers.cleanup_apply({ ids: [worktreeItemId(target)] }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toMatchObject({
      status: 'applied',
      deleted: 0,
      skipped: 1,
      items: [{ kind: 'worktree', result: 'skipped', reason: 'uncommitted-changes' }],
    });
    expect(h.calls.some((call) => call.includes('worktree remove'))).toBe(false);
  });

  it('两个秘书各看各的开关', async () => {
    const repo = baseRepo();
    const { ports } = makePorts({ repos: [repo] });
    const proposals: string[] = [];
    const handlersOf = (skip: boolean, who: string) =>
      createSecretaryCleanupHandlers({
        ...ports,
        skipConfirm: () => skip,
        saveProposal: async () => {
          proposals.push(who);
          return { proposalId: `proposal-${who}`, reused: false };
        },
      });
    const careful = await handlersOf(false, 'a').cleanup_apply(
      { ids: [branchItemId(ROOT, 'chore/merged')] },
      { secretaryConversationId: 'sec-a' }
    );
    const quick = await handlersOf(true, 'b').cleanup_apply(
      { ids: [branchItemId(ROOT, 'feat/done')] },
      { secretaryConversationId: 'sec-b' }
    );
    expect(careful.ok && careful.result).toMatchObject({ status: 'awaiting_confirmation' });
    expect(quick.ok && quick.result).toMatchObject({ status: 'applied', deleted: 1 });
    expect(proposals).toEqual(['a']);
    expect(Object.keys(repo.branches)).toContain('chore/merged');
    expect(Object.keys(repo.branches)).not.toContain('feat/done');
  });
});

/** 造一批条目：分支、worktree、会话都够多，用来量精简与分页的字数 */
function bulkPorts(branches: number, worktrees: number, options: { longName?: boolean } = {}) {
  const map: Record<string, string[]> = { 'feat/secretary-agent': [], main: [] };
  const suffix = options.longName ? `-${'x'.repeat(160)}` : '';
  for (let i = 0; i < branches; i += 1) map[`feat/b-${i}${suffix}`] = ['main'];
  const sizes: Record<string, number> = {};
  const worktreeList = Array.from({ length: worktrees }, (_, i) => {
    const target = `${WT_ROOT}/wt-${i}`;
    sizes[target] = (i + 1) * 1024 * 1024;
    return { path: target, branch: `feat/b-${i}${suffix}` };
  });
  const now = 10 * CLEANUP_IDLE_MS;
  const dispatched: SecretaryDispatchFile['dispatched'] = {};
  const rows: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < 6; i += 1) {
    const id = `c-${i}`;
    dispatched[id] = record(id, 'goal-complete', 'idle', now - CLEANUP_IDLE_MS - 1);
    rows[id] = { title: `会话 ${i}` };
  }
  const made = makePorts({
    repos: [baseRepo({ branches: map, worktrees: worktreeList })],
    sizes,
    now,
    rows,
    file: { ...emptyFile(), dispatched },
  });
  const proposals: CleanupItem[][] = [];
  const handlers = createSecretaryCleanupHandlers({
    ...made.ports,
    saveProposal: async (items) => {
      proposals.push(items);
      return { proposalId: 'proposal-1', reused: false };
    },
  });
  return { ...made, handlers, proposals };
}

describe('cleanup_list 精简模式', () => {
  it('只给总数、分组数量、估算空间与每类前几条', async () => {
    const { handlers } = bulkPorts(12, 7);
    const result = await handlers.cleanup_list({}, { secretaryConversationId: 'sec-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary = result.result as CleanupListSummary;
    expect(summary.mode).toBe('summary');
    expect(summary.total).toBe(12 + 7 + 6);
    expect(summary.counts).toEqual({ branch: 12, worktree: 7, session: 6 });
    // 7 条分支被 worktree 占用，剩下的 5 条分支、7 个 worktree 与 6 个会话都能清
    expect(summary.cleanable).toBe(5 + 7 + 6);
    expect(summary.estimatedBytes).toBe(
      Array.from({ length: 7 }, (_, i) => (i + 1) * 1024 * 1024).reduce((a, b) => a + b, 0)
    );
    for (const kind of ['branch', 'worktree', 'session'] as const)
      expect(summary.items.filter((item) => item.kind === kind).length).toBeLessThanOrEqual(
        CLEANUP_SUMMARY_PER_KIND
      );
    // 每条只有 id、名字、大小与短原因码，没有路径与合入详情
    const allowed = new Set(['id', 'kind', 'name', 'sizeBytes', 'blocked']);
    for (const item of summary.items)
      for (const key of Object.keys(item)) expect(allowed.has(key), key).toBe(true);
    expect(summary.hint).toContain('detail: true');
  });

  it('正文不超过两千字，名字再长也一样', async () => {
    const { handlers } = bulkPorts(12, 7, { longName: true });
    const result = await handlers.cleanup_list({}, { secretaryConversationId: 'sec-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.result).length).toBeLessThanOrEqual(CLEANUP_SUMMARY_MAX_CHARS);
  });

  it('可清理的排在前几条，blocked 的带短原因码', async () => {
    const { handlers } = bulkPorts(6, 0);
    const result = await handlers.cleanup_list(
      { kind: 'branch' },
      { secretaryConversationId: 'sec-1' }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary = result.result as CleanupListSummary;
    expect(summary.items.every((item) => item.kind === 'branch')).toBe(true);
    expect(summary.items.every((item) => item.blocked === undefined)).toBe(true);
    expect(summary.counts.branch).toBe(6);
  });
});

describe('cleanup_list detail 模式', () => {
  it('分页给出 total、page、pageSize、hasMore，翻页不漏不重', async () => {
    const { handlers } = bulkPorts(30, 12);
    const seen: string[] = [];
    let page = 1;
    let expectedPageSize = 0;
    for (;;) {
      const result = await handlers.cleanup_list(
        { detail: true, page },
        { secretaryConversationId: 'sec-1' }
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const detail = result.result as CleanupListDetail;
      expect(detail.mode).toBe('detail');
      expect(detail.total).toBe(30 + 12 + 6);
      expect(detail.page).toBe(page);
      expect(detail.pageSize).toBeLessThanOrEqual(CLEANUP_DETAIL_PAGE_SIZE);
      if (expectedPageSize === 0) expectedPageSize = detail.pageSize;
      // 每页条数固定：按页临时缩会让翻页漏条目
      expect(detail.pageSize).toBe(expectedPageSize);
      expect(JSON.stringify(detail).length).toBeLessThanOrEqual(CLEANUP_DETAIL_MAX_CHARS);
      seen.push(...detail.items.map((item) => item.id));
      if (!detail.hasMore) break;
      page += 1;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(30 + 12 + 6);
  });

  it('超出末页时给空页且 hasMore 为假', async () => {
    const { handlers } = bulkPorts(3, 0);
    const result = await handlers.cleanup_list(
      { detail: true, page: 99 },
      { secretaryConversationId: 'sec-1' }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const detail = result.result as CleanupListDetail;
    expect(detail.items).toEqual([]);
    expect(detail.hasMore).toBe(false);
  });
});

describe('cleanup_list 筛选', () => {
  it('kind 只返回这一类，未知 kind 直接报错', async () => {
    const { handlers } = bulkPorts(4, 2);
    const worktrees = await handlers.cleanup_list(
      { kind: 'worktree' },
      { secretaryConversationId: 'sec-1' }
    );
    expect(worktrees.ok).toBe(true);
    if (worktrees.ok) {
      const summary = worktrees.result as CleanupListSummary;
      expect(summary.total).toBe(2);
      expect(summary.items.every((item) => item.kind === 'worktree')).toBe(true);
    }
    const bad = await handlers.cleanup_list(
      { kind: 'branch2' },
      { secretaryConversationId: 'sec-1' }
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('unknown kind');
  });
});

describe('cleanup_apply 的 id 与 all', () => {
  it('精简模式给出的 id 可以直接传给 cleanup_apply', async () => {
    const { handlers, proposals } = bulkPorts(6, 0);
    const listed = await handlers.cleanup_list(
      { kind: 'branch' },
      { secretaryConversationId: 'sec-1' }
    );
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const id = (listed.result as CleanupListSummary).items[0]?.id ?? '';
    expect(id).not.toBe('');
    const applied = await handlers.cleanup_apply(
      { ids: [id] },
      { secretaryConversationId: 'sec-1' }
    );
    expect(applied.ok).toBe(true);
    expect(proposals[0]?.map((item) => item.id)).toEqual([id]);
  });

  it('all: true 收下当前所有可清理项，仍然只落确认卡', async () => {
    const { handlers, proposals, calls } = bulkPorts(6, 0);
    const applied = await handlers.cleanup_apply(
      { all: true },
      { secretaryConversationId: 'sec-1' }
    );
    expect(applied.ok).toBe(true);
    expect(proposals[0]?.length).toBe(6 + 6);
    expect(proposals[0]?.every((item) => !item.blocked)).toBe(true);
    expect(calls.some((call) => call.includes('branch -D'))).toBe(false);
    // 回给模型的只有总数与前几条，清单在确认卡上
    if (applied.ok) {
      const result = applied.result as { total: number; items: CleanupItem[] };
      expect(result.total).toBe(12);
      expect(result.items.length).toBe(CLEANUP_SUMMARY_PER_KIND);
    }
  });

  it('既没 ids 也没 all 时说清楚怎么给', async () => {
    const { handlers } = bulkPorts(1, 0);
    const applied = await handlers.cleanup_apply({}, { secretaryConversationId: 'sec-1' });
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.error).toContain('all: true');
  });
});

/** 现场规模：上百条前缀分支、45 个 worktree，git 与 du 都慢 */
function bigRepo(branches: number, worktrees: number): FakeRepo {
  const map: Record<string, string[]> = { 'feat/secretary-agent': [], main: [] };
  for (let i = 0; i < branches; i += 1) map[`feat/b-${i}`] = i % 2 === 0 ? ['main'] : [];
  return baseRepo({
    branches: map,
    worktrees: Array.from({ length: worktrees }, (_, i) => ({
      path: `${WT_ROOT}/wt-${i}`,
      branch: `feat/b-${i}`,
    })),
  });
}

function race<T>(promise: T | Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([promise, sleep(ms).then(() => 'timeout' as const)]);
}

describe('cleanup_list 在大仓库上不超时', () => {
  it('100 条分支、45 个 worktree，git 调用次数不随条目数增长', async () => {
    const { ports, calls } = makePorts({ repos: [bigRepo(100, 45)] });
    const items = await collectCleanupItems(ports);
    expect(items.filter((item) => item.kind === 'branch')).toHaveLength(100);
    expect(items.filter((item) => item.kind === 'worktree')).toHaveLength(45);
    expect(calls.length).toBeLessThanOrEqual(10);
  });

  it('du 很慢时先返回清单，占用标成待算，不等 du', async () => {
    const { ports } = makePorts({
      repos: [bigRepo(100, 45)],
      gitDelayMs: 20,
      sizeDelayMs: 1500,
    });
    const handlers = createSecretaryCleanupHandlers(
      { ...ports, saveProposal: async () => ({ proposalId: 'p', reused: false }) },
      { sizeBudgetMs: 100 }
    );
    const result = await race(
      handlers.cleanup_list({}, { secretaryConversationId: 'sec-1' }),
      1000
    );
    expect(result).not.toBe('timeout');
    if (result === 'timeout' || !result.ok) return;
    const summary = result.result as CleanupListSummary;
    expect(summary.counts.worktree).toBe(45);
    expect(summary.sizesPending).toBeGreaterThan(0);
  });

  it('某个仓库的 git 卡住时，到期限返回其余仓库的结果并标 incomplete', async () => {
    const stuck = baseRepo({ root: '/repo/stuck' });
    const made = makePorts({ repos: [baseRepo(), stuck], hangRepos: ['/repo/stuck'] });
    const handlers = createSecretaryCleanupHandlers(
      {
        ...made.ports,
        projects: () => [
          project(),
          { ...project(), projectId: 'p2', canonicalPath: '/repo/stuck' } as ProjectAuthority,
        ],
        saveProposal: async () => ({ proposalId: 'p', reused: false }),
      },
      { scanDeadlineMs: 200 }
    );
    const result = await race(
      handlers.cleanup_list({ detail: true }, { secretaryConversationId: 'sec-1' }),
      1500
    );
    expect(result).not.toBe('timeout');
    if (result === 'timeout' || !result.ok) return;
    const detail = result.result as CleanupListDetail;
    expect(detail.incomplete).toEqual(['/repo/stuck']);
    expect(detail.items.some((item) => item.name === 'feat/done')).toBe(true);
  });
});

describe('squash 合并的分支', () => {
  it('GitHub 已合并 PR 的 head 与分支 tip 一致才算合入', async () => {
    const repo = baseRepo({
      branches: {
        'feat/secretary-agent': [],
        main: [],
        'feat/squashed': [],
        'feat/moved-on': [],
      },
      tips: { 'feat/squashed': 'aaa', 'feat/moved-on': 'ccc' },
    });
    const { ports } = makePorts({
      repos: [repo],
      pulls: {
        [ROOT]: [
          { headRefOid: 'aaa', baseRefName: 'main' },
          // 合并后又提交过：tip 对不上，不算合入
          { headRefOid: 'bbb', baseRefName: 'main' },
        ],
      },
    });
    const items = await collectCleanupItems(ports);
    expect(items.find((item) => item.name === 'feat/squashed')).toMatchObject({
      mergedInto: ['main'],
    });
    expect(items.find((item) => item.name === 'feat/squashed')?.blocked).toBeUndefined();
    expect(items.find((item) => item.name === 'feat/moved-on')?.blocked).toBe('not-merged');
  });

  it('合进别的分支的 PR 不算', async () => {
    const repo = baseRepo({
      branches: { main: [], 'feat/stacked': [] },
      tips: { 'feat/stacked': 'aaa' },
    });
    const { ports } = makePorts({
      repos: [repo],
      pulls: { [ROOT]: [{ headRefOid: 'aaa', baseRefName: 'feat/other' }] },
    });
    const items = await collectCleanupItems(ports);
    expect(items.find((item) => item.name === 'feat/stacked')?.blocked).toBe('not-merged');
  });

  it('执行时同样认 squash 合并，删掉分支', async () => {
    const repo = baseRepo({
      branches: { main: [], 'feat/squashed': [] },
      tips: { 'feat/squashed': 'aaa' },
    });
    const { ports, calls } = makePorts({
      repos: [repo],
      pulls: { [ROOT]: [{ headRefOid: 'aaa', baseRefName: 'main' }] },
    });
    const result = await applyCleanup(ports, {
      items: [
        {
          id: branchItemId(ROOT, 'feat/squashed'),
          kind: 'branch',
          name: 'feat/squashed',
          repoPath: ROOT,
        },
      ],
    });
    expect(result.deleted).toBe(1);
    expect(calls.some((call) => call.endsWith('branch -D feat/squashed'))).toBe(true);
  });

  it('gh 不可用时给出提示，squash 的分支保持 not-merged', async () => {
    const repo = baseRepo({ branches: { main: [], 'feat/squashed': [] } });
    const { ports } = makePorts({ repos: [repo], pulls: { [ROOT]: null } });
    const handlers = createSecretaryCleanupHandlers({
      ...ports,
      saveProposal: async () => ({ proposalId: 'p', reused: false }),
    });
    const result = await handlers.cleanup_list({}, { secretaryConversationId: 'sec-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary = result.result as CleanupListSummary;
    expect(summary.warnings?.join(' ')).toContain('GitHub');
    expect(summary.items.find((item) => item.name === 'feat/squashed')?.blocked).toBe('not-merged');
  });
});

describe('cleanup_apply 复用 cleanup_list 的扫描', () => {
  it('刚列过清单时 all: true 不再重新扫描', async () => {
    const { handlers, calls, proposals } = bulkPorts(6, 0);
    await handlers.cleanup_list({}, { secretaryConversationId: 'sec-1' });
    const before = calls.length;
    const applied = await handlers.cleanup_apply(
      { all: true },
      { secretaryConversationId: 'sec-1' }
    );
    expect(applied.ok).toBe(true);
    expect(calls.length).toBe(before);
    expect(proposals[0]?.length).toBe(6 + 6);
  });

  it('按 id 申请也复用，不重新扫描', async () => {
    const { handlers, calls } = bulkPorts(6, 0);
    await handlers.cleanup_list({}, { secretaryConversationId: 'sec-1' });
    const before = calls.length;
    const applied = await handlers.cleanup_apply(
      { ids: [branchItemId(ROOT, 'feat/b-0')] },
      { secretaryConversationId: 'sec-1' }
    );
    expect(applied.ok).toBe(true);
    expect(calls.length).toBe(before);
  });

  it('执行过清理后缓存作废，下一次重新扫描', async () => {
    const { handlers, calls, ports } = bulkPorts(6, 0);
    await handlers.cleanup_list({}, { secretaryConversationId: 'sec-1' });
    await applyCleanup(ports, {
      items: [
        { id: branchItemId(ROOT, 'feat/b-0'), kind: 'branch', name: 'feat/b-0', repoPath: ROOT },
      ],
    });
    const before = calls.length;
    const applied = await handlers.cleanup_apply(
      { ids: [branchItemId(ROOT, 'feat/b-0')] },
      { secretaryConversationId: 'sec-1' }
    );
    expect(calls.length).toBeGreaterThan(before);
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.error).toContain('unknown cleanup id');
  });
});

describe('memoizeAsync', () => {
  it('同一个 key 在算时共用一次调用，算完按 ttl 留着，过期再算', async () => {
    let clock = 0;
    let runs = 0;
    const cached = memoizeAsync(
      async (key: string) => {
        runs += 1;
        await sleep(5);
        return `${key}-${runs}`;
      },
      () => 100,
      () => clock
    );
    const [a, b] = await Promise.all([cached('x'), cached('x')]);
    expect([a, b]).toEqual(['x-1', 'x-1']);
    expect(await cached('x')).toBe('x-1');
    clock = 101;
    expect(await cached('x')).toBe('x-2');
    expect(runs).toBe(2);
  });

  it('失败不缓存', async () => {
    let runs = 0;
    const cached = memoizeAsync(
      async () => {
        runs += 1;
        if (runs === 1) throw new Error('boom');
        return 1;
      },
      () => 1000
    );
    await expect(cached('x')).rejects.toThrow('boom');
    expect(await cached('x')).toBe(1);
  });
});

describe('parseMergedPulls', () => {
  it('只收字段齐全的条目，坏输出给 null', () => {
    expect(
      parseMergedPulls(
        JSON.stringify([
          { headRefOid: 'aaa', baseRefName: 'main' },
          { headRefOid: '', baseRefName: 'main' },
          { baseRefName: 'main' },
          null,
        ])
      )
    ).toEqual([{ headRefOid: 'aaa', baseRefName: 'main' }]);
    expect(parseMergedPulls('not json')).toBeNull();
    expect(parseMergedPulls('{}')).toBeNull();
  });
});
