import { describe, expect, it } from 'vitest';
import {
  canShowConversationFork,
  canShowConversationRewind,
  canWakeConversationForRewind,
  extractRewindDraft,
  resolveRewindConfirm,
  rewindKeepCount,
  rewindWorkerPhase,
  shouldSendRewindCommand,
  userIndexFromEndForTimelineKey,
  userIndexFromEndForTurnKey,
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

  it('回退进行中不显示，避免连点再裁一截', () => {
    expect(canShowConversationRewind(root({ started: true, rewinding: true }))).toBe(false);
    expect(canShowConversationRewind(root({ started: true, restoringFiles: true }))).toBe(false);
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

describe('canShowConversationFork', () => {
  it('已 spawn 主会话仅 idle 且非 spawning 显示', () => {
    expect(canShowConversationFork(root({ started: true }))).toBe(true);
    expect(canShowConversationFork(root({ started: true, spawning: true }))).toBe(false);
    expect(canShowConversationFork(root({ started: true, status: 'running' }))).toBe(false);
    expect(canShowConversationFork(root({ started: true, status: 'failed' }))).toBe(false);
  });

  it('未激活的冷主会话（有 jsonl）显示分支', () => {
    expect(canShowConversationFork(root())).toBe(true);
  });

  it('草稿、coworker、historyOnly、工作区不可用、failed 冷会话不显示', () => {
    expect(canShowConversationFork(null)).toBe(false);
    expect(canShowConversationFork(root({ sessionFile: undefined }))).toBe(false);
    expect(canShowConversationFork(root({ parentId: 'parent' }))).toBe(false);
    expect(canShowConversationFork(root({ started: true, parentId: 'parent' }))).toBe(false);
    expect(canShowConversationFork(root({ historyOnly: true }))).toBe(false);
    expect(canShowConversationFork(root({ worktreeMissing: true }))).toBe(false);
    expect(canShowConversationFork(root({ workspaceMigrating: true }))).toBe(false);
    expect(canShowConversationFork(root({ status: 'failed' }))).toBe(false);
  });

  it('宿主关闭分叉或回退时不显示', () => {
    expect(canShowConversationFork(root(), { canRewind: true, canFork: false })).toBe(false);
    expect(canShowConversationFork(root(), { canRewind: false })).toBe(false);
    expect(canShowConversationFork(root(), { canRewind: true })).toBe(true);
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
  const conversation = { messages: [{ role: 'user', entryId: 'u1' }, { role: 'assistant' }] };

  it('displayed 不是 origin 或会话消失则 abort', () => {
    expect(resolveRewindConfirm('a', 'b', conversation, 0)).toBe(null);
    expect(resolveRewindConfirm('a', 'a', undefined, 0)).toBe(null);
  });

  it('对 origin 会话按时间线 key 计算 fromEnd', () => {
    expect(resolveRewindConfirm('a', 'a', conversation, 0)).toEqual({
      conversationId: 'a',
      userIndexFromEnd: 0,
      entryId: 'u1',
    });
  });

  it('未确认的继续不能回退上一轮，即使携带伪 entryId', () => {
    for (const entryId of [undefined, 'u2']) {
      const messages = [...conversation.messages, { role: 'user', optimistic: true, entryId }];
      expect(resolveRewindConfirm('a', 'a', { messages }, 2)).toBeNull();
    }
    expect(resolveRewindConfirm('a', 'a', { messages: [{ role: 'user' }] }, 0)).toBeNull();
  });

  it('确认框绑定 entryId，分页或新消息不改变目标，目标消失就拒绝', () => {
    const changed = {
      messages: [{ role: 'assistant' }, ...conversation.messages, { role: 'user', entryId: 'u2' }],
      historyBaseIndex: 20,
    };
    expect(resolveRewindConfirm('a', 'a', changed, 0, 'u1')).toEqual({
      conversationId: 'a',
      entryId: 'u1',
      userIndexFromEnd: 1,
    });
    expect(resolveRewindConfirm('a', 'a', changed, 21, 'removed')).toBeNull();
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

describe('userIndexFromEndForTurnKey', () => {
  it('从轮末行 key 回溯到本轮 user，按 historyBaseIndex 换算', () => {
    const tail = {
      messages: [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }, { role: 'assistant' }],
      historyBaseIndex: 40,
    };
    expect(userIndexFromEndForTurnKey(tail, 41)).toBe(1);
    expect(userIndexFromEndForTurnKey(tail, 43)).toBe(0);
    expect(userIndexFromEndForTurnKey({ messages: tail.messages }, 3)).toBe(0);
  });

  it('本轮 user 在尾窗之外或 key 非法返回 null', () => {
    const tail = { messages: [{ role: 'assistant' }], historyBaseIndex: 40 };
    expect(userIndexFromEndForTurnKey(tail, 40)).toBe(null);
    expect(userIndexFromEndForTurnKey(tail, 3)).toBe(null);
    expect(userIndexFromEndForTurnKey(tail, Number.NaN)).toBe(null);
  });
});

describe('rewindKeepCount', () => {
  const messages = [
    { role: 'user' },
    { role: 'assistant' },
    { role: 'user' },
    { role: 'assistant' },
  ];

  it('回退最后一条 user 时保留它之前的前缀', () => {
    expect(rewindKeepCount(messages, 0)).toBe(2);
    expect(rewindKeepCount(messages, 1)).toBe(0);
  });

  it('对不上或非法 fromEnd 返回 null', () => {
    expect(rewindKeepCount(messages, 2)).toBe(null);
    expect(rewindKeepCount(messages, -1)).toBe(null);
    expect(rewindKeepCount(messages, 0.5)).toBe(null);
    expect(rewindKeepCount([{ role: 'assistant' }], 0)).toBe(null);
  });
});

describe('extractRewindDraft', () => {
  it('抽出目标 user 的正文和图片', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'two' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    ];
    expect(extractRewindDraft(messages, 0)).toEqual({
      text: 'two',
      images: [{ data: 'AAAA', mimeType: 'image/png' }],
    });
    expect(extractRewindDraft(messages, 1)).toEqual({ text: 'one' });
  });

  it('对不上返回 null', () => {
    expect(extractRewindDraft([{ role: 'assistant', content: [] }], 0)).toBe(null);
  });

  it('已展开的技能块还原成 /skill: 命令，重发不再套层', () => {
    const block = '<skill name="poteto-mode" location="/p/SKILL.md">\nReferences.\n\n# P\n</skill>';
    const draft = (text: string) =>
      extractRewindDraft([{ role: 'user', content: [{ type: 'text', text }] }], 0);
    expect(draft(`${block}\n\n修 bug`)).toEqual({ text: '/skill:poteto-mode 修 bug' });
    expect(draft(block)).toEqual({ text: '/skill:poteto-mode' });
    expect(draft(`前缀 ${block}`)).toEqual({ text: `前缀 ${block}` });
    const other = '<skill name="diffs" location="/d/SKILL.md">\n# D\n</skill>';
    expect(draft(`${block}\n\n${other}\n\n修 bug`)).toEqual({
      text: '/skill:poteto-mode /skill:diffs 修 bug',
    });
    expect(
      draft(`${block}\n\n<unattended>\nUnattended mode is ON: x\n</unattended>\n\n修 bug`)
    ).toEqual({ text: '/skill:poteto-mode 修 bug' });
  });
});
