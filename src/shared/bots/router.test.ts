import { describe, expect, it } from 'vitest';
import type { BotChat, GroupEntry } from '../types/bot';
import {
  buildSummaryNote,
  clearDiscussion,
  clearWrapUp,
  discussPick,
  discussStep,
  isBlankReply,
  isSkipReply,
  mergePending,
  needsSmartRoute,
  onHumanMessage,
  onReply,
  type RouterState,
  shouldRoute,
  startDiscussion,
  startRound,
  startWrapUp,
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

  it('@ 其他成员时立即投递，不改当前回复人和原队列', () => {
    for (const text of ['@前端 @Backend', '@Backend']) {
      const state = busy();
      const before = structuredClone(state);
      expect(onHumanMessage(state, chat(), members, human(text))).toEqual({
        action: 'parallel',
        targets: text.includes('@前端') ? ['fe', 'be'] : ['be'],
      });
      expect(state).toEqual(before);
    }
  });

  it('立即投递目标保留当前成员，去重并排除归档和群外成员', () => {
    expect(
      onHumanMessage(busy(), chat(), members, human('x', ['fe', 'be', 'be', 'old', 'ghost']))
    ).toEqual({
      action: 'parallel',
      targets: ['fe', 'be'],
    });
  });

  it('没有 @ 时立即旁路选人，不改当前回复人和队列', () => {
    const state = busy();
    const before = structuredClone(state);
    expect(onHumanMessage(state, chat(), members, human('换个话题')).action).toBe('route-parallel');
    expect(state).toEqual(before);
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

  it('progress 条目即使带 @ 也不触发路由', () => {
    expect(
      shouldRoute(
        {
          kind: 'progress',
          seq: 1,
          id: 'p',
          at: 0,
          botId: 'fe',
          taskId: 't',
          taskSeq: 1,
          delegationId: 'x',
          phase: 'blocked',
          text: '#1 卡住了，缺：密码 @Backend',
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

describe('isBlankReply', () => {
  it('空白与不可见格式字符视为空白', () => {
    for (const text of ['', ' \n\t', '\u200b', '\u200c\u200d', '\u2060', '\ufeff', ' \u200b\n'])
      expect(isBlankReply(text)).toBe(true);
  });

  it('含可见字符即非空白（不误伤 ZWJ emoji 与夹带零宽的文字）', () => {
    for (const text of ['👨\u200d👩\u200d👧', '好\u200b的', 'a', '[skip]'])
      expect(isBlankReply(text)).toBe(false);
  });
});

describe('讨论模式', () => {
  const discussing = (patch: Partial<RouterState> = {}): RouterState => ({
    rootEntrySeq: 1,
    queue: [],
    current: null,
    hops: 0,
    turnsByBot: { boss: 1, fe: 1 },
    noticed: [],
    discuss: true,
    discussTurns: 2,
    discussReplies: 2,
    discussLastSeq: 3,
    discussSeen: { boss: 2, fe: 3 },
    ...patch,
  });
  const quiet = { lastBotId: 'fe', mentioned: false, delegated: false, pendingHuman: false };

  it('discuss 标记跨 onReply 保留', () => {
    const state = discussing({ current: 'fe', queue: ['boss'] });
    const result = onReply(state, chat(), members, { botId: 'fe', text: '我觉得可以' });
    expect(result.state).toMatchObject({ discuss: true, current: 'boss' });
  });

  it('startDiscussion 计入首位发言人；之后每开始一个讨论回合计一次（含首轮排队的人）', () => {
    const c = chat({}, 'smart');
    const started = startDiscussion(startRound(c, members, human('@所有人 说说')));
    expect(started).toMatchObject({
      discuss: true,
      current: 'boss',
      queue: ['fe', 'be'],
      discussTurns: 1,
      discussReplies: 0,
    });
    const r1 = onReply(started, c, members, { botId: 'boss', text: 'a', seq: 2 });
    expect(r1.state).toMatchObject({ current: 'fe', discussTurns: 2, hops: 0 });
    expect(startDiscussion({ ...started, current: null, queue: [] }).discussTurns).toBe(0);
  });

  it('首轮名单超过安全上限时照常跑完，上限只拦后面新加的回合', () => {
    const c = chat({ discussMaxTurns: 5 }, 'smart');
    let state = discussing({ current: 'fe', queue: ['be', 'boss', 'be', 'boss'], discussTurns: 4 });
    for (const botId of ['fe', 'be', 'boss', 'be'])
      state = onReply(state, c, members, { botId, text: 'x' }).state;
    expect(state).toMatchObject({ current: 'boss', queue: [], discussTurns: 8 });
    const last = onReply(state, c, members, { botId: 'boss', text: '@前端 你再说说' });
    expect(last.state).toMatchObject({ current: null, queue: [] });
    expect(last.notices).toEqual([]);
  });

  it('onReply 标出回复里是否 @ 了别人（含被安全上限拦下的）', () => {
    const state = discussing({ current: 'fe', discussTurns: 50 });
    const result = onReply(state, chat(), members, { botId: 'fe', text: '@Backend 你看呢' });
    expect(result.mentioned).toBe(true);
    expect(result.next).toBeNull();
    expect(result.notices).toEqual([]);
    expect(
      onReply(discussing({ current: 'fe' }), chat(), members, { botId: 'fe', text: 'ok' })
    ).toMatchObject({ mentioned: false });
  });

  it('讨论中 @ 接力不受 maxHops / maxTurnsPerBot 限制，也不计 hop、不发上限提示', () => {
    const c = chat({ maxHops: 1, maxTurnsPerBot: 1 });
    const state = discussing({ current: 'fe', hops: 1, turnsByBot: { boss: 3, be: 3, fe: 3 } });
    const result = onReply(state, c, members, { botId: 'fe', text: '@Backend @老板 你们看呢' });
    expect(result.state).toMatchObject({ current: 'be', queue: ['boss'], hops: 1 });
    expect(result.state.discussTurns).toBe(3);
    expect(result.notices).toEqual([]);
  });

  it('讨论中 @ 接力到安全上限静默拦下（已用 + 排队），discussStep 报 cap 且优先于 mentioned', () => {
    const c = chat({ discussMaxTurns: 5 });
    const state = discussing({ current: 'fe', discussTurns: 4 });
    const result = onReply(state, c, members, { botId: 'fe', text: '@Backend @老板 你们看呢' });
    expect(result.state).toMatchObject({ current: 'be', queue: [], discussTurns: 5 });
    expect(result.notices).toEqual([]);
    const capped = onReply(result.state, c, members, { botId: 'be', text: '@老板 你来定' });
    expect(capped.mentioned).toBe(true);
    expect(capped.notices).toEqual([]);
    expect(
      discussStep(capped.state, c, members, { ...quiet, lastBotId: 'be', mentioned: true })
    ).toEqual({ kind: 'end', reason: 'cap' });
  });

  it('讨论中群主 @ 派人不记 waiting、不追加汇总跳', () => {
    const c = chat({ maxHops: 6 });
    const r1 = onReply(discussing({ current: 'boss' }), c, members, {
      botId: 'boss',
      text: '@前端 @Backend 各给一个方案',
      seq: 4,
    });
    expect(r1.state.waiting).toBeUndefined();
    const r2 = onReply(r1.state, c, members, { botId: 'fe', text: 'A', seq: 5 });
    const r3 = onReply(r2.state, c, members, { botId: 'be', text: 'B', seq: 6 });
    expect(r3.summary).toBeUndefined();
    expect(r3.state).toMatchObject({ current: null, queue: [] });
  });

  it('不在讨论、还有人排队、回复里有 @、本回合委派、有待处理人类消息时不判断', () => {
    expect(discussStep(discussing({ discuss: undefined }), chat(), members, quiet)).toEqual({
      kind: 'none',
    });
    expect(discussStep(discussing({ queue: ['be'] }), chat(), members, quiet)).toEqual({
      kind: 'none',
    });
    expect(discussStep(discussing({ current: 'be' }), chat(), members, quiet)).toEqual({
      kind: 'none',
    });
    for (const flag of ['mentioned', 'delegated', 'pendingHuman'] as const)
      expect(discussStep(discussing(), chat(), members, { ...quiet, [flag]: true })).toEqual({
        kind: 'none',
      });
  });

  it('可选名单排除刚说完的人、静音、归档，以及上次发言后没有新内容的成员；不看 maxTurnsPerBot', () => {
    // boss 发言次数已超 maxTurnsPerBot，但看到 seq 2 之后又有了 seq 3 的新发言
    expect(
      discussStep(discussing({ turnsByBot: { boss: 9, fe: 1 } }), chat(), members, quiet)
    ).toEqual({ kind: 'judge', candidates: ['boss', 'be'] });
    expect(
      discussStep(discussing({ discussSeen: { boss: 3, fe: 3 } }), chat(), members, quiet)
    ).toEqual({ kind: 'judge', candidates: ['be'] });
    expect(
      discussStep(
        discussing({ discussSeen: { boss: 3, fe: 3 } }),
        chat({ muted: ['be'] }),
        members,
        quiet
      )
    ).toEqual({ kind: 'end', reason: 'idle' });
  });

  it('没有可接话的成员时 reason=idle', () => {
    const solo = [{ id: 'fe', name: '前端' }];
    expect(discussStep(discussing(), chat(), solo, quiet)).toEqual({ kind: 'end', reason: 'idle' });
  });

  it('讨论不看 maxHops：hops 超过 maxHops 仍继续判断；到安全上限才结束（reason=cap）', () => {
    expect(discussStep(discussing({ hops: 9 }), chat({ maxHops: 1 }), members, quiet)).toEqual({
      kind: 'judge',
      candidates: ['boss', 'be'],
    });
    expect(discussStep(discussing({ discussTurns: 49 }), chat(), members, quiet)).toMatchObject({
      kind: 'judge',
    });
    expect(discussStep(discussing({ discussTurns: 50 }), chat(), members, quiet)).toEqual({
      kind: 'end',
      reason: 'cap',
    });
    expect(
      discussStep(discussing({ discussTurns: 5 }), chat({ discussMaxTurns: 5 }), members, quiet)
    ).toEqual({ kind: 'end', reason: 'cap' });
  });

  it('discussPick 计讨论次数、不计 hop；到安全上限或不合法就拒绝', () => {
    const picked = discussPick(discussing(), chat(), members, 'be', 'fe');
    expect(picked).toMatchObject({
      current: 'be',
      hops: 0,
      discussTurns: 3,
      turnsByBot: { boss: 1, fe: 1, be: 1 },
      discuss: true,
    });
    expect(discussPick(discussing(), chat(), members, 'fe', 'fe')).toBeNull();
    expect(discussPick(discussing(), chat(), members, 'old', 'fe')).toBeNull();
    expect(discussPick(discussing({ discussTurns: 50 }), chat(), members, 'be', 'fe')).toBeNull();
    expect(
      discussPick(discussing({ discussSeen: { boss: 3, be: 3 } }), chat(), members, 'be', 'fe')
    ).toBeNull();
    // 不再看 maxHops / maxTurnsPerBot
    expect(
      discussPick(discussing({ hops: 9, turnsByBot: { be: 9 } }), chat(), members, 'be', 'fe')
    ).toMatchObject({ current: 'be' });
  });

  it('[skip] 与失败计入安全上限，不计入有效发言；有效发言记 seq 与各人看到的位置', () => {
    const c = chat();
    const skipped = onReply(discussing({ current: 'be', discussTurns: 3 }), c, members, {
      botId: 'be',
      text: '[skip]',
    });
    expect(skipped.state).toMatchObject({
      discussTurns: 3,
      discussReplies: 2,
      discussLastSeq: 3,
      discussSeen: { boss: 2, fe: 3, be: 3 },
    });
    const failed = onReply(discussing({ current: 'be', discussTurns: 3 }), c, members, {
      botId: 'be',
      text: '',
    });
    expect(failed.state).toMatchObject({ discussTurns: 3, discussReplies: 2 });
    const spoke = onReply(discussing({ current: 'be', discussTurns: 3 }), c, members, {
      botId: 'be',
      text: '我补充一点',
      seq: 9,
    });
    expect(spoke.state).toMatchObject({
      discussTurns: 3,
      discussReplies: 3,
      discussLastSeq: 9,
      discussSeen: { boss: 2, fe: 3, be: 9 },
    });
    // 刚 [skip] 的人在没有新发言之前不会再被选；有了新发言才回到名单
    expect(discussStep(skipped.state, c, members, { ...quiet, lastBotId: 'be' })).toEqual({
      kind: 'judge',
      candidates: ['boss'],
    });
  });

  it('一直 [skip]：每人只会被问到没有新内容为止，然后 reason=idle', () => {
    let state = discussing({ discussSeen: { fe: 3 } });
    let last = 'fe';
    let judged = 0;
    for (let i = 0; i < 10; i++) {
      const step = discussStep(state, chat(), members, { ...quiet, lastBotId: last });
      if (step.kind !== 'judge') {
        expect(step).toEqual({ kind: 'end', reason: 'idle' });
        break;
      }
      judged++;
      const next = step.candidates[0]!;
      state = discussPick(state, chat(), members, next, last)!;
      state = onReply(state, chat(), members, { botId: next, text: '[skip]' }).state;
      last = next;
    }
    expect(judged).toBe(2);
    expect(state.discussTurns).toBe(4);
    expect(state.hops).toBe(0);
  });

  it('讨论中有人在说话时，人类发来没 @ 的消息：等他说完再按新消息重开', () => {
    expect(
      onHumanMessage(discussing({ current: 'fe' }), chat(), members, human('换个话题'))
    ).toEqual({ action: 'restart-after-current' });
    expect(
      onHumanMessage(discussing({ current: 'fe' }), chat(), members, human('@前端 停'))
    ).toEqual({ action: 'steer' });
    expect(
      onHumanMessage(discussing({ current: 'fe' }), chat(), members, human('@Backend 你呢'))
    ).toEqual({ action: 'parallel', targets: ['be'] });
    expect(
      onHumanMessage(
        { ...discussing({ current: 'fe' }), discuss: undefined },
        chat(),
        members,
        human('换个话题')
      )
    ).toEqual({ action: 'route-parallel' });
  });

  describe('群主收尾', () => {
    const wrapping = (): RouterState => startWrapUp(discussing({ waiting: ['fe'] }), 'boss');

    it('startWrapUp：去掉讨论标记与计数、清掉派单名单，当前回复人为群主', () => {
      const state = wrapping();
      expect(state).toMatchObject({ wrapUp: true, current: 'boss', queue: [] });
      for (const key of [
        'discuss',
        'discussTurns',
        'discussReplies',
        'discussLastSeq',
        'discussSeen',
        'waiting',
        'reports',
      ])
        expect(state).not.toHaveProperty(key);
    });

    it('wrapUp 下 onReply 不解析 @、不计次数、不入队，说完即结束并去掉 wrapUp', () => {
      const state = wrapping();
      const result = onReply(state, chat({ maxHops: 9 }), members, {
        botId: 'boss',
        text: '结论：用 A。@前端 @Backend 请落实',
        seq: 9,
      });
      expect(result).toMatchObject({ next: null, mentioned: false, notices: [], skipped: false });
      expect(result.state).toMatchObject({ current: null, queue: [], hops: state.hops });
      expect(result.state.turnsByBot).toEqual(state.turnsByBot);
      expect(result.state).not.toHaveProperty('wrapUp');
      expect(result.state).not.toHaveProperty('waiting');
      expect(onReply(state, chat(), members, { botId: 'boss', text: '[skip]' })).toMatchObject({
        skipped: true,
        next: null,
      });
    });

    it('wrapUp 下没 @ 的人类消息 → restart-after-current，只 @ 群主 → steer，@ 别人 → 并行', () => {
      expect(onHumanMessage(wrapping(), chat(), members, human('还有个问题'))).toEqual({
        action: 'restart-after-current',
      });
      expect(onHumanMessage(wrapping(), chat(), members, human('@老板 补一句'))).toEqual({
        action: 'steer',
      });
      expect(onHumanMessage(wrapping(), chat(), members, human('@前端 你先做'))).toEqual({
        action: 'parallel',
        targets: ['fe'],
      });
    });

    it('clearDiscussion：去掉讨论标记与计数，丢掉排队候选，发言次数清零（只记当前发言者这一次）', () => {
      const cleared = clearDiscussion(
        discussing({ current: 'be', queue: ['boss'], turnsByBot: { boss: 4, fe: 3, be: 2 } })
      );
      expect(cleared).toMatchObject({ current: 'be', queue: [], turnsByBot: { be: 1 } });
      for (const key of [
        'discuss',
        'discussTurns',
        'discussReplies',
        'discussLastSeq',
        'discussSeen',
      ])
        expect(cleared).not.toHaveProperty(key);
      expect(clearDiscussion(discussing()).turnsByBot).toEqual({});
      // 之后的普通接力按全新额度：maxTurnsPerBot 不受讨论里的发言次数影响
      const relay = onReply(clearDiscussion(discussing({ current: 'be' })), chat(), members, {
        botId: 'be',
        text: '@老板 你来',
      });
      expect(relay.state).toMatchObject({ current: 'boss', hops: 1 });
      expect(relay.notices).toEqual([]);
    });

    it('clearWrapUp：收尾中途关开关转普通接力，去掉 wrapUp，讨论发言次数清零（只记群主这一次）', () => {
      const state = startWrapUp(
        discussing({ turnsByBot: { boss: 1, fe: 1, be: 1 }, current: null }),
        'boss'
      );
      expect(state.turnsByBot).toEqual({ boss: 2, fe: 1, be: 1 });
      const snapshot = JSON.parse(JSON.stringify(state)) as RouterState;
      const cleared = clearWrapUp(state);
      expect(state).toEqual(snapshot);
      expect(cleared).toMatchObject({ current: 'boss', queue: [], turnsByBot: { boss: 1 } });
      expect(cleared).not.toHaveProperty('wrapUp');
      expect(clearWrapUp({ ...state, current: null }).turnsByBot).toEqual({});
      // 群主的回复按 main 规则接力，讨论里已发过言的成员按全新额度
      const relay = onReply(cleared, chat({ maxTurnsPerBot: 1 }), members, {
        botId: 'boss',
        text: '@前端 请落实',
      });
      expect(relay.state).toMatchObject({ current: 'fe' });
      expect(relay.notices).toEqual([]);
    });

    it('新增字段的状态可 JSON 往返且输入状态不被修改', () => {
      for (const state of [discussing({ current: 'fe' }), wrapping()]) {
        const snapshot = JSON.parse(JSON.stringify(state)) as RouterState;
        expect(snapshot).toEqual(state);
        onReply(state, chat(), members, { botId: state.current!, text: '@Backend ok', seq: 8 });
        expect(state).toEqual(snapshot);
      }
    });
  });
});
