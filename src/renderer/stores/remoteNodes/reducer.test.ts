import type { ProjectedMessage } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import {
  applyNodeMessage,
  emptyNodeView,
  type NodeView,
  onHostOnlineChanged,
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

  it('未知帧类型不改变视图', () => {
    const v: NodeView = emptyNodeView();
    expect(applyNodeMessage(v, { type: 'appearance', theme: 'dark' }).view).toBe(v);
    expect(applyNodeMessage(v, null).view).toBe(v);
  });
});
