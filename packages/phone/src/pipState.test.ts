import type { CatalogEntry } from '@enso/pair';
import type { GuestSessionView } from '@shared/pair/guestProjection';
import type { ProjectedMessage } from '@shared/types/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPipSnapshotFromGuestView,
  createTrailingThrottle,
  DeskPipTracker,
  extractLatestTodo,
  loadNativePipAspect,
  loadNativePipAuto,
  loadNativePipFollow,
  NATIVE_PIP_AUTO_KEY,
  parseInvokeSessionId,
  projectMessagesForPip,
  saveNativePipAspect,
  saveNativePipAuto,
  saveNativePipFollow,
} from './pipState';

const user = (text: string, timestamp = 1000): ProjectedMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
  timestamp,
});
const assistant = (
  content: ProjectedMessage['content'],
  extra: Partial<ProjectedMessage> = {}
): ProjectedMessage => ({ role: 'assistant', content, timestamp: 2000.6, ...extra });
const toolResult = (toolName: string, isError: boolean, text = 'stdout'): ProjectedMessage => ({
  role: 'toolResult',
  toolName,
  isError,
  content: [{ type: 'text', text }],
  timestamp: 3000,
});

describe('loadNativePipAuto / saveNativePipAuto', () => {
  it('缺省关闭，存过之后按存的值读回；存储抛错时当关闭', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
    expect(loadNativePipAuto(storage)).toBe(false);
    saveNativePipAuto(storage, true);
    expect(data.get(NATIVE_PIP_AUTO_KEY)).toBe('on');
    expect(loadNativePipAuto(storage)).toBe(true);
    saveNativePipAuto(storage, false);
    expect(loadNativePipAuto(storage)).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadNativePipAuto(broken)).toBe(false);
    expect(() => saveNativePipAuto(broken, true)).not.toThrow();
  });
});

describe('projectMessagesForPip', () => {
  it('空输入得到空列表', () => {
    expect(projectMessagesForPip([])).toEqual([]);
  });

  it('user 取文本段，空消息跳过；assistant 文本保留，连续多条工具调用折叠为 tool-group', () => {
    const items = projectMessagesForPip(
      [
        user('  你好\r\n\r\n\r\n世界  '),
        user('   '),
        assistant([
          { type: 'thinking', text: '内心戏' },
          { type: 'text', text: '我先看看' },
          {
            type: 'toolCall',
            id: 'c1',
            name: 'bash',
            arguments: { command: 'pnpm test\n--watch' },
          },
          { type: 'toolCall', id: 'c2', name: 'read', arguments: { path: '/a/b/c.ts' } },
          { type: 'toolCall', id: 'c3', name: 'todo', arguments: { todos: [] } },
        ]),
      ],
      { baseIndex: 10 }
    );
    expect(items).toEqual([
      expect.objectContaining({
        id: '10',
        role: 'user',
        text: '你好\n\n世界',
        toolName: null,
        isStreaming: false,
        isError: false,
        timestamp: 1000,
      }),
      expect.objectContaining({
        id: '12:th',
        role: 'thinking',
        text: '思考过程',
        isStreaming: false,
      }),
      expect.objectContaining({ id: '12', role: 'assistant', text: '我先看看', timestamp: 2001 }),
      expect.objectContaining({
        role: 'tool-group',
        toolState: 'ok',
        stepCount: 3,
        text: '已工作 · 1 条命令 · 1 次读取 · 1 项操作',
        steps: null,
      }),
    ]);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(items.every((i) => !i.isStreaming)).toBe(true);
  });

  it('桌面折叠口径：连续思考+多步成功工具收成一行「已工作 XmYs」，失败工具与运行中尾步独立露出', () => {
    const items = projectMessagesForPip(
      [
        assistant(
          [
            { type: 'thinking', text: '先检查代码' },
            { type: 'toolCall', id: 't1', name: 'read', arguments: { path: '/a/foo.ts' } },
            { type: 'toolCall', id: 't2', name: 'grep', arguments: { pattern: 'bar' } },
          ],
          { duration: 6700, timestamp: 1000 }
        ),
        { ...toolResult('read', false, 'ok'), toolCallId: 't1', duration: 3000, timestamp: 4000 },
        {
          ...toolResult('grep', false, 'ok'),
          toolCallId: 't2',
          duration: 98300,
          timestamp: 102300,
        },
        assistant(
          [
            { type: 'toolCall', id: 't3', name: 'bash', arguments: { command: 'exit 1' } },
            { type: 'toolCall', id: 't4', name: 'bash', arguments: { command: 'pnpm test' } },
          ],
          { timestamp: 103000 }
        ),
        {
          ...toolResult('bash', true, 'Command exited with code 1'),
          toolCallId: 't3',
          duration: 100,
          timestamp: 103100,
        },
      ],
      { isRunning: true }
    );
    expect(items).toEqual([
      expect.objectContaining({
        role: 'tool-group',
        text: '已工作 1m48s',
        detail: '1 次读取 · 1 次检索',
        steps: null,
        stepCount: 2,
      }),
      expect.objectContaining({
        role: 'tool',
        toolName: '终端',
        text: 'exit 1',
        toolState: 'error',
        isError: true,
        detail: 'Command exited with code 1',
      }),
      expect.objectContaining({
        role: 'tool',
        toolName: '终端',
        text: 'pnpm test',
        toolState: 'running',
        isStreaming: true,
      }),
    ]);
  });

  it('运行中只把最后一条 assistant 的末张卡片标为流式；独立展示 thinking 思考行', () => {
    const messages = [
      assistant([{ type: 'text', text: '旧回复' }]),
      user('继续'),
      assistant([{ type: 'thinking', text: `${'甲'.repeat(300)}最后几个字` }]),
    ];
    const running = projectMessagesForPip(messages, { isRunning: true });
    expect(running.map((i) => i.isStreaming)).toEqual([false, false, true]);
    expect(running[2]?.role).toBe('thinking');
    const thinking = running[2]?.text ?? '';
    expect(thinking.startsWith('…')).toBe(true);
    expect(thinking.endsWith('最后几个字')).toBe(true);

    const idle = projectMessagesForPip(messages, { isRunning: false });
    expect(idle).toHaveLength(3);
    expect(idle[2]?.role).toBe('thinking');
    expect(idle.every((i) => !i.isStreaming)).toBe(true);

    const empty = projectMessagesForPip([assistant([])], { isRunning: true });
    expect(empty).toEqual([
      expect.objectContaining({ role: 'thinking', text: '思考中…', isStreaming: true }),
    ]);
  });

  it('工具调用与 toolResult 按 toolCallId 配对，不重复刷卡；孤立报错合并进工具行', () => {
    const paired = projectMessagesForPip([
      assistant([
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'gh pr view' } },
      ]),
      {
        ...toolResult('bash', true, 'TLS handshake timeout'),
        toolCallId: 'c1',
      },
    ]);
    expect(paired).toHaveLength(1);
    expect(paired[0]).toEqual(
      expect.objectContaining({
        role: 'tool',
        toolName: '终端',
        text: 'gh pr view',
        toolState: 'error',
        isError: true,
        detail: 'TLS handshake timeout',
      })
    );

    const items = projectMessagesForPip([
      toolResult('bash', false, 'x'.repeat(5000)),
      toolResult('edit', true, '找不到要替换的文本'),
      { ...toolResult('grep', true, ''), errorMessage: undefined },
    ]);
    expect(items).toEqual([
      expect.objectContaining({ role: 'tool', toolName: '编辑', isError: true }),
      expect.objectContaining({ role: 'tool', toolName: '搜索', isError: true }),
    ]);
  });

  it('assistant 以错误收尾时追加一张系统错误卡片', () => {
    const items = projectMessagesForPip([
      assistant([], { stopReason: 'error', errorMessage: 'rate limited' }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({ role: 'system', isError: true, text: 'rate limited' }),
    ]);
  });

  it('最多留最近 18 张；早先卡片截头 420 字，末张流式回复取尾 1200 字', () => {
    const messages = Array.from({ length: 24 }, (_, i) => user(`${i}:${'长'.repeat(500)}`));
    messages.push(assistant([{ type: 'text', text: `${'前'.repeat(1500)}结尾` }]));
    const items = projectMessagesForPip(messages, { isRunning: true });
    expect(items).toHaveLength(18);
    expect(items[0]?.id).toBe('7');
    const first = Array.from(items[0]?.text ?? '');
    expect(first).toHaveLength(421);
    expect(first.at(-1)).toBe('…');
    const last = items[17];
    expect(last?.isStreaming).toBe(true);
    expect(Array.from(last?.text ?? '')).toHaveLength(1201);
    expect(last?.text.startsWith('…')).toBe(true);
    expect(last?.text.endsWith('结尾')).toBe(true);
    expect(projectMessagesForPip(messages, { maxItems: 3 })).toHaveLength(3);
  });

  it('extractLatestTodo 提取最新未完成清单，全部完成返回 null；loadNativePipAspect 默认 portrait', () => {
    const todo = extractLatestTodo([
      assistant([
        {
          type: 'toolCall',
          id: 't1',
          name: 'todo',
          arguments: {
            todos: [
              { content: '第一步', status: 'completed' },
              { content: '第二步正在做', status: 'in_progress' },
              { content: '第三步', status: 'pending' },
            ],
          },
        },
      ]),
    ]);
    expect(todo).toEqual({ done: 1, total: 3, current: '第二步正在做' });

    const doneAll = extractLatestTodo([
      assistant([
        {
          type: 'toolCall',
          id: 't2',
          name: 'todo',
          arguments: { todos: [{ content: '搞定', status: 'completed' }] },
        },
      ]),
    ]);
    expect(doneAll).toBeNull();

    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
    expect(loadNativePipAspect(storage)).toBe('portrait');
    saveNativePipAspect(storage, 'square');
    expect(loadNativePipAspect(storage)).toBe('square');
    expect(loadNativePipFollow(storage)).toBe('opened');
    saveNativePipFollow(storage, 'latest');
    expect(loadNativePipFollow(storage)).toBe('latest');
  });
});

const ev = (event: Record<string, unknown>) => JSON.stringify([event]);
const identity = (sessionId: string, parentSessionId?: string) => ({
  sessionId,
  ...(parentSessionId ? { parentSessionId } : {}),
});

function deskTracker() {
  const tracker = new DeskPipTracker();
  tracker.ingestSettingsJson(
    JSON.stringify({
      'enso-settings': { state: { projects: [{ id: 'p1', path: '/w/enso-code' }] } },
    })
  );
  tracker.ingestConversationsJson(
    JSON.stringify({
      seq: 1,
      value: {
        state: {
          activeConversationId: 's1',
          conversations: {
            s1: { title: '修画中画', projectId: 'p1', updatedAt: 10 },
            s2: { title: '写文档', projectId: 'p1', updatedAt: 20 },
          },
        },
      },
    })
  );
  return tracker;
}

const snap = (tracker: DeskPipTracker, now = 5000) =>
  tracker.buildSnapshot({ deviceLabel: '办公机', connectionState: 'online', now });

describe('DeskPipTracker', () => {
  it('conversations:read 的当前会话 + snapshot 消息组成浮窗；子会话不计入', () => {
    const tracker = deskTracker();
    expect(
      tracker.applyAgentEventPayload(
        ev({
          type: 'snapshot',
          sessions: [
            {
              identity: identity('s1'),
              status: 'idle',
              baseIndex: 40,
              messages: [user('帮我修'), assistant([{ type: 'text', text: '好的' }])],
            },
            { identity: identity('c1', 's1'), status: 'running', messages: [user('子任务')] },
          ],
        })
      )
    ).toBe(true);
    const s = snap(tracker, 1234.7);
    expect(s).toMatchObject({
      sessionId: 's1',
      title: '修画中画',
      projectName: 'enso-code',
      status: 'idle',
      pendingHint: null,
      runningCount: 0,
      pendingCount: 0,
      connectionState: 'online',
      updatedAt: 1235,
    });
    expect(s.messages.map((m) => [m.id, m.text])).toEqual([
      ['40', '帮我修'],
      ['41', '好的'],
    ]);
  });

  it('message-upsert 流式更新同一条，messages-truncated 删掉截断点之后的', () => {
    const tracker = deskTracker();
    tracker.applyAgentEventPayload(
      ev({ type: 'status', identity: identity('s1'), status: 'running' })
    );
    tracker.applyAgentEventPayload(
      ev({ type: 'message-upsert', identity: identity('s1'), index: 0, message: user('开始') })
    );
    tracker.applyAgentEventPayload(
      ev({
        type: 'message-upsert',
        identity: identity('s1'),
        index: 1,
        message: assistant([{ type: 'text', text: '正在' }]),
      })
    );
    tracker.applyAgentEventPayload(
      ev({
        type: 'message-upsert',
        identity: identity('s1'),
        index: 1,
        message: assistant([{ type: 'text', text: '正在改代码' }]),
      })
    );
    let s = snap(tracker);
    expect(s.status).toBe('running');
    expect(s.runningCount).toBe(1);
    expect(s.messages.map((m) => [m.id, m.text, m.isStreaming])).toEqual([
      ['0', '开始', false],
      ['1', '正在改代码', true],
    ]);

    expect(
      tracker.applyAgentEventPayload(
        ev({ type: 'messages-truncated', identity: identity('s1'), length: 1 })
      )
    ).toBe(true);
    s = snap(tracker);
    expect(s.messages.map((m) => m.text)).toEqual(['开始']);

    tracker.applyAgentEventPayload(
      ev({ type: 'turn-completed', identity: identity('s1'), turnId: 't' })
    );
    expect(snap(tracker).status).toBe('idle');
  });

  it('followMode=opened 始终跟随当前打开的会话；followMode=latest 优先跳到待确认/最新活跃会话', () => {
    const tracker = deskTracker();
    tracker.applyAgentEventPayload(
      ev({ type: 'message-upsert', identity: identity('s1'), index: 0, message: user('s1 的消息') })
    );
    tracker.applyAgentEventPayload(
      ev({
        type: 'approval-request',
        identity: identity('s2'),
        request: { requestId: 'r1', tool: 'bash', kind: 'command', summary: 'rm -rf dist' },
      })
    );
    // 默认 opened：留在当前打开的 s1，但 pendingCount 与 pendingHint 仍提醒有别处待确认
    expect(snap(tracker)).toMatchObject({
      sessionId: 's1',
      title: '修画中画',
      status: 'idle',
      pendingCount: 1,
      pendingHint: '有 1 项待确认',
    });

    // 切到 latest：立刻跳到待确认的 s2
    expect(tracker.setFollowMode('latest')).toBe(true);
    let s = snap(tracker);
    expect(s).toMatchObject({
      sessionId: 's2',
      title: '写文档',
      status: 'pending',
      pendingHint: '等待审批 bash',
      pendingCount: 1,
    });

    tracker.applyAgentEventPayload(
      ev({ type: 'approval-resolved', identity: identity('s2'), requestId: 'r1' })
    );
    s = snap(tracker);
    expect(s).toMatchObject({
      sessionId: 's1',
      status: 'idle',
      pendingCount: 0,
      pendingHint: null,
    });
  });

  it('ask-request 的问题作为提示；ask-resolved 后清掉', () => {
    const tracker = deskTracker();
    tracker.applyAgentEventPayload(
      ev({
        type: 'ask-request',
        identity: identity('s1'),
        ask: { requestId: 'a1', question: '要合并吗？\n细节…' },
      })
    );
    expect(snap(tracker)).toMatchObject({ status: 'pending', pendingHint: '要合并吗？' });
    tracker.applyAgentEventPayload(
      ev({ type: 'ask-resolved', identity: identity('s1'), requestId: 'a1' })
    );
    expect(snap(tracker)).toMatchObject({ status: 'idle', pendingHint: null });
  });

  it('焦点优先级：opened 锁住当前打开会话；latest 按 待确认 > 运行中 > 最近有消息', () => {
    const tracker = new DeskPipTracker();
    const status = (sid: string, value: string, now: number) =>
      tracker.applyAgentEventPayload(
        ev({ type: 'status', identity: identity(sid), status: value }),
        now
      );
    const upsert = (sid: string, now: number) =>
      tracker.applyAgentEventPayload(
        ev({ type: 'message-upsert', identity: identity(sid), index: 0, message: user(sid) }),
        now
      );

    expect(snap(tracker).sessionId).toBeNull();
    upsert('old', 1);
    upsert('recent', 2);
    expect(snap(tracker).sessionId).toBe('recent');

    tracker.setFocusedSession('old');
    expect(snap(tracker).sessionId).toBe('old');

    status('runA', 'running', 3);
    status('runB', 'running', 4);
    // opened 模式下即便其它会话正在跑，仍坚守用户当前打开的 old
    expect(snap(tracker).sessionId).toBe('old');

    // 切到 latest 后按 待确认 > 运行中 > 最近有消息
    tracker.setFollowMode('latest');
    expect(snap(tracker).sessionId).toBe('runB');

    tracker.applyAgentEventPayload(
      ev({
        type: 'approval-request',
        identity: identity('runA'),
        request: { requestId: 'r', tool: 'x' },
      }),
      5
    );
    expect(snap(tracker).sessionId).toBe('runA');

    tracker.setFocusedSession('runB');
    expect(snap(tracker).sessionId).toBe('runA');
    tracker.setFollowMode('opened');
    expect(snap(tracker).sessionId).toBe('runB');
  });

  it('ingestHistoryTail 补上没在 worker 里的会话历史，不覆盖实时消息', () => {
    const tracker = deskTracker();
    tracker.applyAgentEventPayload(
      ev({ type: 'message-upsert', identity: identity('s2'), index: 6, message: user('实时') })
    );
    expect(
      tracker.ingestHistoryTail(
        's2',
        JSON.stringify({
          ok: true,
          baseIndex: 4,
          messages: [user('历史一'), assistant([{ type: 'text', text: '历史二' }]), user('旧版')],
        })
      )
    ).toBe(true);
    tracker.setFocusedSession('s2');
    expect(snap(tracker).messages.map((m) => [m.id, m.text])).toEqual([
      ['4', '历史一'],
      ['5', '历史二'],
      ['6', '实时'],
    ]);
    expect(tracker.ingestHistoryTail('s2', JSON.stringify({ ok: false, code: 'not-found' }))).toBe(
      false
    );
    expect(tracker.ingestHistoryTail('s2', 'not json')).toBe(false);
  });

  it('断线时状态为 offline；会话删除后不再出现', () => {
    const tracker = deskTracker();
    tracker.applyAgentEventPayload(
      ev({ type: 'status', identity: identity('s2'), status: 'running' })
    );
    expect(
      tracker.buildSnapshot({ deviceLabel: '办公机', connectionState: 'host-offline' }).status
    ).toBe('offline');
    tracker.applyConversationsPatchPayload(JSON.stringify([{ upserts: {}, removes: ['s2'] }]));
    expect(snap(tracker)).toMatchObject({ sessionId: 's1', runningCount: 0 });
  });

  it('坏载荷不改变状态', () => {
    const tracker = new DeskPipTracker();
    expect(tracker.applyAgentEventPayload('{')).toBe(false);
    expect(
      tracker.applyAgentEventPayload(ev({ type: 'message-upsert', identity: identity('s') }))
    ).toBe(false);
    expect(snap(tracker).sessionId).toBeNull();
  });
});

describe('parseInvokeSessionId', () => {
  it('支持位置参数与对象参数两种入参', () => {
    expect(parseInvokeSessionId(JSON.stringify(['s1', 'hi']))).toBe('s1');
    expect(parseInvokeSessionId(JSON.stringify([{ conversationId: 'c1', beforeIndex: 3 }]))).toBe(
      'c1'
    );
    expect(parseInvokeSessionId(JSON.stringify([{ sessionId: 's2' }]))).toBe('s2');
    expect(parseInvokeSessionId(JSON.stringify([]))).toBeNull();
    expect(parseInvokeSessionId('oops')).toBeNull();
  });
});

const entry = (over: Partial<CatalogEntry>): CatalogEntry =>
  ({
    id: 's1',
    title: '会话',
    projectName: 'proj',
    projectId: 'p',
    status: 'idle',
    ...over,
  }) as CatalogEntry;

const guestView = (over: Partial<GuestSessionView>): GuestSessionView => ({
  messages: new Map(),
  status: 'idle',
  approvals: [],
  asks: [],
  tasks: [],
  subagents: [],
  ...over,
});

describe('buildPipSnapshotFromGuestView', () => {
  const base = { activeId: 's1', connectionState: 'online', deviceLabel: '办公机', now: 99.5 };

  it('运行中：消息按绝对 index 取 id，末条标流式，计数取自目录', () => {
    const e = entry({ status: 'running' });
    const s = buildPipSnapshotFromGuestView({
      ...base,
      entry: e,
      catalog: [
        e,
        entry({ id: 's2', status: 'running' }),
        entry({ id: 'c', parentId: 's1', status: 'running' }),
      ],
      view: guestView({
        status: 'running',
        messages: new Map([
          [7, user('问')],
          [8, assistant([{ type: 'text', text: '答' }])],
        ]),
      }),
    });
    expect(s).toMatchObject({
      sessionId: 's1',
      title: '会话',
      projectName: 'proj',
      status: 'running',
      runningCount: 2,
      pendingCount: 0,
      updatedAt: 100,
    });
    expect(s.messages.map((m) => [m.id, m.isStreaming])).toEqual([
      ['7', false],
      ['8', true],
    ]);
  });

  it('待确认：审批优先给提示', () => {
    const e = entry({ pendingApprovalCount: 1 });
    const s = buildPipSnapshotFromGuestView({
      ...base,
      entry: e,
      catalog: [e],
      view: guestView({
        approvals: [{ requestId: 'r', tool: 'edit', kind: 'file', summary: 'a.ts' } as never],
      }),
    });
    expect(s).toMatchObject({ status: 'pending', pendingHint: '等待审批 edit', pendingCount: 1 });
  });

  it('空闲与离线；没有打开会话时用设备名作标题', () => {
    const idle = buildPipSnapshotFromGuestView({
      ...base,
      entry: entry({}),
      catalog: [],
      view: undefined,
    });
    expect(idle).toMatchObject({ status: 'idle', messages: [], pendingHint: null });

    const offline = buildPipSnapshotFromGuestView({
      ...base,
      activeId: null,
      entry: undefined,
      view: undefined,
      catalog: [],
      connectionState: 'offline',
    });
    expect(offline).toMatchObject({ sessionId: null, title: '办公机', status: 'offline' });
  });

  it('followMode=latest 优先展示最新待确认/运行中会话，opened 保持当前打开会话', () => {
    const e1 = entry({ id: 's1', title: '当前会话', status: 'idle', updatedAt: 10 });
    const e2 = entry({ id: 's2', title: '后台在跑', status: 'running', updatedAt: 20 });
    const v1 = guestView({ messages: new Map([[0, user('在看 s1')]]) });
    const v2 = guestView({ status: 'running', messages: new Map([[0, user('s2 正在跑')]]) });

    const opened = buildPipSnapshotFromGuestView({
      ...base,
      activeId: 's1',
      entry: e1,
      view: v1,
      catalog: [e1, e2],
      followMode: 'opened',
      getSession: (id) => (id === 's2' ? v2 : v1),
    });
    expect(opened).toMatchObject({ sessionId: 's1', title: '当前会话', status: 'idle' });

    const latest = buildPipSnapshotFromGuestView({
      ...base,
      activeId: 's1',
      entry: e1,
      view: v1,
      catalog: [e1, e2],
      followMode: 'latest',
      getSession: (id) => (id === 's2' ? v2 : v1),
    });
    expect(latest).toMatchObject({ sessionId: 's2', title: '后台在跑', status: 'running' });
    expect(latest.messages.map((m) => m.text)).toEqual(['s2 正在跑']);
  });
});

describe('createTrailingThrottle', () => {
  afterEach(() => vi.useRealTimers());

  it('窗口内多次 schedule 只执行一次，flush 立即执行', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const throttle = createTrailingThrottle(run, 120);
    throttle.schedule();
    throttle.schedule();
    vi.advanceTimersByTime(119);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    throttle.schedule();
    throttle.flush();
    expect(run).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(500);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
