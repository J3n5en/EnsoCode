import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import {
  applyNodeMessage,
  emptyNodeView,
  type NodeView,
  onHostOnlineChanged,
  requestHistory,
  resumeRememberedSession,
  selectSession,
} from './reducer';

/**
 * 远程节点视图的纯 reducer：目录/项目/providers 入库、agent-event 走共享投影、
 * 订阅/游标/同步态。副作用（NODES_SEND、localStorage）以「意图」形式返回，由 store 执行。
 */

const msg = (text: string): ProjectedMessage =>
  ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 }) as ProjectedMessage;

const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: id,
  projectName: 'p',
  projectId: 'p1',
  status: 'idle',
  ...over,
});

describe('目录类帧', () => {
  it('catalog / projects / providers / host-info 各自入库', () => {
    let v = emptyNodeView();
    v = applyNodeMessage(v, { type: 'catalog', entries: [entry('s1')], pinnedOrder: ['s1'] }).view;
    expect(v.catalog.map((e) => e.id)).toEqual(['s1']);
    expect(v.pinnedOrder).toEqual(['s1']);
    v = applyNodeMessage(v, {
      type: 'projects',
      projects: [{ id: 'p1', name: 'p', path: '/p' }],
    }).view;
    expect(v.projects).toHaveLength(1);
    expect(v.groups).toEqual([]);
    v = applyNodeMessage(emptyNodeView(), {
      type: 'projects',
      projects: [{ id: 'p1', name: 'p', path: '/p', groupId: 'g1' }],
      groups: [{ id: 'g1', name: 'Work', order: 0 }],
    }).view;
    expect(v.groups).toEqual([{ id: 'g1', name: 'Work', order: 0 }]);
    v = applyNodeMessage(v, {
      type: 'providers',
      providers: [{ id: 'pr', name: 'PR', models: [{ id: 'm' }] }],
    }).view;
    expect(v.providers[0].id).toBe('pr');
  });

  it('catalog 缺省 pinnedOrder → 空数组（旧桌面）', () => {
    const v = applyNodeMessage(emptyNodeView(), { type: 'catalog', entries: [] }).view;
    expect(v.pinnedOrder).toEqual([]);
  });

  it('订阅的会话曾在目录、现在消失 → 幽灵：返回 ghost 意图并清 active', () => {
    let v = emptyNodeView();
    v = applyNodeMessage(v, { type: 'catalog', entries: [entry('s1')] }).view;
    v = selectSession(v, 's1', {}).view;
    const r = applyNodeMessage(v, { type: 'catalog', entries: [] });
    expect(r.effects).toContainEqual({ kind: 'ghost', sessionId: 's1' });
    expect(r.view.activeSessionId).toBeNull();
  });
});

describe('订阅', () => {
  it('选会话：置 active/subscribed、进入 syncing、发 subscribe 带游标', () => {
    const r = selectSession(emptyNodeView(), 's1', { s1: 7 });
    expect(r.view.activeSessionId).toBe('s1');
    expect(r.view.subscribedId).toBe('s1');
    expect(r.view.sync.state).toBe('syncing');
    expect(r.effects).toContainEqual({
      kind: 'send',
      command: { type: 'subscribe', sessionId: 's1', sinceIndex: 7 },
    });
  });

  it('选会话（无游标）：subscribe 不带 sinceIndex', () => {
    const r = selectSession(emptyNodeView(), 's1', {});
    expect(r.effects).toContainEqual({
      kind: 'send',
      command: { type: 'subscribe', sessionId: 's1' },
    });
  });

  it('刚 spawn 的会话（fresh）：不进 syncing', () => {
    const r = selectSession(emptyNodeView(), 's1', {}, { fresh: true });
    expect(r.view.sync.state).toBe('synced');
  });

  it('取消选择（null）：发 subscribe null，synced', () => {
    const v = selectSession(emptyNodeView(), 's1', {}).view;
    const r = selectSession(v, null, {});
    expect(r.view.activeSessionId).toBeNull();
    expect(r.view.sync.state).toBe('synced');
    expect(r.effects).toContainEqual({
      kind: 'send',
      command: { type: 'subscribe', sessionId: null },
    });
  });

  it('对方从离线转在线：重发 subscribe（带游标）+ snapshot 拉目录', () => {
    const v = selectSession(emptyNodeView(), 's1', {}).view;
    const r = onHostOnlineChanged(v, true, { s1: 3 });
    expect(r.effects).toContainEqual({
      kind: 'send',
      command: { type: 'subscribe', sessionId: 's1', sinceIndex: 3 },
    });
    expect(r.effects).toContainEqual({ kind: 'send', command: { type: 'snapshot' } });
    // 转离线不发任何东西
    expect(onHostOnlineChanged(v, false, {}).effects).toEqual([]);
  });
});

describe('进入节点时恢复记忆的会话', () => {
  // 真实场景：在节点 B 上看会话 S 后退出，B 删除 S；重启后 store 为空仍按记忆订阅 S，
  // 宿主不回快照，knownIds 为空又判不出幽灵，横幅永远 Syncing…、prompt 发往已删 id。
  it('重启后记忆的会话已被对端删除，第一份不含它的目录按幽灵跳离', () => {
    const v = resumeRememberedSession(emptyNodeView(), 's1', {}).view;
    const r = applyNodeMessage(v, { type: 'catalog', entries: [entry('s2')] });
    expect(r.effects).toContainEqual({ kind: 'ghost', sessionId: 's1' });
    expect(r.view.activeSessionId).toBeNull();
    expect(r.view.sync.state).toBe('synced');
  });

  // 真实场景：重启时停在本机，B 的目录先到；之后切到 B，记忆的 S 已不在目录里，
  // 订阅它同样等不到快照，且 knownIds 里没有它，之后的目录也永远判不出幽灵。
  it('目录已到且记忆的会话不在其中时，不订阅该会话', () => {
    const v = applyNodeMessage(emptyNodeView(), { type: 'catalog', entries: [entry('s2')] }).view;
    const r = resumeRememberedSession(v, 's1', {});
    expect(r.view.activeSessionId).toBeNull();
    expect(r.effects).toContainEqual({
      kind: 'send',
      command: { type: 'subscribe', sessionId: null },
    });
  });

  it('重启后记忆的会话仍在第一份目录里时照常恢复，不误判幽灵', () => {
    const v = resumeRememberedSession(emptyNodeView(), 's1', {}).view;
    const r = applyNodeMessage(v, { type: 'catalog', entries: [entry('s1')] });
    expect(r.effects).toEqual([]);
    expect(r.view.activeSessionId).toBe('s1');
  });

  // 本机刚 spawn、还没进目录的会话：切走再切回时首份目录可能仍不含它，不能当幽灵踢走
  it('刚 spawn 未进目录的会话切走再切回，不被首份目录误判为幽灵', () => {
    let v = applyNodeMessage(emptyNodeView(), { type: 'catalog', entries: [] }).view;
    v = selectSession(v, 'fresh', {}, { fresh: true }).view;
    v = resumeRememberedSession(v, 'fresh', {}).view;
    const r = applyNodeMessage(v, { type: 'catalog', entries: [] });
    expect(r.effects).toEqual([]);
    expect(r.view.activeSessionId).toBe('fresh');
  });
});

describe('agent-event', () => {
  const snapshotFor = (id: string, base: number, texts: string[]) => ({
    type: 'agent-event',
    event: {
      type: 'snapshot',
      sessions: [{ sessionId: id, baseIndex: base, messages: texts.map(msg), status: 'idle' }],
    },
  });

  it('snapshot 建会话视图、结束 syncing、返回 cursor 意图', () => {
    const v = selectSession(emptyNodeView(), 's1', {}).view;
    const r = applyNodeMessage(v, snapshotFor('s1', 4, ['a', 'b']));
    expect([...(r.view.sessions.s1?.messages.keys() ?? [])]).toEqual([4, 5]);
    expect(r.view.sync.state).toBe('synced');
    expect(r.effects).toContainEqual({ kind: 'cursor', sessionId: 's1', index: 5 });
  });

  it('snapshot 不含订阅会话时保持 syncing', () => {
    const v = selectSession(emptyNodeView(), 's1', {}).view;
    const r = applyNodeMessage(v, snapshotFor('other', 0, ['x']));
    expect(r.view.sync.state).toBe('syncing');
  });

  it('message-upsert 写入并返回 cursor 意图；status 流转', () => {
    let v = emptyNodeView();
    const r = applyNodeMessage(v, {
      type: 'agent-event',
      event: { type: 'message-upsert', sessionId: 's1', index: 2, message: msg('hi') },
    });
    v = r.view;
    expect(v.sessions.s1?.messages.get(2)).toEqual(msg('hi'));
    expect(r.effects).toContainEqual({ kind: 'cursor', sessionId: 's1', index: 2 });
    v = applyNodeMessage(v, {
      type: 'agent-event',
      event: { type: 'status', sessionId: 's1', status: 'running' },
    }).view;
    expect(v.sessions.s1?.status).toBe('running');
  });

  it('worker-exited：全部会话 failed', () => {
    let v = applyNodeMessage(emptyNodeView(), snapshotFor('s1', 0, ['a'])).view;
    v = applyNodeMessage(v, snapshotFor('s2', 0, ['b'])).view;
    v = applyNodeMessage(v, { type: 'agent-event', event: { type: 'worker-exited' } }).view;
    expect(Object.values(v.sessions).every((s) => s.status === 'failed')).toBe(true);
  });

  it('无 sessionId 的普通事件忽略', () => {
    const v = emptyNodeView();
    const r = applyNodeMessage(v, { type: 'agent-event', event: { type: 'status', status: 'x' } });
    expect(r.view).toBe(v);
  });
});

describe('history 分页', () => {
  it('history 应答并入并清在途标记；requestHistory 意图只在有更早消息且不在途时发', () => {
    let v = applyNodeMessage(emptyNodeView(), {
      type: 'agent-event',
      event: {
        type: 'snapshot',
        sessions: [{ sessionId: 's1', baseIndex: 10, messages: [msg('n10')], status: 'idle' }],
      },
    }).view;
    v = { ...v, historyPending: new Set(['s1']) };
    const r = applyNodeMessage(v, {
      type: 'history',
      sessionId: 's1',
      baseIndex: 8,
      messages: [msg('h8'), msg('h9')],
    });
    expect([...(r.view.sessions.s1?.messages.keys() ?? [])].sort((a, b) => a - b)).toEqual([
      8, 9, 10,
    ]);
    expect(r.view.historyPending.has('s1')).toBe(false);
  });

  // 真实场景：上滑翻页请求在途时断线（或离线时上滑），重连后宿主收到重发的 subscribe
  // 会作废在途分页，history 回包永不到；标记不清则顶部一直转圈、再也发不出翻页请求。
  it('对方重新上线后清掉翻页在途标记，恢复后仍能继续上滑加载', () => {
    let v = selectSession(emptyNodeView(), 's1', {}).view;
    v = applyNodeMessage(v, {
      type: 'agent-event',
      event: {
        type: 'snapshot',
        sessions: [{ sessionId: 's1', baseIndex: 10, messages: [msg('n10')], status: 'idle' }],
      },
    }).view;
    v = requestHistory(v, 's1').view;
    v = onHostOnlineChanged(v, true, {}).view;

    expect(v.historyPending.has('s1')).toBe(false);
    expect(requestHistory(v, 's1').effects).toContainEqual({
      kind: 'send',
      command: { type: 'history', sessionId: 's1', beforeIndex: 10 },
    });
  });

  it('未知帧类型不改变视图', () => {
    const v: NodeView = emptyNodeView();
    expect(applyNodeMessage(v, { type: 'appearance', theme: 'dark' }).view).toBe(v);
    expect(applyNodeMessage(v, null).view).toBe(v);
  });
});
