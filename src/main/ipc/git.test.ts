import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  root: '',
  repo: '',
  managed: '',
  projects: new Map<string, any>(),
  conversations: new Map<string, any>(),
  open: vi.fn(),
  status: vi.fn(),
  stage: vi.fn(),
  discard: vi.fn(),
  fileDiff: vi.fn(),
  running: vi.fn(),
  freeze: vi.fn(),
  thaw: vi.fn(),
  create: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => mocks.root },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) =>
      mocks.handlers.set(channel, handler),
  },
}));
vi.mock('../windows/MainWindow', () => ({ isMainWebContents: (id: number) => id === 1 }));
vi.mock('../services/terminalService', () => ({ pickSessionCwd: vi.fn() }));
vi.mock('./agent', () => ({
  getSourceAuthorityRegistry: () => ({
    project: (id: string) => mocks.projects.get(id),
    conversation: (id: string) => mocks.conversations.get(id),
    projection: () => ({ conversations: [...mocks.conversations.values()] }),
  }),
}));
vi.mock('./capabilities', () => ({
  agentSessionIndex: {
    workspaceRoot: (id: string) => id,
    workspaceTreeRunning: mocks.running,
    currentIdentity: vi.fn(),
  },
}));
vi.mock('../services/agentHost', () => ({
  readSettingsState: () => ({}),
  freezeWorkspace: mocks.freeze,
  thawWorkspace: mocks.thaw,
  setWorkspaceBusyResolver: vi.fn(),
}));
vi.mock('../services/worktree/service', () => ({
  createSessionWorktree: mocks.create,
  rebuildSessionWorktree: vi.fn(),
  removeSessionWorktree: vi.fn(),
  repoIsClean: vi.fn(),
  worktreeStatus: vi.fn(),
}));
vi.mock('../services/gitVersionControl', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/gitVersionControl')>()),
  GitRepository: { open: mocks.open },
}));

const request = { conversationId: 'c', projectId: 'p' };
const invoke = (channel: string, value: unknown, sender = 1) =>
  mocks.handlers.get(channel)!({ sender: { id: sender } }, value);

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.projects.clear();
  mocks.conversations.clear();
  mocks.root = mkdtempSync(join(tmpdir(), 'enso-git-ipc-'));
  mocks.repo = join(mocks.root, 'repo');
  mocks.managed = join(mocks.root, 'managed');
  mkdirSync(mocks.repo);
  mkdirSync(join(mocks.repo, '.git'));
  mkdirSync(mocks.managed);
  mkdirSync(join(mocks.managed, '.git'));
  mocks.projects.set('p', {
    projectId: 'p',
    canonicalPath: mocks.repo,
    state: 'active',
    kind: 'local',
  });
  mocks.conversations.set('c', {
    conversationId: 'c',
    projectId: 'p',
    kind: 'root',
    lifecycle: 'ready',
    version: 1,
  });
  mocks.running.mockReturnValue(false);
  mocks.freeze.mockResolvedValue({ ok: true });
  mocks.thaw.mockResolvedValue({ ok: true });
  mocks.stage.mockResolvedValue(undefined);
  mocks.discard.mockResolvedValue(undefined);
  mocks.status.mockResolvedValue({ ok: true, staged: [], unstaged: [] });
  mocks.open.mockResolvedValue({
    status: mocks.status,
    stage: mocks.stage,
    discard: mocks.discard,
    fileDiff: mocks.fileDiff,
  });
  (await import('./worktree')).registerWorktreeHandlers();
  (await import('./git')).registerGitHandlers();
});
afterEach(() => rmSync(mocks.root, { recursive: true, force: true }));

describe('Git IPC 授权和工作区操作门', () => {
  it.each([null, [], {}, { conversationId: 'c', projectId: 1 }])(
    '脏请求不读取仓库 %j',
    async (value) => {
      expect(await invoke('git:status', value)).toMatchObject({
        ok: false,
        code: 'invalid-request',
      });
      expect(mocks.open).not.toHaveBeenCalled();
    }
  );

  it('拒绝不受信窗口、跨项目和 SSH，不采信 renderer cwd', async () => {
    expect(await invoke('git:status', request, 2)).toMatchObject({ ok: false });
    expect(await invoke('git:status', { ...request, projectId: 'other' })).toMatchObject({
      ok: false,
    });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(await invoke('git:status', { ...request, cwd: '/attacker' })).toMatchObject({
      ok: true,
    });
    expect(mocks.open).toHaveBeenCalledWith(mocks.repo, expect.any(Function));
    mocks.open.mockClear();
    mocks.projects.get('p').kind = 'ssh';
    expect(await invoke('git:status', request)).toMatchObject({ ok: false });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('按权威 worktree 绑定读取，并拒绝不同项目的绑定', async () => {
    const registry = (await import('./worktree')).getWorktreeRegistry();
    registry.set({
      conversationId: 'c',
      projectId: 'p',
      repoPath: mocks.repo,
      path: mocks.managed,
      branch: 'feature',
      baseBranch: 'main',
      baseCommit: 'abc',
      createdAt: 1,
    });
    expect(await invoke('git:status', request)).toMatchObject({ ok: true });
    expect(mocks.open).toHaveBeenCalledWith(mocks.managed, expect.any(Function));
    registry.set({ ...registry.get('c')!, projectId: 'other' });
    mocks.open.mockClear();
    expect(await invoke('git:status', request)).toMatchObject({ ok: false });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('running 时允许读取，拒绝暂存且不触发写服务', async () => {
    mocks.running.mockReturnValue(true);
    expect(await invoke('git:status', request)).toMatchObject({ ok: true });
    expect(await invoke('git:stage', { ...request, paths: ['file.txt'] })).toMatchObject({
      ok: false,
      code: 'workspace-running',
    });
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it('拒绝混合路径数组和缺少删除清单，空路径数组只传空数组', async () => {
    expect(await invoke('git:stage', { ...request, paths: ['file.txt', 1] })).toMatchObject({
      ok: false,
    });
    expect(await invoke('git:discard', request)).toMatchObject({ ok: false });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(await invoke('git:stage', { ...request, paths: [] })).toEqual({ ok: true });
    expect(mocks.stage).toHaveBeenCalledWith([]);
  });

  it('并行读取不占用写门，不阻塞暂存和迁移尝试', async () => {
    const { withSessionGitWorkspace } = await import('./worktree');
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = withSessionGitWorkspace(request, false, () => wait);
    expect(await invoke('git:status', request)).toMatchObject({ ok: true });
    expect(await invoke('git:stage', { ...request, paths: [] })).toMatchObject({ ok: true });
    mocks.create.mockRejectedValue(new Error('test migration'));
    expect(await invoke('worktree:create', request)).toMatchObject({
      ok: false,
      error: 'test migration',
    });
    expect(mocks.create).toHaveBeenCalled();
    release();
    await reading;
    expect(await invoke('git:stage', { ...request, paths: [] })).toMatchObject({ ok: true });
  });

  it('迁移已开始时拒绝 Git 读写，避免落到旧目录', async () => {
    let release!: (value: unknown) => void;
    mocks.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const migrating = invoke('worktree:create', request);
    expect(await invoke('git:status', request)).toMatchObject({
      ok: false,
      code: 'workspace-busy',
    });
    expect(await invoke('git:stage', request)).toMatchObject({ ok: false, code: 'workspace-busy' });
    expect(mocks.open).not.toHaveBeenCalled();
    release({
      conversationId: 'c',
      projectId: 'p',
      repoPath: mocks.repo,
      path: mocks.managed,
      branch: 'feature',
      baseBranch: 'main',
      baseCommit: 'abc',
      createdAt: 1,
    });
    await migrating;
  });

  it('Git 写操作与切分支、迁移共用同一个操作门', async () => {
    const { withSessionGitWorkspace } = await import('./worktree');
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = withSessionGitWorkspace(request, true, () => wait);
    expect(
      await invoke('worktree:switch-branch', { conversationId: 'c', branch: 'feature' })
    ).toMatchObject({ ok: false, code: 'busy' });
    expect(await invoke('worktree:create', request)).toMatchObject({ ok: false });
    expect(mocks.create).not.toHaveBeenCalled();
    release();
    await writing;
    expect(await invoke('git:status', request)).toMatchObject({ ok: true });
  });

  it('冻结期间授权变化拒绝写，并且总会解冻和释放门', async () => {
    mocks.freeze.mockImplementation(async () => {
      mocks.conversations.set('c', { ...mocks.conversations.get('c'), version: 2 });
      return { ok: true };
    });
    expect(await invoke('git:stage', request)).toMatchObject({ ok: false, code: 'unavailable' });
    expect(mocks.stage).not.toHaveBeenCalled();
    expect(mocks.thaw).toHaveBeenCalled();
    expect(await invoke('git:status', request)).toMatchObject({ ok: true });
  });

  it('解冻连续失败保留操作门并返回明确恢复信息', async () => {
    mocks.thaw.mockResolvedValue({ ok: false });
    expect(await invoke('git:stage', request)).toMatchObject({
      ok: false,
      code: 'workspace-blocked',
    });
    expect(mocks.thaw).toHaveBeenCalledTimes(2);
    expect(await invoke('git:status', request)).toMatchObject({
      ok: false,
      code: 'workspace-busy',
    });
  });

  it('预览不可用返回标记，普通 Git 异常保留可展示原因', async () => {
    const { GitPreviewUnavailable } = await import('../services/gitVersionControl');
    mocks.fileDiff.mockRejectedValue(
      new GitPreviewUnavailable('binary', '二进制文件不支持文本预览。')
    );
    expect(
      await invoke('git:file-diff', { ...request, path: 'binary.dat', staged: true })
    ).toMatchObject({ ok: false, unavailable: true, code: 'binary' });
    mocks.status.mockRejectedValue(new Error('git unavailable'));
    expect(await invoke('git:status', request)).toMatchObject({
      ok: false,
      error: 'git unavailable',
      code: 'git-error',
    });
  });
});
