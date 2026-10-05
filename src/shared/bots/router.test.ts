import { describe, expect, it } from 'vitest';
import type { BotChat, GroupEntry } from '../types/bot';
import {
  buildSummaryNote,
  isSkipReply,
  mergePending,
  needsSmartRoute,
  onHumanMessage,
  onReply,
  type RouterState,
  shouldRoute,
  startRound,
} from './router';

type Human = Extract<GroupEntry, { kind: 'human' }>;

const members = [
  { id: 'boss', name: '老板' },
  { id: 'fe', name: '前端' },
  { id: 'be', name: 'Backend' },
  { id: 'old', name: '老员工', archivedAt: 1 },
];

function chat(
  routing: Partial<BotChat['routing']> = {},
  mode: BotChat['routing']['mode'] = 'boss'
): BotChat {
  return {
    id: 'chat',
    kind: 'group',
    title: '群',
    members: ['boss', 'fe', 'be', 'old'],
    bossBotId: 'boss',
    workspace: { kind: 'project', projectId: 'p' },
    routing: { mode, maxHops: 4, maxTurnsPerBot: 2, ...routing },
    pinned: false,
    sessions: {
      boss: { conversationId: 'c-boss', cursor: 0 },
      fe: { conversationId: 'c-fe', cursor: 0 },
    },
    createdAt: 0,
    updatedAt: 0,
    version: 0,
  };
}

const human = (text: string, mentions: string[] = [], seq = 1): Human => ({
  kind: 'human',
  seq,
  id: `h${seq}`,
  at: 0,
  text,
  mentions,
});

describe('startRound', () => {
  it('没有 @ 时由群主回复', () => {
    const state = startRound(chat(), members, human('大家好', [], 7));
    expect(state).toEqual({
      rootEntrySeq: 7,
      queue: [],
      current: 'boss',
      hops: 0,
      turnsByBot: { boss: 1 },
      noticed: [],
    });
  });

  it('有 @ 时按出现顺序排队', () => {
    const state = startRound(chat(), members, human('@Backend 先，@前端 后'));
    expect(state.current).toBe('be');
    expect(state.queue).toEqual(['fe']);
  });

  it('entry.mentions 非空时以其为准', () => {
    const state = startRound(chat(), members, human('@Backend', ['fe', 'be']));
    expect([state.current, ...state.queue]).toEqual(['fe', 'be']);
  });

  it('@所有人 展开为在群且未归档的全体成员，按群成员顺序', () => {
    const state = startRound(chat(), members, human('@所有人'));
    expect([state.current, ...state.queue]).toEqual(['boss', 'fe', 'be']);
  });

  it('只 @ 了已归档或不在群的成员时退回群主', () => {
    const state = startRound(chat(), members, human('@老员工', ['old', 'ghost']));
    expect(state.current).toBe('boss');
  });

  it('群主也不可用时没有回复人', () => {
    const state = startRound(chat(), [], human('hi'));
    expect(state.current).toBeNull();
    expect(state.queue).toEqual([]);
  });

  it('没有 @ 时用智能选中的在群成员', () => {
    const state = startRound(chat({}, 'smart'), members, human('hi'), ['be']);
    expect(state.current).toBe('be');
    expect(state.turnsByBot).toEqual({ be: 1 });
  });

  it('智能选中多人时按名单顺序排队，不计接力跳数', () => {
    const state = startRound(chat({}, 'smart'), members, human('hi'), ['be', 'boss', 'fe']);
    expect([state.current, ...state.queue]).toEqual(['be', 'boss', 'fe']);
    expect(state.hops).toBe(0);
    expect(state.turnsByBot).toEqual({ be: 1 });
  });

  it('智能名单去重并丢弃已归档或不在群的成员', () => {
    const state = startRound(chat({}, 'smart'), members, human('hi'), [
      'fe',
      'old',
      'ghost',
      'fe',
      'be',
    ]);
    expect([state.current, ...state.queue]).toEqual(['fe', 'be']);
  });

  it('智能选中已归档或不在群的成员时退回群主', () => {
    expect(startRound(chat({}, 'smart'), members, human('hi'), ['old']).current).toBe('boss');
    expect(startRound(chat({}, 'smart'), members, human('hi'), ['ghost']).current).toBe('boss');
    expect(startRound(chat({}, 'smart'), members, human('hi'), []).current).toBe('boss');
  });

  it('有 @ 时忽略智能选人结果', () => {
    const state = startRound(chat({}, 'smart'), members, human('@前端'), ['be', 'boss']);
    expect([state.current, ...state.queue]).toEqual(['fe']);
  });
});

describe('needsSmartRoute', () => {
  const smart = chat({}, 'smart');

  it('smart 模式下没有任何 @ 的人类消息需要智能选人', () => {
    expect(needsSmartRoute(smart, members, human('帮我看看'))).toBe(true);
  });

  it('boss 模式不选人', () => {
    expect(needsSmartRoute(chat(), members, human('帮我看看'))).toBe(false);
  });

  it('含 @（含 @所有人、@已归档成员）时不选人', () => {
    expect(needsSmartRoute(smart, members, human('@前端 看看'))).toBe(false);
    expect(needsSmartRoute(smart, members, human('@所有人 看看'))).toBe(false);
    expect(needsSmartRoute(smart, members, human('@老员工 看看'))).toBe(false);
    expect(needsSmartRoute(smart, members, human('看看', ['fe']))).toBe(false);
  });

  it('可选成员不足两位时不选人', () => {
    expect(needsSmartRoute(smart, members.slice(0, 1), human('hi'))).toBe(false);
  });

  it('静音成员不计入可选成员', () => {
    expect(needsSmartRoute(chat({ muted: ['fe', 'be'] }, 'smart'), members, human('hi'))).toBe(
      false
    );
    expect(needsSmartRoute(chat({ muted: ['fe'] }, 'smart'), members, human('hi'))).toBe(true);
  });
});

describe('静音成员', () => {
  const muted = chat({ muted: ['fe'] }, 'smart');

  it('被点名 @ 时照常回复', () => {
    expect(startRound(muted, members, human('@前端 看下')).current).toBe('fe');
    expect(startRound(muted, members, human('看下', ['fe'])).current).toBe('fe');
  });

  it('@所有人 不含静音成员，同时点名则包含', () => {
    const all = startRound(muted, members, human('@所有人', ['boss', 'fe', 'be']));
    expect([all.current, ...all.queue]).toEqual(['boss', 'be']);
    const named = startRound(muted, members, human('@所有人 @前端'));
    expect([named.current, ...named.queue]).toEqual(['boss', 'fe', 'be']);
  });

  it('智能名单跳过静音成员，只剩静音成员时退回群主', () => {
    const state = startRound(muted, members, human('hi'), ['fe', 'be']);
    expect([state.current, ...state.queue]).toEqual(['be']);
    expect(startRound(muted, members, human('hi'), ['fe']).current).toBe('boss');
  });

  it('成员回复里点名静音成员照常接力，@所有人 不接力给静音成员', () => {
    const begin = startRound(muted, members, human('@老板'));
    expect(onReply(begin, muted, members, { botId: 'boss', text: '@前端 看下' }).next).toBe('fe');
    const all = onReply(begin, muted, members, { botId: 'boss', text: '@所有人 看下' });
    expect([all.next, ...all.state.queue]).toEqual(['be']);
  });
});

describe('onReply', () => {
  const begin = (text = '@老板', c = chat()) => startRound(c, members, human(text));

  it('回复里 @ 别人时接力入队，并轮到下一位', () => {
    const r = onReply(begin(), chat(), members, { botId: 'boss', text: '@前端 @Backend 你们看' });
    expect(r.next).toBe('fe');
    expect(r.state.queue).toEqual(['be']);
    expect(r.state.hops).toBe(2);
    expect(r.state.turnsByBot).toEqual({ boss: 1, fe: 1 });
    expect(r.skipped).toBe(false);
  });

  it('@ 自己和已在队列中的成员不重复入队、不计跳', () => {
    const s = startRound(chat(), members, human('@老板 @前端'));
    const r = onReply(s, chat(), members, { botId: 'boss', text: '@老板 @前端 @所有人' });
    expect(r.state.hops).toBe(1);
    expect([r.next, ...r.state.queue]).toEqual(['fe', 'be']);
  });

  it('本轮已委派的成员被 @ 时不接力、不计跳，其余 @ 照常接力', () => {
    const r = onReply(begin(), chat(), members, {
      botId: 'boss',
      text: '已安排 @前端 处理，@Backend 你也看看',
      delegated: ['fe'],
    });
    expect([r.next, ...r.state.queue]).toEqual(['be']);
    expect(r.state.hops).toBe(1);
    expect(r.notices).toEqual([]);
    const all = onReply(begin(), chat(), members, {
      botId: 'boss',
      text: '@前端 @Backend',
      delegated: ['fe', 'be'],
    });
    expect(all.next).toBeNull();
    expect(all.state.hops).toBe(0);
  });

  it('[skip] 不区分大小写且忽略空白，跳过时不解析 @', () => {
    const r = onReply(begin(), chat(), members, { botId: 'boss', text: '  [SKIP]\n' });
    expect(r.skipped).toBe(true);
    expect(r.next).toBeNull();
    expect(r.state.hops).toBe(0);
  });

  it('[skip] 附带其他内容时不算跳过', () => {
    const r = onReply(begin(), chat(), members, { botId: 'boss', text: '[skip] @前端' });
    expect(r.skipped).toBe(false);
    expect(r.next).toBe('fe');
  });

  it('[skip] 照常推进到队列下一位，且不计入该成员的回复次数', () => {
    const c = chat({ maxHops: 4, maxTurnsPerBot: 1 });
    const s = startRound(c, members, human('@前端 @老板'));
    const r = onReply(s, c, members, { botId: 'fe', text: '[skip]' });
    expect(r.next).toBe('boss');
    expect(r.state.turnsByBot.fe ?? 0).toBe(0);
    const r2 = onReply(r.state, c, members, { botId: 'boss', text: '@前端 你看看' });
    expect(r2.next).toBe('fe');
    expect(r2.notices).toEqual([]);
  });

  it('队列空时轮次结束', () => {
    const r = onReply(begin(), chat(), members, { botId: 'boss', text: '好的' });
    expect(r.next).toBeNull();
    expect(r.state.current).toBeNull();
  });

  it('不是当前回复人的回复被忽略', () => {
    const s = begin();
    const r = onReply(s, chat(), members, { botId: 'fe', text: '@Backend' });
    expect(r.state).toEqual(s);
    expect(r.next).toBe('boss');
  });

  it('跳数恰好达到 maxHops 时仍可入队，超过则拦下并提示一次', () => {
    const c = chat({ maxHops: 1, maxTurnsPerBot: 5 });
    let r = onReply(begin('@老板', c), c, members, { botId: 'boss', text: '@前端 @Backend' });
    expect(r.state.hops).toBe(1);
    expect([r.next, ...r.state.queue]).toEqual(['fe']);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toContain('Backend');
    r = onReply(r.state, c, members, { botId: 'fe', text: '@Backend' });
    expect(r.next).toBeNull();
    expect(r.notices).toEqual([]);
  });

  it('成员回复次数达到 maxTurnsPerBot 后不再入队', () => {
    const c = chat({ maxHops: 10, maxTurnsPerBot: 1 });
    const r = onReply(begin('@老板', c), c, members, { botId: 'boss', text: '@前端' });
    const r2 = onReply(r.state, c, members, { botId: 'fe', text: '@老板' });
    expect(r2.next).toBeNull();
    expect(r2.notices).toHaveLength(1);
    expect(r2.notices[0]).toContain('老板');
    expect(r2.state.hops).toBe(1);
  });

  it('次数未达上限时可以回到之前的成员', () => {
    const r = onReply(begin(), chat(), members, { botId: 'boss', text: '@前端' });
    const r2 = onReply(r.state, chat(), members, { botId: 'fe', text: '@老板' });
    expect(r2.next).toBe('boss');
    expect(r2.state.turnsByBot.boss).toBe(2);
  });

  it('不在群或已归档的成员不入队', () => {
    const r = onReply(begin(), chat(), members, { botId: 'boss', text: '@老员工' });
    expect(r.next).toBeNull();
    expect(r.state.hops).toBe(0);
  });

  it('状态可 JSON 往返且输入状态不被修改', () => {
    const s = begin();
    const snapshot = JSON.parse(JSON.stringify(s)) as RouterState;
    onReply(s, chat(), members, { botId: 'boss', text: '@前端' });
    expect(s).toEqual(snapshot);
  });
});

describe('群主派单后的汇总提醒', () => {
  const dispatched = (c = chat({ maxHops: 6, maxTurnsPerBot: 2 })) =>
    onReply(startRound(c, members, human('出方案')), c, members, {
      botId: 'boss',
      text: '@前端 @Backend 各给一个方案',
    });

  it('群主 @ 派出的成员记入待回报名单，全部回复后追加一跳群主汇总', () => {
    const c = chat({ maxHops: 6, maxTurnsPerBot: 2 });
    const r = dispatched(c);
    expect(r.state.waiting).toEqual(['fe', 'be']);
    const r2 = onReply(r.state, c, members, { botId: 'fe', text: '方案 A', seq: 10 });
    expect(r2.summary).toBeUndefined();
    expect(r2.state.waiting).toEqual(['be']);
    const r3 = onReply(r2.state, c, members, { botId: 'be', text: '方案 B', seq: 11 });
    expect(r3.next).toBe('boss');
    expect(r3.summary).toEqual({
      botId: 'boss',
      reports: [
        { botId: 'fe', seq: 10 },
        { botId: 'be', seq: 11 },
      ],
    });
    expect(r3.state.hops).toBe(3);
    expect(r3.state.turnsByBot.boss).toBe(2);
    expect(r3.state.waiting).toBeUndefined();
    const r4 = onReply(r3.state, c, members, { botId: 'boss', text: '结论：用 A', seq: 12 });
    expect(r4.next).toBeNull();
    expect(r4.summary).toBeUndefined();
  });

  it('[skip] 视为已回报但没有 seq', () => {
    const c = chat({ maxHops: 6, maxTurnsPerBot: 2 });
    const r = onReply(dispatched(c).state, c, members, { botId: 'fe', text: '[skip]', seq: 10 });
    const r2 = onReply(r.state, c, members, { botId: 'be', text: '方案 B', seq: 11 });
    expect(r2.summary?.reports).toEqual([{ botId: 'fe' }, { botId: 'be', seq: 11 }]);
  });

  it('派出的成员都没发言（[skip] / 失败）时不提醒', () => {
    const c = chat({ maxHops: 6, maxTurnsPerBot: 2 });
    const r = onReply(dispatched(c).state, c, members, { botId: 'fe', text: '[skip]', seq: 10 });
    const r2 = onReply(r.state, c, members, { botId: 'be', text: '' });
    expect(r2.next).toBeNull();
    expect(r2.summary).toBeUndefined();
    expect(r2.notices).toEqual([]);
  });

  it('最后一条回复已 @ 群主或群主已在队列中时不另发', () => {
    const c = chat({ maxHops: 6, maxTurnsPerBot: 2 });
    const r = onReply(dispatched(c).state, c, members, { botId: 'fe', text: 'A', seq: 10 });
    const r2 = onReply(r.state, c, members, { botId: 'be', text: '@老板 B', seq: 11 });
    expect(r2.next).toBe('boss');
    expect(r2.summary).toBeUndefined();
    expect(r2.state.hops).toBe(3);
    const q = onReply(dispatched(c).state, c, members, { botId: 'fe', text: '@老板 A', seq: 10 });
    const q2 = onReply(q.state, c, members, { botId: 'be', text: 'B', seq: 11 });
    expect([q2.next, ...q2.state.queue]).toEqual(['boss']);
    expect(q2.summary).toBeUndefined();
  });

  it('普通成员互相 @ 与智能选出多人不触发', () => {
    const c = chat({ maxHops: 6, maxTurnsPerBot: 2 });
    const s = startRound(c, members, human('@前端'));
    const r = onReply(s, c, members, { botId: 'fe', text: '@Backend 你看看', seq: 2 });
    expect(r.state.waiting).toBeUndefined();
    const r2 = onReply(r.state, c, members, { botId: 'be', text: '好', seq: 3 });
    expect(r2.next).toBeNull();
    expect(r2.summary).toBeUndefined();
    const smart = startRound(c, members, human('出方案'), ['fe', 'be']);
    const m = onReply(smart, c, members, { botId: 'fe', text: 'A', seq: 2 });
    const m2 = onReply(m.state, c, members, { botId: 'be', text: 'B', seq: 3 });
    expect(m2.next).toBeNull();
    expect(m2.summary).toBeUndefined();
  });

  it('只记实际入队的：排除自己、归档、已在队列、本轮已委派的', () => {
    const c = chat({ maxHops: 6, maxTurnsPerBot: 2 });
    const s = startRound(c, members, human('@老板 @前端'));
    const r = onReply(s, c, members, {
      botId: 'boss',
      text: '@老板 @老员工 @前端 @Backend',
    });
    expect(r.state.waiting).toEqual(['be']);
    const d = onReply(startRound(c, members, human('x')), c, members, {
      botId: 'boss',
      text: '@前端 @Backend',
      delegated: ['fe'],
    });
    expect(d.state.waiting).toEqual(['be']);
    const r2 = onReply(r.state, c, members, { botId: 'fe', text: 'A', seq: 5 });
    expect(r2.summary).toBeUndefined();
    const r3 = onReply(r2.state, c, members, { botId: 'be', text: 'B', seq: 6 });
    expect(r3.summary?.reports).toEqual([{ botId: 'be', seq: 6 }]);
  });

  it('跳数或群主次数到上限时不发，写一条说明', () => {
    const hopsCap = chat({ maxHops: 2, maxTurnsPerBot: 2 });
    const h = dispatched(hopsCap);
    const h2 = onReply(h.state, hopsCap, members, { botId: 'fe', text: 'A', seq: 10 });
    const h3 = onReply(h2.state, hopsCap, members, { botId: 'be', text: 'B', seq: 11 });
    expect(h3.next).toBeNull();
    expect(h3.summary).toBeUndefined();
    expect(h3.notices).toHaveLength(1);
    expect(h3.notices[0]).toContain('老板');
    expect(h3.state.waiting).toBeUndefined();
    const turnsCap = chat({ maxHops: 6, maxTurnsPerBot: 1 });
    const t = dispatched(turnsCap);
    const t2 = onReply(t.state, turnsCap, members, { botId: 'fe', text: 'A', seq: 10 });
    const t3 = onReply(t2.state, turnsCap, members, { botId: 'be', text: 'B', seq: 11 });
    expect(t3.next).toBeNull();
    expect(t3.summary).toBeUndefined();
    expect(t3.notices).toHaveLength(1);
    expect(t3.notices[0]).toContain('老板');
  });

  it('没有 waiting 字段的旧状态照常推进', () => {
    const c = chat({ maxHops: 6, maxTurnsPerBot: 2 });
    const old = JSON.parse(
      '{"rootEntrySeq":1,"queue":["be"],"current":"fe","hops":1,"turnsByBot":{"fe":1},"noticed":[]}'
    ) as RouterState;
    const r = onReply(old, c, members, { botId: 'fe', text: 'A', seq: 3 });
    expect(r.next).toBe('be');
    expect(r.summary).toBeUndefined();
  });

  it('汇总提醒列出回复 seq，并提示用 group_history 查原文、不复述', () => {
    const note = buildSummaryNote(members, [{ botId: 'fe', seq: 10 }, { botId: 'be' }]);
    expect(note).toContain('前端');
    expect(note).toContain('seq 10');
    expect(note).toContain('Backend');
    expect(note).toContain('group_history');
    expect(note).toContain('不要复述');
  });
});

describe('onHumanMessage', () => {
  const busy = () => startRound(chat(), members, human('@前端 @Backend'));

  it('没有人在回复时等价于 startRound', () => {
    const idle = onReply(startRound(chat(), members, human('x')), chat(), members, {
      botId: 'boss',
      text: 'ok',
    }).state;
    const d = onHumanMessage(idle, chat(), members, human('@Backend', [], 5));
    expect(d).toEqual({
      action: 'start',
      state: startRound(chat(), members, human('@Backend', [], 5)),
    });
  });

  it('只 @ 当前回复人时 steer', () => {
    expect(onHumanMessage(busy(), chat(), members, human('@前端 等等'))).toEqual({
      action: 'steer',
    });
  });

  it('@ 了其他人、或没有 @ 时等当前说完后重开', () => {
    for (const text of ['@前端 @Backend', '@Backend', '换个话题']) {
      expect(onHumanMessage(busy(), chat(), members, human(text)).action).toBe(
        'restart-after-current'
      );
    }
  });
});

describe('mergePending', () => {
  it('以最后一条人类消息为准，@ 按时间顺序取并集', () => {
    const merged = mergePending([
      human('@前端', ['fe'], 1),
      { kind: 'system', seq: 2, id: 's', at: 0, text: '@Backend' },
      human('@Backend @前端', ['be', 'fe'], 3),
      human('补充一下', [], 4),
    ]);
    expect(merged).toMatchObject({ seq: 4, text: '补充一下', mentions: ['fe', 'be'] });
  });

  it('没有人类消息时返回 null', () => {
    expect(mergePending([])).toBeNull();
    expect(mergePending([{ kind: 'system', seq: 1, id: 's', at: 0, text: 'x' }])).toBeNull();
  });
});

describe('shouldRoute', () => {
  const bot = (conversationId: string): GroupEntry => ({
    kind: 'bot',
    seq: 1,
    id: 'b',
    at: 0,
    botId: 'fe',
    text: '@Backend',
    conversationId,
    turnId: 't',
  });

  it('人类消息触发路由', () => {
    expect(shouldRoute(human('hi'), chat())).toBe(true);
  });

  it('system 与 delegation 条目不触发路由', () => {
    expect(shouldRoute({ kind: 'system', seq: 1, id: 's', at: 0, text: '@前端' }, chat())).toBe(
      false
    );
    expect(
      shouldRoute(
        {
          kind: 'delegation',
          seq: 1,
          id: 'd',
          at: 0,
          delegationId: 'x',
          from: 'fe',
          to: 'be',
          state: 'completed',
        },
        chat()
      )
    ).toBe(false);
  });

  it('成员在本群会话里的回复参与路由，系统以其名义代写的（委派会话）不参与', () => {
    expect(shouldRoute(bot('c-fe'), chat())).toBe(true);
    expect(shouldRoute(bot('c-delegated'), chat())).toBe(false);
  });

  it('脏输入不崩', () => {
    expect(shouldRoute(null as never, chat())).toBe(false);
  });
});

describe('isSkipReply', () => {
  it('只认整条为 [skip]', () => {
    expect(isSkipReply(' [Skip] ')).toBe(true);
    expect(isSkipReply('skip')).toBe(false);
    expect(isSkipReply(undefined as never)).toBe(false);
  });
});
