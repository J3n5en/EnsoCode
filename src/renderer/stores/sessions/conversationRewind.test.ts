import { describe, expect, it } from 'vitest';
import {
  canShowConversationRewind,
  canWakeConversationForRewind,
  resolveRewindConfirm,
  rewindWorkerPhase,
  shouldSendRewindCommand,
  userIndexFromEndForTimelineKey,
} from './conversationRewind';

const root = (overrides: Record<string, unknown> = {}) => ({
  started: false,
  spawning: false,
  status: 'idle',
  sessionFile: '/tmp/session.jsonl',
  ...overrides,
});

describe('canShowConversationRewind', () => {
  it('已 spawn 且非 running 的主会话显示回退', () => {
    expect(canShowConversationRewind(root({ started: true }))).toBe(true);
  });

  it('failed 仍显示（与 Retry 对齐）', () => {
    expect(canShowConversationRewind(root({ started: true, status: 'failed' }))).toBe(true);
  });

  it('running / spawning 不显示', () => {
    expect(canShowConversationRewind(root({ started: true, status: 'running' }))).toBe(false);
    expect(canShowConversationRewind(root({ started: true, spawning: true }))).toBe(false);
    expect(canShowConversationRewind(root({ spawning: true }))).toBe(false);
  });

  it('冷加载历史主会话（未 started、有 jsonl）显示回退', () => {
    expect(canShowConversationRewind(root())).toBe(true);
  });

  it('无 jsonl 的草稿不显示', () => {
    expect(canShowConversationRewind(root({ sessionFile: undefined }))).toBe(false);
  });

  it('historyOnly 已结束 child 不显示', () => {
    expect(canShowConversationRewind(root({ historyOnly: true }))).toBe(false);
    expect(
      canShowConversationRewind(root({ started: true, parentId: 'parent', historyOnly: true }))
    ).toBe(false);
  });

  it('未恢复的 coworker 不显示（不独立唤醒）', () => {
    expect(canShowConversationRewind(root({ parentId: 'parent' }))).toBe(false);
  });

  it('已 spawn 的 coworker 仍显示', () => {
    expect(canShowConversationRewind(root({ started: true, parentId: 'parent' }))).toBe(true);
  });

  it('远程宿主关闭回退时不显示', () => {
    expect(canShowConversationRewind(root({ started: true }), { canRewind: false })).toBe(false);
  });

  it('空会话不显示', () => {
    expect(canShowConversationRewind(null)).toBe(false);
  });

  it('worktree 丢失或工作区迁移中不显示', () => {
    expect(canShowConversationRewind(root({ started: true, worktreeMissing: true }))).toBe(false);
    expect(canShowConversationRewind(root({ workspaceMigrating: true }))).toBe(false);
  });
});

describe('canWakeConversationForRewind', () => {
  it('仅冷主会话有 jsonl 时可唤醒', () => {
    expect(canWakeConversationForRewind(root())).toBe(true);
    expect(canWakeConversationForRewind(root({ started: true }))).toBe(false);
    expect(canWakeConversationForRewind(root({ parentId: 'parent' }))).toBe(false);
    expect(canWakeConversationForRewind(root({ historyOnly: true }))).toBe(false);
    expect(canWakeConversationForRewind(root({ sessionFile: undefined }))).toBe(false);
    expect(canWakeConversationForRewind(root({ status: 'running' }))).toBe(false);
    expect(canWakeConversationForRewind(root({ spawning: true }))).toBe(false);
    expect(canWakeConversationForRewind(root({ worktreeMissing: true }))).toBe(false);
    expect(canWakeConversationForRewind(root({ workspaceMigrating: true }))).toBe(false);
  });
});

describe('shouldSendRewindCommand', () => {
  it('已 spawn 且非 running / spawning 才下发', () => {
    expect(shouldSendRewindCommand(root({ started: true }))).toBe(true);
    expect(shouldSendRewindCommand(root({ started: true, status: 'failed' }))).toBe(true);
  });

  it('恢复失败、仍未 started、running、spawning、historyOnly、目标消失都不下发', () => {
    expect(shouldSendRewindCommand(root())).toBe(false);
    expect(shouldSendRewindCommand(root({ started: true, status: 'running' }))).toBe(false);
    expect(shouldSendRewindCommand(root({ started: true, spawning: true }))).toBe(false);
    expect(shouldSendRewindCommand(root({ started: true, historyOnly: true }))).toBe(false);
    expect(shouldSendRewindCommand(undefined)).toBe(false);
  });
});

describe('rewindWorkerPhase', () => {
  it('spawning 时 wait，清 spawning 后 ready', () => {
    expect(rewindWorkerPhase(root({ started: true, spawning: true }), '/tmp/session.jsonl')).toBe(
      'wait'
    );
    expect(rewindWorkerPhase(root({ started: true, spawning: false }), '/tmp/session.jsonl')).toBe(
      'ready'
    );
  });

  it('会话移除、jsonl 被换、running、historyOnly 为 failed', () => {
    expect(rewindWorkerPhase(undefined, '/tmp/session.jsonl')).toBe('failed');
    expect(
      rewindWorkerPhase(
        root({ started: true, sessionFile: '/tmp/other.jsonl' }),
        '/tmp/session.jsonl'
      )
    ).toBe('failed');
    expect(
      rewindWorkerPhase(root({ started: true, status: 'running' }), '/tmp/session.jsonl')
    ).toBe('failed');
    expect(
      rewindWorkerPhase(root({ started: true, historyOnly: true }), '/tmp/session.jsonl')
    ).toBe('failed');
  });
});

describe('resolveRewindConfirm', () => {
  const conversation = { messages: [{ role: 'user' }, { role: 'assistant' }] };

  it('displayed 不是 origin 或会话消失则 abort', () => {
    expect(resolveRewindConfirm('a', 'b', conversation, 0)).toBe(null);
    expect(resolveRewindConfirm('a', 'a', undefined, 0)).toBe(null);
  });

  it('对 origin 会话按时间线 key 计算 fromEnd', () => {
    expect(resolveRewindConfirm('a', 'a', conversation, 0)).toEqual({
      conversationId: 'a',
      userIndexFromEnd: 0,
    });
  });
});

describe('userIndexFromEndForTimelineKey', () => {
  const messages = [
    { role: 'user' },
    { role: 'assistant' },
    { role: 'user' },
    { role: 'assistant' },
  ];

  it('全量投影：按本地下标从末尾数 user', () => {
    expect(userIndexFromEndForTimelineKey({ messages }, 2)).toBe(0);
    expect(userIndexFromEndForTimelineKey({ messages }, 0)).toBe(1);
  });

  it('尾窗分页：行 key 是 historyBaseIndex+localIndex，不能直接索引 messages', () => {
    const tail = {
      messages: [{ role: 'user' }, { role: 'assistant' }],
      historyBaseIndex: 12,
    };
    expect(userIndexFromEndForTimelineKey(tail, 12)).toBe(0);
    expect(userIndexFromEndForTimelineKey(tail, 13)).toBe(null);
  });

  it('两条可见 user：较早那条的 fromEnd 计入其后的 user', () => {
    const tail = {
      messages: [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }],
      historyBaseIndex: 40,
    };
    expect(userIndexFromEndForTimelineKey(tail, 40)).toBe(1);
    expect(userIndexFromEndForTimelineKey(tail, 42)).toBe(0);
  });

  it('越界、非 user、非整数 key 返回 null', () => {
    expect(userIndexFromEndForTimelineKey({ messages, historyBaseIndex: 12 }, 0)).toBe(null);
    expect(userIndexFromEndForTimelineKey({ messages }, 1)).toBe(null);
    expect(userIndexFromEndForTimelineKey({ messages }, Number.NaN)).toBe(null);
    expect(userIndexFromEndForTimelineKey({ messages }, 1.5)).toBe(null);
  });
});
