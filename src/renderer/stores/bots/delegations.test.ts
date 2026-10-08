import type { ApprovalRequestInfo, AskRequestInfo } from '@shared/types/agent';
import type { BotChat, Delegation } from '@shared/types/bot';
import { describe, expect, it } from 'vitest';
import { emptyProjection } from '@/stores/sessions/reducer';
import {
  activeDelegations,
  delegationActions,
  delegationLiveTarget,
  delegationOwners,
  delegationRunMarks,
  formatElapsed,
  isAutoRetrying,
  isAwaitingAutoRetry,
  isRetried,
  openTarget,
  pendingOwners,
  retryAttempt,
  retrySource,
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

  it('等待自动重试的失败记录视同未结束；已被接替或放弃自动重试的不算', () => {
    const list = [
      record({ id: 'w', createdAt: 5, state: 'failed', autoRetryAt: 99 }),
      record({ id: 'x', createdAt: 6, state: 'failed', autoRetryAt: 99 }),
      record({ id: 'x2', createdAt: 40, state: 'running', retryOf: 'x', retryBy: 'auto' }),
      record({ id: 'f', createdAt: 7, state: 'failed' }),
    ];
    expect(activeDelegations(list, 'c1').map((item) => item.id)).toEqual(['w', 'x2']);
  });
});

describe('isAwaitingAutoRetry', () => {
  it('失败、排了 autoRetryAt、且没有记录以 retryOf 接替它', () => {
    const waiting = record({ state: 'failed', failure: 'error', autoRetryAt: 50 });
    expect(isAwaitingAutoRetry(waiting, [waiting])).toBe(true);
    const next = record({ id: 'd2', retryOf: 'd1', retryBy: 'auto' });
    expect(isAwaitingAutoRetry(waiting, [waiting, next])).toBe(false);
    // 人工接替同样算已接替
    const human = record({ id: 'd3', retryOf: 'd1', retryBy: 'human', state: 'queued' });
    expect(isAwaitingAutoRetry(waiting, [waiting, human])).toBe(false);
  });

  it('没有 autoRetryAt（放弃自动重试 / 不可自动重试）或非失败态都不算', () => {
    const final = record({ state: 'failed', failure: 'timeout' });
    expect(isAwaitingAutoRetry(final, [final])).toBe(false);
    for (const state of ['queued', 'running', 'completed', 'canceled'] as const) {
      const item = record({ state, autoRetryAt: 50 });
      expect(isAwaitingAutoRetry(item, [item])).toBe(false);
    }
  });
});

describe('isAutoRetrying', () => {
  it('接替记录由自动重试发起且仍在排队 / 进行', () => {
    expect(isAutoRetrying(record({ retryOf: 'd0', retryBy: 'auto' }))).toBe(true);
    expect(isAutoRetrying(record({ retryOf: 'd0', retryBy: 'auto', state: 'queued' }))).toBe(true);
    expect(isAutoRetrying(record({ retryOf: 'd0', retryBy: 'auto', state: 'completed' }))).toBe(
      false
    );
    expect(isAutoRetrying(record({ retryOf: 'd0', retryBy: 'delegator' }))).toBe(false);
    // 旧数据没有 retryBy：按人工处理
    expect(isAutoRetrying(record({ retryOf: 'd0' }))).toBe(false);
  });
});

describe('retryAttempt / retrySource', () => {
  const chain = [
    record({ id: 'a', state: 'failed' }),
    record({ id: 'b', state: 'failed', retryOf: 'a', retryBy: 'auto' }),
    record({ id: 'c', state: 'failed', retryOf: 'b', retryBy: 'delegator' }),
    record({ id: 'd', state: 'running', retryOf: 'c' }),
  ];
  const get = (id: string) => chain.find((item) => item.id === id)!;

  it('沿 retryOf 往上数：原始委派是 0，每接替一次加一', () => {
    expect(['a', 'b', 'c', 'd'].map((id) => retryAttempt(get(id), chain))).toEqual([0, 1, 2, 3]);
  });

  it('上游记录已不在列表里时，按已知部分计（至少算一次）', () => {
    expect(retryAttempt(get('c'), [get('c')])).toBe(1);
    expect(retryAttempt(get('d'), [get('c'), get('d')])).toBe(2);
  });

  it('retryOf 成环时不死循环', () => {
    const loop = [
      record({ id: 'x', retryOf: 'y', retryBy: 'auto' }),
      record({ id: 'y', retryOf: 'x', retryBy: 'auto' }),
    ];
    expect(retryAttempt(loop[0], loop)).toBe(2);
  });

  it('重试来源：非重试记录没有来源，旧数据缺省视为手动', () => {
    expect(['a', 'b', 'c', 'd'].map((id) => retrySource(get(id)))).toEqual([
      undefined,
      'auto',
      'delegator',
      'human',
    ]);
  });
});

describe('delegationLiveTarget', () => {
  it('排队/进行中委派的子会话返回目标成员，已结束或非委派会话返回 undefined', () => {
    const list = [
      record({ state: 'queued' }),
      record({ id: 'd2', childConversationId: 'k2', targetBotId: 'boss' }),
      record({ id: 'd3', childConversationId: 'k3', state: 'completed' }),
      record({ id: 'd4', childConversationId: 'k4', state: 'failed' }),
      record({ id: 'd5', childConversationId: 'k5', state: 'canceled' }),
    ];
    expect(delegationLiveTarget(list, 'k1')).toEqual({ botId: 'ops' });
    expect(delegationLiveTarget(list, 'k2')).toEqual({ botId: 'boss' });
    for (const id of ['k3', 'k4', 'k5', 'member-session']) {
      expect(delegationLiveTarget(list, id)).toBeUndefined();
    }
  });

  it('委派记录离开列表（如刷新间隙）后不再命中', () => {
    expect(delegationLiveTarget([], 'k1')).toBeUndefined();
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

describe('delegationRunMarks', () => {
  it('同一子会话有两次以上开工的执行才给分隔：按开工时间编号，带来源', () => {
    const marks = delegationRunMarks(
      [
        record({ id: 'r2', trigger: 'rework', createdAt: 50, startedAt: 60, state: 'running' }),
        record({ id: 'r1', createdAt: 10, startedAt: 12, state: 'completed' }),
        record({ id: 'q', trigger: 'retry', createdAt: 70, state: 'queued' }),
        record({ id: 'other', childConversationId: 'k2', createdAt: 5, startedAt: 6 }),
      ],
      'k1'
    );
    expect(marks).toEqual([
      { key: 'run:r1', at: 12, n: 1, trigger: 'delegate' },
      { key: 'run:r2', at: 60, n: 2, trigger: 'rework' },
    ]);
  });

  it('旧记录没有开工时间时按发起时间；只有一次执行不分隔', () => {
    expect(
      delegationRunMarks(
        [
          record({ id: 'a', createdAt: 10, state: 'failed' }),
          record({ id: 'b', trigger: 'retry', createdAt: 30, state: 'completed' }),
        ],
        'k1'
      ).map((mark) => mark.at)
    ).toEqual([10, 30]);
    expect(delegationRunMarks([record({ startedAt: 12 })], 'k1')).toEqual([]);
  });
});
