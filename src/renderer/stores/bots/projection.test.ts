import type { ProjectedMessage, RendererAgentEvent } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { emptyProjection } from '@/stores/sessions/reducer';
import { applyBotAgentEvent, type BotSessions, seedHistory } from './projection';
import { messagePreview } from './selectors';
import { directMarker, isUnread } from './unread';

const msg = (role: string, text: string): ProjectedMessage => ({
  role,
  content: [{ type: 'text', text }],
});
const identity = (sessionId: string, generation = 'g1') => ({ sessionId, generation });
const upsert = (sessionId: string, seq: number, index: number, text: string, generation = 'g1') =>
  ({
    type: 'message-upsert',
    identity: identity(sessionId, generation),
    seq,
    index,
    message: msg('assistant', text),
  }) as RendererAgentEvent;

const tracked = (ids: string[]): BotSessions =>
  Object.fromEntries(ids.map((id) => [id, { ...emptyProjection }]));

describe('applyBotAgentEvent', () => {
  it('Main 冷恢复仅先发新代 session-meta 时，权威快照后状态、摘要和未读继续实时更新', () => {
    const old = {
      a: { ...emptyProjection, generation: 'g1', lastSeq: 90, messages: [msg('user', 'old')] },
    };
    const resumed = applyBotAgentEvent(old, {
      type: 'session-meta',
      identity: identity('a', 'g2'),
      seq: 2,
      sessionFile: '/session',
    });
    expect(resumed.resync).toEqual(['a']);
    expect(resumed.sessions).toBe(old);
    let sessions = applyBotAgentEvent(old, {
      type: 'snapshot',
      partial: true,
      sessions: [
        { identity: identity('a', 'g2'), status: 'idle', messages: old.a.messages, commands: [] },
      ],
    } as RendererAgentEvent).sessions;
    sessions = applyBotAgentEvent(sessions, {
      type: 'status',
      identity: identity('a', 'g2'),
      seq: 3,
      status: 'running',
    }).sessions;
    expect(sessions.a.status).toBe('running');
    sessions = applyBotAgentEvent(sessions, upsert('a', 4, 1, '新结果', 'g2')).sessions;
    expect(messagePreview(sessions.a.messages.at(-1)!)).toBe('新结果');
    expect(isUnread(directMarker(sessions.a), directMarker(old.a))).toBe(true);
    sessions = applyBotAgentEvent(sessions, {
      type: 'status',
      identity: identity('a', 'g2'),
      seq: 5,
      status: 'idle',
    }).sessions;
    expect(sessions.a.status).toBe('idle');
    expect(applyBotAgentEvent(sessions, upsert('a', 4, 1, '过期', 'g2')).sessions).toBe(sessions);
    expect(applyBotAgentEvent(sessions, upsert('a', 99, 1, '旧代', 'g1')).sessions).toBe(sessions);
  });
  it('只归并已跟踪的 bot 会话，其它会话原样返回', () => {
    const sessions = tracked(['a']);
    const result = applyBotAgentEvent(sessions, upsert('code-session', 1, 0, 'x'));
    expect(result.sessions).toBe(sessions);
    expect(result.resync).toEqual([]);
  });

  it('首个事件领养 generation 并写入正文', () => {
    const result = applyBotAgentEvent(tracked(['a']), upsert('a', 1, 0, 'hello'));
    expect(result.sessions.a.generation).toBe('g1');
    expect(result.sessions.a.messages.map((m) => m.content[0])).toEqual([
      { type: 'text', text: 'hello' },
    ]);
  });

  it('新一代 ready 时换代并保留已有正文，请求快照补齐', () => {
    const sessions: BotSessions = {
      a: { ...emptyProjection, generation: 'g1', lastSeq: 9, messages: [msg('user', 'hi')] },
    };
    const ready = {
      type: 'parent-ready',
      identity: identity('a', 'g2'),
      seq: 1,
      sessionFile: '/x',
      model: { providerId: 'p', modelId: 'm' },
    } as unknown as RendererAgentEvent;
    const result = applyBotAgentEvent(sessions, ready);
    expect(result.sessions.a.generation).toBe('g2');
    expect(result.sessions.a.lastSeq).toBe(1);
    expect(result.sessions.a.messages).toHaveLength(1);
    expect(result.resync).toEqual(['a']);
  });

  it('其它事件的 generation 对不上时不改投影，只请求快照', () => {
    const sessions: BotSessions = { a: { ...emptyProjection, generation: 'g1', lastSeq: 2 } };
    const result = applyBotAgentEvent(sessions, upsert('a', 3, 0, 'x', 'g9'));
    expect(result.sessions.a).toBe(sessions.a);
    expect(result.resync).toEqual(['a']);
  });

  it('upsert 落在本地正文之外时请求快照', () => {
    const sessions: BotSessions = { a: { ...emptyProjection, generation: 'g1' } };
    const result = applyBotAgentEvent(sessions, upsert('a', 1, 5, 'far'));
    expect(result.sessions.a.messages).toHaveLength(0);
    expect(result.resync).toEqual(['a']);
  });

  it('快照只覆盖已跟踪的会话', () => {
    const snapshot = {
      type: 'snapshot',
      partial: true,
      sessions: [
        { identity: identity('a'), status: 'running', messages: [msg('user', 'q')], commands: [] },
        { identity: identity('code'), status: 'idle', messages: [], commands: [] },
      ],
    } as unknown as RendererAgentEvent;
    const result = applyBotAgentEvent(tracked(['a', 'b']), snapshot);
    expect(result.sessions.a.status).toBe('running');
    expect(result.sessions.a.messages).toHaveLength(1);
    expect(result.sessions.b.status).toBe('idle');
    expect(result.sessions.code).toBeUndefined();
  });

  it('worker 退出时所有跟踪会话转 failed', () => {
    const sessions: BotSessions = { a: { ...emptyProjection, status: 'running', lastSeq: 4 } };
    const result = applyBotAgentEvent(sessions, { type: 'worker-exited' } as RendererAgentEvent);
    expect(result.sessions.a.status).toBe('failed');
    expect(result.sessions.a.lastSeq).toBe(0);
  });
});

describe('seedHistory', () => {
  it('尚未收到事件时用历史尾窗填充', () => {
    const next = seedHistory(emptyProjection, { baseIndex: 3, messages: [msg('user', 'old')] });
    expect(next.messages).toHaveLength(1);
    expect(next.historyBaseIndex).toBe(3);
  });

  it('已有事件流正文时不覆盖', () => {
    const live = { ...emptyProjection, generation: 'g1', messages: [msg('assistant', 'live')] };
    expect(seedHistory(live, { baseIndex: 0, messages: [msg('user', 'old')] })).toBe(live);
  });

  it('baseIndex 为 0 时不留 historyBaseIndex', () => {
    const next = seedHistory(emptyProjection, { baseIndex: 0, messages: [msg('user', 'a')] });
    expect(next.historyBaseIndex).toBeUndefined();
  });
});
