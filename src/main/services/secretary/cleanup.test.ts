import type { ProjectAuthority } from '@shared/types/agent';
import type {
  CleanupItem,
  CleanupListDetail,
  CleanupListSummary,
  SecretaryAuditEntry,
  SecretaryDispatchFile,
} from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
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
  readCleanupRepo,
  selectCleanupItems,
  sessionItemId,
  worktreeItemId,
} from './cleanup';
import type { GitResult } from './repoStatus';

const ROOT = '/repo/alpha';
const WT_ROOT = '/home/me/project/worktree';

interface FakeWorktree {
  path: string;
  branch: string | null;
  dirty?: boolean;
}

interface FakeRepo {
  root: string;
  current: string;
  /** 分支 → 已合入的基线 */
  branches: Record<string, string[]>;
  worktrees: FakeWorktree[];
  /** 每个分支的最后提交时间（秒） */
  commits?: Record<string, number>;
}

const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' });
const fail = (code = 1): GitResult => ({ code, stdout: '', stderr: 'fatal' });

function makePorts(options: {
  repos?: FakeRepo[];
  rows?: Record<string, Record<string, unknown>>;
  file?: SecretaryDispatchFile;
  sizes?: Record<string, number>;
  now?: number;
  roots?: string[];
}) {
  const repos = options.repos ?? [];
  const calls: string[] = [];
  const archived: { conversationId: string; at: number }[] = [];
  const audits: SecretaryAuditEntry[] = [];
  const repoOf = (cwd: string): FakeRepo | undefined =>
    repos.find(
      (repo) => repo.root === cwd || repo.worktrees.some((worktree) => worktree.path === cwd)
    );
  const ports: CleanupPorts = {
    async git(cwd, args) {
      calls.push(`${cwd} ${args.join(' ')}`);
      const repo = repoOf(cwd);
      if (!repo) return fail(128);
      const [command, ...rest] = args;
      if (command === 'rev-parse' && rest[0] === '--show-toplevel') return ok(repo.root);
      if (command === 'rev-parse' && rest[0] === '--abbrev-ref') return ok(repo.current);
      if (command === 'rev-parse' && rest[0] === '--verify') {
        const ref = rest.at(-1) ?? '';
        const name = ref.replace(/^refs\/heads\//u, '');
        return name in repo.branches ? ok(name) : fail();
      }
      if (command === 'branch' && rest[0] === '--format=%(refname:short)')
        return ok(Object.keys(repo.branches).join('\n'));
      if (command === 'merge-base' && rest[0] === '--is-ancestor') {
        const [branch, base] = [rest[1] ?? '', rest[2] ?? ''];
        return (repo.branches[branch] ?? []).includes(base) ? ok() : fail();
      }
      if (command === 'log') {
        const ref = rest.at(-1) ?? '';
        const at = repo.commits?.[ref];
        return at ? ok(String(at)) : fail();
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
      return options.sizes?.[target] ?? null;
    },
    projects: () => [project()],
    rows: () => options.rows ?? {},
    dispatchFile: () => options.file ?? emptyFile(),
    archive: (conversationId, at) => {
      archived.push({ conversationId, at });
    },
    audit: (entry) => audits.push(entry),
    now: () => options.now ?? 10 * CLEANUP_IDLE_MS,
  };
  return { ports, calls, archived, audits };
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
    expect(archived).toEqual([{ conversationId: 'c-done', at: now }]);
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
