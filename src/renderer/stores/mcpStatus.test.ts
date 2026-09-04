import { beforeEach, describe, expect, it, vi } from 'vitest';

const authorize = vi.fn(async (_id: string) => ({ ok: true }) as { ok: boolean; error?: string });
const revoke = vi.fn(async (_id: string) => ({ ok: true }));
const authState = vi.fn(async () => ({}) as Record<string, boolean>);
const statusSnapshot = vi.fn(async () => [] as unknown[]);
let statusListener: ((event: unknown) => void) | null = null;
const offStatus = vi.fn();

vi.stubGlobal('window', {
  electronAPI: {
    mcp: {
      authorize: (id: string) => authorize(id),
      revoke: (id: string) => revoke(id),
      authState: () => authState(),
      statusSnapshot: () => statusSnapshot(),
      onStatus: (cb: (event: unknown) => void) => {
        statusListener = cb;
        return offStatus;
      },
    },
  },
});

const { applyStatusEvent, beginAuthorize, failAuthorize, statusKey, useMcpStatusStore } =
  await import('./mcpStatus');

describe('statusKey', () => {
  it('优先用 serverId，缺失时兜底 serverName', () => {
    expect(statusKey({ serverId: 'srv-1', serverName: 'notion' })).toBe('srv-1');
    expect(statusKey({ serverName: 'notion' })).toBe('notion');
  });
});

describe('applyStatusEvent', () => {
  it('按 key 写入并保留其它条目', () => {
    const next = applyStatusEvent(
      { other: { state: 'ready', toolCount: 2 } },
      { type: 'mcp-status', serverId: 'srv-1', serverName: 'notion', state: 'connecting' }
    );
    expect(next).toEqual({
      other: { state: 'ready', toolCount: 2 },
      'srv-1': { state: 'connecting' },
    });
  });

  it('ready 覆盖旧 error，不残留原因', () => {
    const next = applyStatusEvent(
      { 'srv-1': { state: 'error', error: '401' } },
      { type: 'mcp-status', serverId: 'srv-1', serverName: 'notion', state: 'ready', toolCount: 12 }
    );
    expect(next['srv-1']).toEqual({ state: 'ready', toolCount: 12 });
  });

  it('带 serverId 的事件迁移掉此前按 serverName 存的条目', () => {
    const next = applyStatusEvent(
      { notion: { state: 'error', error: 'boom' } },
      { type: 'mcp-status', serverId: 'srv-1', serverName: 'notion', state: 'unauthorized' }
    );
    expect(next.notion).toBeUndefined();
    expect(next['srv-1']).toEqual({ state: 'unauthorized' });
  });
});

describe('authorize 本地过渡态', () => {
  it('beginAuthorize 置 connecting 并清 error', () => {
    const next = beginAuthorize({ 'srv-1': { state: 'unauthorized', error: '401' } }, 'srv-1');
    expect(next['srv-1']).toEqual({ state: 'connecting' });
  });

  it('failAuthorize 写 error 原因', () => {
    const next = failAuthorize({ 'srv-1': { state: 'connecting' } }, 'srv-1', 'denied');
    expect(next['srv-1']).toEqual({ state: 'error', error: 'denied' });
  });
});

describe('useMcpStatusStore', () => {
  beforeEach(() => {
    authorize.mockClear();
    revoke.mockClear();
    authState.mockClear();
    statusSnapshot.mockClear();
    offStatus.mockClear();
    statusListener = null;
    useMcpStatusStore.setState({ statuses: {}, authorized: {}, pending: {} });
  });

  it('bind 订阅状态事件并拉一次 authState', async () => {
    authState.mockResolvedValueOnce({ 'srv-1': true });
    const unbind = useMcpStatusStore.getState().bind();
    await vi.waitFor(() => expect(useMcpStatusStore.getState().authorized['srv-1']).toBe(true));

    statusListener?.({
      type: 'mcp-status',
      serverId: 'srv-1',
      serverName: 'notion',
      state: 'ready',
      toolCount: 3,
    });
    expect(useMcpStatusStore.getState().statuses['srv-1']).toEqual({
      state: 'ready',
      toolCount: 3,
    });

    unbind();
    expect(offStatus).toHaveBeenCalled();
  });

  it('bind 先拉一次状态快照（启动后才打开设置页也能看到状态）', async () => {
    statusSnapshot.mockResolvedValueOnce([
      { type: 'mcp-status', serverId: 'srv-1', serverName: 'notion', state: 'unauthorized' },
      { type: 'mcp-status', serverName: 'legacy', state: 'ready', toolCount: 1 },
    ]);
    useMcpStatusStore.getState().bind();
    await vi.waitFor(() =>
      expect(useMcpStatusStore.getState().statuses['srv-1']).toEqual({ state: 'unauthorized' })
    );
    expect(useMcpStatusStore.getState().statuses.legacy).toEqual({ state: 'ready', toolCount: 1 });
  });

  it('快照覆盖本地残留的过渡态，快照里没有的键才保留', async () => {
    useMcpStatusStore.setState({
      statuses: { 'srv-1': { state: 'error', error: 'stale' }, other: { state: 'connecting' } },
    });
    statusSnapshot.mockResolvedValueOnce([
      { type: 'mcp-status', serverId: 'srv-1', serverName: 'notion', state: 'ready', toolCount: 2 },
    ]);
    useMcpStatusStore.getState().bind();
    await vi.waitFor(() =>
      expect(useMcpStatusStore.getState().statuses['srv-1']).toEqual({
        state: 'ready',
        toolCount: 2,
      })
    );
    expect(useMcpStatusStore.getState().statuses.other).toEqual({ state: 'connecting' });
  });

  it('worker 退出的清空事件把状态清干净', () => {
    useMcpStatusStore.setState({ statuses: { 'srv-1': { state: 'ready', toolCount: 3 } } });
    useMcpStatusStore.getState().bind();
    statusListener?.({ type: 'mcp-status-cleared' });
    expect(useMcpStatusStore.getState().statuses).toEqual({});
  });

  it('authorize 成功：期间 pending + connecting，完成后标记已授权', async () => {
    let resolveAuth: (value: { ok: boolean; error?: string }) => void = () => {};
    authorize.mockReturnValueOnce(
      new Promise<{ ok: boolean; error?: string }>((resolve) => {
        resolveAuth = resolve;
      })
    );
    const done = useMcpStatusStore.getState().authorize('srv-1');
    expect(useMcpStatusStore.getState().pending['srv-1']).toBe(true);
    expect(useMcpStatusStore.getState().statuses['srv-1']).toEqual({ state: 'connecting' });

    resolveAuth({ ok: true });
    await done;
    expect(useMcpStatusStore.getState().pending['srv-1']).toBeUndefined();
    expect(useMcpStatusStore.getState().authorized['srv-1']).toBe(true);
  });

  it('authorize 失败：写 error 并清 pending', async () => {
    authorize.mockResolvedValueOnce({ ok: false, error: 'user cancelled' });
    await useMcpStatusStore.getState().authorize('srv-1');
    expect(useMcpStatusStore.getState().statuses['srv-1']).toEqual({
      state: 'error',
      error: 'user cancelled',
    });
    expect(useMcpStatusStore.getState().pending['srv-1']).toBeUndefined();
  });

  it('revoke 清掉已授权标记与状态', async () => {
    useMcpStatusStore.setState({
      authorized: { 'srv-1': true },
      statuses: { 'srv-1': { state: 'ready', toolCount: 3 } },
    });
    await useMcpStatusStore.getState().revoke('srv-1');
    expect(revoke).toHaveBeenCalledWith('srv-1');
    expect(useMcpStatusStore.getState().authorized['srv-1']).toBeUndefined();
    expect(useMcpStatusStore.getState().statuses['srv-1']).toBeUndefined();
  });
});
