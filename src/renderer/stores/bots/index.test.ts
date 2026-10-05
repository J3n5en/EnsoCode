import type { ProjectedMessage, RendererAgentEvent } from '@shared/types/agent';
import type { BotChat, GroupEntry } from '@shared/types/bot';
import type { BotEvent } from '@shared/types/botIpc';
import type { BrowserTabState } from '@shared/types/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatSummary } from './selectors';
import { groupReadMark, isUnread } from './unread';

const message = (text: string): ProjectedMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});
const chat: BotChat = {
  id: 'c',
  kind: 'direct',
  title: '',
  members: ['b'],
  bossBotId: null,
  workspace: { kind: 'member-home' },
  routing: { mode: 'boss', maxHops: 4, maxTurnsPerBot: 2 },
  pinned: false,
  sessions: { b: { conversationId: 's', cursor: 0 } },
  createdAt: 1,
  updatedAt: 1,
  version: 1,
};

async function fixture() {
  vi.resetModules();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === 'enso-bot-reads' ? '{"c:s":1}' : null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  const listeners = new Set<(event: RendererAgentEvent) => void>();
  const botListeners = new Set<unknown>();
  const sessionHistory = vi
    .fn()
    .mockResolvedValue({ ok: true, baseIndex: 0, messages: [message('old')] });
  const requestSnapshot = vi.fn().mockResolvedValue({ ok: true });
  const delegations = vi.fn(async () => ({ ok: true, delegations: [] }));
  const timeline = vi.fn(
    async (_request: unknown): Promise<{ ok: true; entries: GroupEntry[]; lastSeq: number }> => ({
      ok: true,
      entries: [],
      lastSeq: 0,
    })
  );
  const closeTab = vi.fn(async (_id: string) => {});
  const browserListeners = {
    reveal: new Set<(event: { conversationId: string; tabId: string }) => void>(),
    closed: new Set<(event: { conversationId: string; tabId: string }) => void>(),
    state: new Set<
      (event: { conversationId: string; tabId: string; state: BrowserTabState }) => void
    >(),
  };
  vi.stubGlobal('window', {
    electronAPI: {
      bots: {
        onEvent: (listener: unknown) => {
          botListeners.add(listener);
          return () => botListeners.delete(listener);
        },
        list: async () => ({ ok: true, enabled: true, bots: [] }),
        chats: async () => ({ ok: true, enabled: true, chats: [chat], queue: [] }),
        delegations,
        timeline,
        sessionHistory,
      },
      agent: {
        onEvent: (listener: (event: RendererAgentEvent) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        requestSnapshot,
      },
      browser: {
        closeTab,
        onReveal: (listener: (event: { conversationId: string; tabId: string }) => void) => {
          browserListeners.reveal.add(listener);
          return () => browserListeners.reveal.delete(listener);
        },
        onTabClosed: (listener: (event: { conversationId: string; tabId: string }) => void) => {
          browserListeners.closed.add(listener);
          return () => browserListeners.closed.delete(listener);
        },
        onState: (
          listener: (event: {
            conversationId: string;
            tabId: string;
            state: BrowserTabState;
          }) => void
        ) => {
          browserListeners.state.add(listener);
          return () => browserListeners.state.delete(listener);
        },
      },
    },
  });
  const { useBotsStore: store } = await import('./index');
  const off = store.getState().bind();
  await vi.waitFor(() => expect(store.getState().loaded).toBe(true));
  expect(store.getState().sessions.s.messages).toEqual([message('old')]);
  return {
    store,
    off,
    sessionHistory,
    requestSnapshot,
    delegations,
    timeline,
    listeners,
    botListeners,
    browserListeners,
    closeTab,
    bot: (event: BotEvent) => {
      for (const listener of botListeners) (listener as (event: BotEvent) => void)(event);
    },
    emit: (event: RendererAgentEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Bot mode subscription lifecycle', () => {
  it('成员浏览器工具打开共享 tab：记下 tab，正看该聊天时切到浏览器面板；关闭后回落默认', async () => {
    const f = await fixture();
    f.store.setState({ view: { kind: 'chat', chatId: 'c' }, panelOpen: false, panelTab: 'info' });
    for (const listener of f.browserListeners.reveal)
      listener({ conversationId: 's', tabId: 'browser:code' });
    expect(f.store.getState().browserTabs).toEqual({});
    for (const listener of f.browserListeners.reveal)
      listener({ conversationId: 'bot-chat:c', tabId: 'browser:7' });
    expect(f.store.getState().browserTabs).toEqual({
      c: { tabs: ['browser:7'], active: 'browser:7' },
    });
    expect(f.store.getState().panelOpen).toBe(true);
    expect(f.store.getState().panelTab).toBe('browser');
    for (const listener of f.browserListeners.reveal)
      listener({ conversationId: 'bot-chat:c', tabId: 'browser:8' });
    expect(f.store.getState().browserTabs.c).toEqual({
      tabs: ['browser:7', 'browser:8'],
      active: 'browser:8',
    });
    for (const listener of f.browserListeners.closed)
      listener({ conversationId: 'bot-chat:c', tabId: 'browser:8' });
    expect(f.store.getState().browserTabs.c).toEqual({ tabs: ['browser:7'], active: 'browser:7' });
    for (const listener of f.browserListeners.closed)
      listener({ conversationId: 'bot-chat:c', tabId: 'browser:7' });
    expect(f.store.getState().browserTabs).toEqual({});
    expect(f.store.getState().panelTab).toBe('info');
  });

  it('Main 推送的标签占用者与标题按 tabId 记下，只收 Bot 聊天，标签关闭时清掉', async () => {
    const f = await fixture();
    const push = (conversationId: string, tabId: string, patch: Partial<BrowserTabState>) => {
      const state: BrowserTabState = {
        tabId,
        url: 'https://example.com/',
        title: '',
        favicon: null,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        locked: false,
        devtoolsOpen: false,
        designMode: false,
        holder: null,
        ...patch,
      };
      for (const listener of f.browserListeners.state) listener({ conversationId, tabId, state });
    };
    const holder = { conversationId: 'conv-a', name: 'Alice' };
    push('s', 'browser:code', { holder });
    push('bot-chat:c', 'browser:7', { holder, title: ' Example ' });
    expect(f.store.getState().browserHolders).toEqual({ 'browser:7': holder });
    expect(f.store.getState().browserTitles).toEqual({ 'browser:7': 'Example' });
    push('bot-chat:c', 'browser:7', { holder: null });
    expect(f.store.getState().browserHolders).toEqual({});
    push('bot-chat:c', 'browser:7', { holder });
    for (const listener of f.browserListeners.reveal)
      listener({ conversationId: 'bot-chat:c', tabId: 'browser:7' });
    for (const listener of f.browserListeners.closed)
      listener({ conversationId: 'bot-chat:c', tabId: 'browser:7' });
    expect(f.store.getState().browserHolders).toEqual({});
  });

  it('别的聊天的浏览器不抢当前面板', async () => {
    const f = await fixture();
    f.store.setState({ view: { kind: 'chat', chatId: 'c' }, panelTab: 'info' });
    for (const listener of f.browserListeners.reveal)
      listener({ conversationId: 'bot-chat:other', tabId: 'browser:9' });
    expect(f.store.getState().browserTabs).toEqual({
      other: { tabs: ['browser:9'], active: 'browser:9' },
    });
    expect(f.store.getState().panelTab).toBe('info');
  });

  it('用户新开、切换、关闭标签；关完最后一个回到信息页', async () => {
    const f = await fixture();
    f.store.setState({ view: { kind: 'chat', chatId: 'c' }, panelTab: 'info' });
    f.store.getState().openBrowserTab('c');
    f.store.getState().openBrowserTab('c');
    const [first, second] = f.store.getState().browserTabs.c.tabs;
    expect(f.store.getState().browserTabs.c.active).toBe(second);
    expect(f.store.getState().panelTab).toBe('browser');
    f.store.getState().selectBrowserTab('c', first);
    expect(f.store.getState().browserTabs.c.active).toBe(first);
    f.store.getState().setBrowserTitle(first, 'Example Domain');
    await f.store.getState().closeBrowserTab('c', first);
    expect(f.closeTab).toHaveBeenCalledWith(first);
    expect(f.store.getState().browserTabs.c).toEqual({ tabs: [second], active: second });
    expect(f.store.getState().browserTitles).toEqual({});
    expect(f.store.getState().panelTab).toBe('browser');
    await f.store.getState().closeBrowserTab('c', second);
    expect(f.store.getState().browserTabs).toEqual({});
    expect(f.store.getState().panelTab).toBe('info');
  });

  it('重复 bind 不重复订阅；全部清理后才解绑', async () => {
    const f = await fixture();
    const off = f.store.getState().bind();
    expect(f.listeners.size).toBe(1);
    expect(f.botListeners.size).toBe(1);
    f.off();
    expect(f.listeners.size).toBe(1);
    off();
    off();
    expect(f.listeners.size).toBe(0);
    expect(f.botListeners.size).toBe(0);
  });

  it('Code 模式错过轮次后重新挂载，缓存必须从磁盘补齐（worker 已冷）', async () => {
    const f = await fixture();
    f.store.setState((s) => ({
      sessions: { s: { ...s.sessions.s, generation: 'g1', lastSeq: 90, status: 'running' } },
    }));
    f.off();
    f.sessionHistory.mockResolvedValue({
      ok: true,
      baseIndex: 0,
      messages: [message('old'), message('Main 例行任务结果')],
    });
    const off = f.store.getState().bind();
    await vi.waitFor(() => expect(f.store.getState().sessions.s.messages).toHaveLength(2));
    const state = f.store.getState();
    const summary = chatSummary(chat, { sessions: state.sessions, queue: [], names: {} });
    expect(summary.preview).toBe('Main 例行任务结果');
    expect(summary.running).toBe(false);
    expect(isUnread(summary.marker, state.reads[summary.key])).toBe(true);
    expect(state.sessions.s.generation).toBeUndefined();
    expect(f.requestSnapshot).toHaveBeenCalledTimes(2);
    off();
  });

  it('切回后的新 generation 快照和后续流式事件优先于延迟返回的历史', async () => {
    const f = await fixture();
    f.off();
    const history = Promise.withResolvers<{
      ok: true;
      baseIndex: number;
      messages: ProjectedMessage[];
    }>();
    f.sessionHistory.mockReturnValue(history.promise);
    f.requestSnapshot.mockImplementation(async () => {
      f.emit({
        type: 'snapshot',
        partial: true,
        sessions: [
          {
            identity: { sessionId: 's', generation: 'g2' },
            status: 'running',
            messages: [message('old'), message('live')],
            commands: [],
          },
        ],
      } as RendererAgentEvent);
      return { ok: true };
    });
    const off = f.store.getState().bind();
    await vi.waitFor(() => expect(f.store.getState().sessions.s.generation).toBe('g2'));
    history.resolve({ ok: true, baseIndex: 0, messages: [message('stale')] });
    await history.promise;
    const state = f.store.getState().sessions.s;
    expect(state.messages).toEqual([message('old'), message('live')]);
    expect(state.status).toBe('running');
    f.emit({
      type: 'message-upsert',
      identity: { sessionId: 's', generation: 'g2' },
      seq: 10,
      index: 2,
      message: message('new'),
    });
    expect(f.store.getState().sessions.s.messages.at(-1)).toEqual(message('new'));
    off();
  });

  it('Bot 事件按聊天合并刷新，时间线只拉 seq 之后的增量，过期 seq 不再拉', async () => {
    const f = await fixture();
    const entry = (seq: number): GroupEntry => ({
      seq,
      id: `e${seq}`,
      at: seq,
      kind: 'system',
      text: String(seq),
    });
    f.store.setState({
      timelines: {
        g: { entries: [entry(1), entry(2), entry(3)], lastSeq: 3, hasOlder: false, loading: false },
      },
    });
    f.delegations.mockClear();
    f.timeline.mockClear();
    f.timeline.mockResolvedValue({ ok: true, entries: [entry(4), entry(5)], lastSeq: 5 });
    f.bot({ kind: 'timeline', chatId: 'g', seq: 2 });
    for (const seq of [4, 5]) f.bot({ kind: 'timeline', chatId: 'g', seq });
    for (let i = 0; i < 3; i++) f.bot({ kind: 'delegation', chatId: 'g' });
    await vi.waitFor(() => expect(f.store.getState().timelines.g.lastSeq).toBe(5));
    await vi.waitFor(() => expect(f.delegations).toHaveBeenCalledTimes(1));
    expect(f.timeline).toHaveBeenCalledTimes(1);
    expect(f.timeline).toHaveBeenCalledWith({ chatId: 'g', afterSeq: 3, limit: 50 });
    expect(f.store.getState().timelines.g.entries.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5]);
    f.bot({ kind: 'timeline', chatId: 'g', seq: 5 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(f.timeline).toHaveBeenCalledTimes(1);
    f.off();
  });
});

describe('群时间线历史窗口', () => {
  const entry = (seq: number): GroupEntry => ({
    seq,
    id: `e${seq}`,
    at: seq,
    kind: 'system',
    text: String(seq),
  });
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => entry(from + i));
  const latest = { entries: range(19951, 20000), lastSeq: 20000, hasOlder: true, loading: false };
  const windowed = {
    entries: range(83, 163),
    lastSeq: 20000,
    hasOlder: true,
    loading: false,
    history: { sinceSeq: 20000, tail: entry(20000) },
  };
  const group: BotChat = { ...chat, id: 'g', kind: 'group', sessions: {} };
  const seqs = (f: Awaited<ReturnType<typeof fixture>>) =>
    f.store.getState().timelines.g.entries.map((item) => item.seq);

  it('跳到很早的 seq：一次加载目标前后一段并替换，进入历史窗口', async () => {
    const f = await fixture();
    f.store.setState({ timelines: { g: latest } });
    f.timeline.mockClear();
    f.timeline.mockResolvedValue({ ok: true, entries: range(83, 163), lastSeq: 20000 });
    await f.store.getState().loadAround('g', 123);
    expect(f.timeline).toHaveBeenCalledTimes(1);
    expect(f.timeline).toHaveBeenCalledWith({ chatId: 'g', beforeSeq: 164, limit: 81 });
    const g = f.store.getState().timelines.g;
    expect(seqs(f)).toEqual(range(83, 163).map((item) => item.seq));
    expect(g.hasOlder).toBe(true);
    expect(g.history).toEqual({ sinceSeq: 20000, tail: entry(20000) });
    f.off();
  });

  it('目标附近一段已到最新时不进入历史窗口', async () => {
    const f = await fixture();
    f.store.setState({ timelines: { g: latest } });
    f.timeline.mockResolvedValue({ ok: true, entries: range(19920, 20000), lastSeq: 20000 });
    await f.store.getState().loadAround('g', 19990);
    expect(f.store.getState().timelines.g.history).toBeUndefined();
    f.off();
  });

  it('历史窗口里实时新消息不并入列表，只更新最新一条；已读不越过已加载末尾', async () => {
    const f = await fixture();
    f.store.setState({ timelines: { g: windowed } });
    f.timeline.mockClear();
    f.timeline.mockResolvedValue({ ok: true, entries: [entry(20001)], lastSeq: 20001 });
    f.bot({ kind: 'timeline', chatId: 'g', seq: 20001 });
    await vi.waitFor(() => expect(f.store.getState().timelines.g.lastSeq).toBe(20001));
    expect(f.timeline).toHaveBeenCalledWith({ chatId: 'g', limit: 1 });
    const g = f.store.getState().timelines.g;
    expect(g.entries).toBe(windowed.entries);
    expect(g.history).toEqual({ sinceSeq: 20000, tail: entry(20001) });
    const summary = chatSummary(group, { sessions: {}, timeline: g, queue: [], names: {} });
    expect(summary.preview).toBe('20001');
    expect(isUnread(summary.marker, groupReadMark(g, 19000))).toBe(true);
    f.off();
  });

  it('向下翻页按 beforeSeq 取更新一页，追上最新后退出历史窗口并恢复实时追加', async () => {
    const f = await fixture();
    f.store.setState({ timelines: { g: { ...windowed, entries: range(19900, 19960) } } });
    f.timeline.mockClear();
    f.timeline.mockResolvedValue({ ok: true, entries: range(19951, 20000), lastSeq: 20000 });
    await f.store.getState().loadNewer('g');
    expect(f.timeline).toHaveBeenCalledWith({ chatId: 'g', beforeSeq: 20011, limit: 50 });
    expect(seqs(f)).toEqual(range(19900, 20000).map((item) => item.seq));
    expect(f.store.getState().timelines.g.history).toBeUndefined();
    f.timeline.mockResolvedValue({ ok: true, entries: [entry(20001)], lastSeq: 20001 });
    f.bot({ kind: 'timeline', chatId: 'g', seq: 20001 });
    await vi.waitFor(() => expect(seqs(f).at(-1)).toBe(20001));
    f.off();
  });

  it('已加载超过上限时从远离视口的一端裁掉', async () => {
    const f = await fixture();
    f.store.setState({ timelines: { g: { ...windowed, entries: range(1, 400) } } });
    f.timeline.mockResolvedValue({ ok: true, entries: range(401, 450), lastSeq: 20000 });
    await f.store.getState().loadNewer('g');
    expect(seqs(f)).toEqual(range(51, 450).map((item) => item.seq));
    expect(f.store.getState().timelines.g.hasOlder).toBe(true);

    f.store.setState({
      timelines: { g: { entries: range(351, 750), lastSeq: 750, hasOlder: true, loading: false } },
    });
    f.timeline.mockResolvedValue({ ok: true, entries: range(301, 350), lastSeq: 750 });
    await f.store.getState().loadOlder('g');
    expect(seqs(f)).toEqual(range(301, 700).map((item) => item.seq));
    expect(f.store.getState().timelines.g.history).toEqual({ sinceSeq: 750, tail: entry(750) });
    f.off();
  });

  it('回到最新：替换为最新一页并退出历史窗口', async () => {
    const f = await fixture();
    f.store.setState({ timelines: { g: windowed } });
    f.timeline.mockClear();
    f.timeline.mockResolvedValue({ ok: true, entries: range(19951, 20000), lastSeq: 20000 });
    await f.store.getState().jumpLatest('g');
    expect(f.timeline).toHaveBeenCalledWith({ chatId: 'g', limit: 50 });
    expect(seqs(f)).toEqual(range(19951, 20000).map((item) => item.seq));
    expect(f.store.getState().timelines.g.history).toBeUndefined();
    f.off();
  });
});
