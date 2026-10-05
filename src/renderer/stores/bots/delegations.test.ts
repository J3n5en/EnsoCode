import type { ApprovalRequestInfo, AskRequestInfo } from '@shared/types/agent';
import type { BotChat, Delegation } from '@shared/types/bot';
import { describe, expect, it } from 'vitest';
import { emptyProjection } from '@/stores/sessions/reducer';
import {
  activeDelegations,
  delegationActions,
  delegationOwners,
  formatElapsed,
  isRetried,
  openTarget,
  pendingOwners,
} from './delegations';
import { pendingItems } from './selectors';

const record = (over: Partial<Delegation>): Delegation => ({
  id: 'd1',
  parentConversationId: 'p1',
  parentBotId: 'boss',
  targetBotId: 'ops',
  chatId: 'c1',
  task: 'deploy',
  context: '',
  childConversationId: 'k1',
  state: 'running',
  depth: 1,
  createdAt: 10,
  ...over,
});

const chat: BotChat = {
  id: 'c1',
  kind: 'group',
  title: 'g',
  members: ['boss', 'ops'],
  bossBotId: 'boss',
  workspace: { kind: 'chat-home', projectId: 'p' },
  routing: { mode: 'boss', maxHops: 4, maxTurnsPerBot: 2 },
  pinned: false,
  sessions: { boss: { conversationId: 'p1', cursor: 0 } },
  createdAt: 1,
  updatedAt: 1,
  version: 1,
};

describe('delegationOwners / pendingOwners', () => {
  it('进行中委派的子会话归到发起聊天，记下替谁执行；已结束或无聊天的不归属', () => {
    const owners = delegationOwners([
      record({}),
      record({ id: 'd2', childConversationId: 'k2', state: 'completed' }),
      record({ id: 'd3', childConversationId: 'k3', chatId: null }),
    ]);
    expect(owners).toEqual({
      k1: { chatId: 'c1', botId: 'ops', delegation: { id: 'd1', parentBotId: 'boss' } },
    });
  });

  it('委派子会话的审批/提问出现在发起聊天的待处理里', () => {
    const sessions = {
      p1: { ...emptyProjection, pendingAsks: [{ requestId: 'a' } as AskRequestInfo] },
      k1: { ...emptyProjection, pendingApprovals: [{ requestId: 'r' } as ApprovalRequestInfo] },
    };
    const items = pendingItems(sessions, pendingOwners([chat], [record({})]), 'c1');
    expect(items).toHaveLength(2);
    expect(items.find((item) => item.conversationId === 'k1')).toMatchObject({
      kind: 'approval',
      botId: 'ops',
      delegation: { parentBotId: 'boss' },
    });
    expect(pendingItems(sessions, pendingOwners([chat], [record({})]), 'c2')).toEqual([]);
  });
});

describe('activeDelegations', () => {
  it('只取该聊天排队/进行中的委派，按发起时间升序', () => {
    const list = [
      record({ id: 'a', createdAt: 30 }),
      record({ id: 'b', createdAt: 20, state: 'queued' }),
      record({ id: 'c', state: 'failed' }),
      record({ id: 'd', chatId: 'c2' }),
    ];
    expect(activeDelegations(list, 'c1').map((item) => item.id)).toEqual(['b', 'a']);
  });
});

describe('isRetried', () => {
  it('只认 retryOf 指向：同任务的新委派不算重试，重试链各自只标被指向的那条', () => {
    const original = record({ state: 'failed' });
    const lookalike = record({ id: 'd2', createdAt: 60, state: 'canceled' });
    expect(isRetried(original, [original, lookalike])).toBe(false);
    const retry = record({ id: 'd3', createdAt: 70, state: 'failed', retryOf: 'd1' });
    const list = [original, lookalike, retry];
    expect(isRetried(original, list)).toBe(true);
    expect(isRetried(lookalike, list)).toBe(false);
    expect(isRetried(retry, list)).toBe(false);
  });
});

describe('openTarget', () => {
  it('通知点击：有聊天打开聊天，委派子会话打开委派所属聊天，否则打开收件箱', () => {
    const list = [record({}), record({ id: 'd3', childConversationId: 'k3', chatId: null })];
    expect(openTarget({ chatId: 'c9', conversationId: 'k1' }, list)).toEqual({
      kind: 'chat',
      chatId: 'c9',
    });
    expect(openTarget({ conversationId: 'k1' }, list)).toEqual({ kind: 'chat', chatId: 'c1' });
    expect(openTarget({ conversationId: 'k3' }, list)).toEqual({ kind: 'inbox' });
    expect(openTarget({ conversationId: 'zz' }, list)).toEqual({ kind: 'inbox' });
    expect(openTarget({}, list)).toEqual({ kind: 'inbox' });
  });
});

describe('delegationActions', () => {
  it('排队/进行中可取消，失败给重试，手动取消让用户选继续或重新开始，完成都不可', () => {
    const none = { cancel: false, retry: false, resumeOrRestart: false };
    expect(delegationActions('queued')).toEqual({ ...none, cancel: true });
    expect(delegationActions('running')).toEqual({ ...none, cancel: true });
    expect(delegationActions('failed')).toEqual({ ...none, retry: true });
    expect(delegationActions('canceled')).toEqual({ ...none, resumeOrRestart: true });
    expect(delegationActions('completed')).toEqual(none);
  });
});

describe('formatElapsed', () => {
  it('紧凑显示耗时', () => {
    expect(formatElapsed(12_000)).toBe('12s');
    expect(formatElapsed(3 * 60_000 + 5_000)).toBe('3m');
    expect(formatElapsed(65 * 60_000)).toBe('1h 5m');
    expect(formatElapsed(-1)).toBe('0s');
  });
});
