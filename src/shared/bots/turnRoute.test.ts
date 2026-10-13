import { describe, expect, it } from 'vitest';
import type { BotChat } from '../types/bot';
import type { HumanEntry, RouterState } from './router';
import {
  clearTurns,
  endTurns,
  onTurnReply,
  planTurnsEnd,
  skipTurn,
  startTurns,
  TURNS_ALL_SKIPPED_NOTICE,
  TURNS_UNAVAILABLE_NOTICE,
  turnsEligible,
  turnsNote,
  turnsWrapUp,
} from './turnRoute';

const A = 'a';
const B = 'b';
const C = 'c';
type Chat = Pick<BotChat, 'members' | 'bossBotId' | 'routing'>;
const members = [
  { id: A, name: 'Alice' },
  { id: B, name: 'Bob' },
  { id: C, name: 'Carol' },
];
const chatOf = (patch: Partial<Chat> = {}, routing: Partial<Chat['routing']> = {}): Chat => ({
  members: [A, B, C],
  bossBotId: A,
  ...patch,
  routing: { mode: 'turns', maxHops: 4, maxTurnsPerBot: 2, ...routing },
});
const human = (text: string, mentions: string[] = [], seq = 1): HumanEntry => ({
  kind: 'human',
  seq,
  text,
  mentions,
  id: `h${seq}`,
  at: 0,
});
const started = (chat: Chat, entry: HumanEntry) => {
  const result = startTurns(chat, members, entry);
  if (!('state' in result)) throw new Error('expected a started round');
  return result.state;
};
/** 依次回复：text 为 [skip] / fail / 正文；正文按 seq 递增写入 */
const play = (state: RouterState, chat: Chat, replies: string[], seqFrom = 2) => {
  let seq = seqFrom;
  let current = state;
  const spoken: string[] = [];
  let last: ReturnType<typeof onTurnReply> | undefined;
  for (const text of replies) {
    const botId = current.current;
    if (!botId) throw new Error(`no current speaker for ${text}`);
    spoken.push(botId);
    const failed = text === 'fail';
    const valid = !failed && text !== '[skip]';
    last = onTurnReply(current, chat, members, {
      botId,
      failed,
      ...(valid ? { seq: seq++ } : {}),
    });
    current = last.state;
    if (last.end) break;
  }
  return { state: current, spoken, result: last! };
};

describe('startTurns', () => {
  it('不 @ 时全员参与：群主第一，其余按群成员顺序；第 1 轮计一次发言', () => {
    const state = started(chatOf({ members: [C, B, A] }), human('hi'));
    expect(state.current).toBe(A);
    expect(state.queue).toEqual([C, B]);
    expect(state.turns).toMatchObject({ round: 1, order: [A, C, B], spoke: 0, failed: 0 });
    expect(state.discussTurns).toBe(1);
    expect(state.discussReplies).toBe(0);
    expect(state.turnsByBot).toEqual({ [A]: 1 });
    expect(state).not.toHaveProperty('discuss');
  });

  it('只 @ 部分成员：只有他们参与（按基础顺序），并记为点名', () => {
    const state = started(chatOf(), human('@Carol @Bob 看看', [C, B]));
    expect([state.current, ...state.queue]).toEqual([B, C]);
    expect(state.turns?.named).toEqual([C, B]);
  });

  it('@所有人 等同全员，静音成员只有被点名才参与', () => {
    const chat = chatOf({}, { muted: [C] });
    const all = started(chat, human('@所有人 看看', [A, B, C]));
    expect([all.current, ...all.queue]).toEqual([A, B]);
    const named = started(chat, human('@所有人 @Carol 看看', [A, B, C]));
    expect([named.current, ...named.queue]).toEqual([A, B, C]);
    const plain = started(chat, human('看看'));
    expect([plain.current, ...plain.queue]).toEqual([A, B]);
  });

  it('被 @ 的成员都不能发言（如只 @ 了已归档成员）：给出提示，不交群主', () => {
    const archived = members.map((m) => (m.id === B ? { ...m, archivedAt: 1 } : m));
    expect(startTurns(chatOf(), archived, human('@Bob 在吗', [B]))).toEqual({
      notice: TURNS_UNAVAILABLE_NOTICE,
    });
  });
});

describe('onTurnReply', () => {
  it('一轮说完后按轮次轮换顺序开下一轮；有新内容的人才发言', () => {
    const chat = chatOf();
    const { state, spoken } = play(started(chat, human('hi')), chat, ['A1', '[skip]', 'C1']);
    expect(spoken).toEqual([A, B, C]);
    expect(state.turns?.round).toBe(2);
    // 第 2 轮轮换为 B、C、A；C 刚说完、之后没有新发言 → 自动 [skip]
    expect(state.current).toBe(B);
    expect(state.queue).toEqual([C, A]);
    expect(state.discussReplies).toBe(2);
    expect(state.turnsByBot).toEqual({ [A]: 1, [C]: 1, [B]: 1 });
    const next = onTurnReply(state, chat, members, { botId: B });
    // C 自上次发言后没有新内容，被跳过；A 还没看过 C1 → 轮到 A
    expect(next.end).toBeUndefined();
    expect(next.state).toMatchObject({ current: A, queue: [] });
    const last = onTurnReply(next.state, chat, members, { botId: A });
    expect(last.end).toBe('idle');
    expect(last.state.current).toBeNull();
  });

  it('[skip] 与失败不计入 turnsByBot', () => {
    const chat = chatOf();
    const { state } = play(started(chat, human('hi')), chat, ['[skip]', 'fail']);
    expect(state.turnsByBot).toEqual({ [A]: 0, [B]: 0, [C]: 1 });
  });

  it('第 1 轮全员 [skip]：结束，quiet；有人失败时不 quiet', () => {
    const chat = chatOf();
    const quiet = play(started(chat, human('hi')), chat, ['[skip]', '[skip]', '[skip]']);
    expect(quiet.result).toMatchObject({ end: 'idle', quiet: true });
    const failed = play(started(chat, human('hi')), chat, ['[skip]', 'fail', '[skip]']);
    expect(failed.result.end).toBe('idle');
    expect(failed.result.quiet).toBeUndefined();
  });

  it('第 2 轮起全员 [skip]：结束（idle），不 quiet', () => {
    const chat = chatOf();
    const { result, spoken } = play(started(chat, human('hi')), chat, [
      'A1',
      'B1',
      'C1',
      '[skip]',
      '[skip]',
      '[skip]',
    ]);
    // 第 2 轮 B、C、A：C 刚说完没有新内容，自动 [skip]
    expect(spoken).toEqual([A, B, C, B, A]);
    expect(result).toMatchObject({ end: 'idle' });
    expect(result.quiet).toBeUndefined();
    expect(result.state.discussReplies).toBe(3);
    expect(result.state.turns?.lastBy).toBe(C);
  });

  it('失败的成员本条消息后面的轮次不再排他', () => {
    const chat = chatOf();
    const { state, spoken } = play(started(chat, human('hi')), chat, ['A1', 'fail', 'C1']);
    expect(spoken).toEqual([A, B, C]);
    expect(state.turns?.out).toEqual([B]);
    // 第 2 轮 B、C、A：B 已退出，C 没有新内容，A 看到了 C1
    expect(state.current).toBe(A);
    expect(state.queue).toEqual([]);
  });

  it('有人委派：本轮已排队的人说完，不开下一轮', () => {
    const chat = chatOf();
    const s1 = onTurnReply(started(chat, human('hi')), chat, members, {
      botId: A,
      seq: 2,
      delegated: true,
    });
    expect(s1.state.current).toBe(B);
    expect(s1.state.turns?.last).toBe(true);
    const s2 = onTurnReply(s1.state, chat, members, { botId: B, seq: 3 });
    expect(s2.state.current).toBe(C);
    const s3 = onTurnReply(s2.state, chat, members, { botId: C, seq: 4 });
    expect(s3.end).toBe('stop');
  });

  it('有待处理的人类消息：当前发言者说完就停，不再排下一位', () => {
    const chat = chatOf();
    const result = onTurnReply(started(chat, human('hi')), chat, members, {
      botId: A,
      seq: 2,
      pendingHuman: true,
    });
    expect(result.end).toBe('stop');
    expect(result.state.current).toBeNull();
  });

  it('到安全上限（含 [skip] 与失败）：还有人要说时按 cap 结束', () => {
    const chat = chatOf({}, { discussMaxTurns: 5 });
    const { result, spoken } = play(started(chat, human('hi')), chat, [
      'A1',
      '[skip]',
      'C1',
      'B2',
      'fail',
      'A2',
    ]);
    expect(spoken).toEqual([A, B, C, B, C]);
    expect(result.end).toBe('cap');
    expect(result.state.discussTurns).toBe(5);
  });

  it('委派后到上限：不按 cap 收尾', () => {
    const chat = chatOf({}, { discussMaxTurns: 5 });
    const s = started(chat, human('hi'));
    const capped = { ...s, discussTurns: 5 };
    const result = onTurnReply(capped, chat, members, { botId: A, seq: 2, delegated: true });
    expect(result.end).toBe('stop');
  });

  it('轮到时已静音（未被点名）、已归档或被移出群的成员静默跳过', () => {
    const chat = chatOf();
    const state = started(chat, human('hi'));
    const muted = chatOf({}, { muted: [B] });
    const r1 = onTurnReply(state, muted, members, { botId: A, seq: 2 });
    expect(r1.state.current).toBe(C);
    const archived = members.map((m) => (m.id === B ? { ...m, archivedAt: 1 } : m));
    expect(onTurnReply(state, chat, archived, { botId: A, seq: 2 }).state.current).toBe(C);
    const removed = chatOf({ members: [A, C] });
    expect(onTurnReply(state, removed, members, { botId: A, seq: 2 }).state.current).toBe(C);
  });

  it('不是当前发言者的回复不改状态', () => {
    const chat = chatOf();
    const state = started(chat, human('hi'));
    expect(onTurnReply(state, chat, members, { botId: B, seq: 2 })).toEqual({ state });
  });
});

describe('turnsEligible / skipTurn（投递前复核）', () => {
  it('turnsEligible：静音未点名、归档、移出群不能发言；静音但被点名可以', () => {
    const chat = chatOf();
    const state = started(chat, human('hi'));
    expect(turnsEligible(state, chat, members, B)).toBe(true);
    expect(turnsEligible(state, chatOf({}, { muted: [B] }), members, B)).toBe(false);
    expect(turnsEligible(state, chatOf({ members: [A, C] }), members, B)).toBe(false);
    const archived = members.map((m) => (m.id === B ? { ...m, archivedAt: 1 } : m));
    expect(turnsEligible(state, chat, archived, B)).toBe(false);
    const named = started(chat, human('@Bob @Carol 看看', [B, C]));
    expect(turnsEligible(named, chatOf({}, { muted: [B] }), members, B)).toBe(true);
  });

  it('skipTurn：当作没轮到当前的人，不计讨论发言与 [skip]、不记看到的位置，接着排下一位', () => {
    const chat = chatOf();
    const s1 = onTurnReply(started(chat, human('hi')), chat, members, { botId: A, seq: 2 });
    expect(s1.state).toMatchObject({ current: B, discussTurns: 2 });
    const skipped = skipTurn(s1.state, chatOf({}, { muted: [B] }), members);
    expect(skipped.end).toBeUndefined();
    expect(skipped.state).toMatchObject({ current: C, queue: [], discussTurns: 2 });
    expect(skipped.state.turnsByBot).toEqual({ [A]: 1, [B]: 0, [C]: 1 });
    expect(skipped.state.discussSeen).not.toHaveProperty(B);
    expect(skipped.state.turns).toMatchObject({ round: 1, spoke: 1, failed: 0 });
    expect(skipped.state.turns?.out).toBeUndefined();
  });

  it('skipTurn：本轮最后一位被跳过且本轮没人发言时结束；第 1 轮无有效发言为 quiet', () => {
    const chat = chatOf({ members: [A, B] });
    const s1 = onTurnReply(started(chat, human('hi')), chat, members, { botId: A });
    expect(s1.state.current).toBe(B);
    const result = skipTurn(s1.state, chatOf({ members: [A, B] }, { muted: [B] }), members);
    expect(result).toMatchObject({ end: 'idle', quiet: true });
    expect(result.state.current).toBeNull();
  });

  it('#60 撤回安全上限最后一位的占用，下一位可以投递；未投递者恢复后仍可参与', () => {
    const chat = chatOf({}, { discussMaxTurns: 5 });
    const s = play(started(chat, human('hi')), chat, ['A1', 'B1', 'C1', 'B2']).state;
    expect(s).toMatchObject({ current: C, discussTurns: 5 });
    const next = skipTurn(s, chatOf({}, { discussMaxTurns: 5, muted: [C] }), members);
    expect(next.end).toBeUndefined();
    expect(next.state).toMatchObject({ current: A, discussTurns: 5 });
    expect(next.state.discussSeen?.[C]).toBe(s.discussSeen?.[C]);
    expect(next.state.turns?.out).toBeUndefined();
    expect(turnsEligible(next.state, chat, members, C)).toBe(true);
    expect(onTurnReply(next.state, chat, members, { botId: A, seq: 6 }).end).toBe('cap');
  });

  it('skipTurn：没有当前发言者或不在成员自选中时不改状态', () => {
    const chat = chatOf();
    const state = { ...started(chat, human('hi')), current: null };
    expect(skipTurn(state, chat, members)).toEqual({ state });
  });
});

describe('planTurnsEnd', () => {
  const chat = chatOf();
  const ended = (replies: string[]) => play(started(chat, human('hi')), chat, replies).result;

  it('有效发言为 0：只提示「成员都选择不回复」（有失败时不提示），不收尾', () => {
    const quiet = ended(['[skip]', '[skip]', '[skip]']);
    expect(planTurnsEnd(quiet.state, chat, members, 'idle', quiet.quiet)).toEqual({
      kind: 'end',
      notice: TURNS_ALL_SKIPPED_NOTICE,
    });
    expect(planTurnsEnd(quiet.state, chat, members, 'idle', false)).toEqual({ kind: 'end' });
  });

  it('有效发言不到 2 条：静默结束', () => {
    const one = ended(['A1', '[skip]', '[skip]']);
    expect(one.end).toBe('idle');
    expect(planTurnsEnd(one.state, chat, members, 'idle')).toEqual({ kind: 'end' });
  });

  it('有效发言 ≥2 且群主可用：交群主收尾（idle），群主是最后发言者时提示勿重复', () => {
    const two = ended(['A1', 'B1', '[skip]', '[skip]', '[skip]', '[skip]']);
    const plan = planTurnsEnd(two.state, chat, members, 'idle');
    expect(plan).toMatchObject({ kind: 'wrap-up', botId: A });
    if (plan.kind !== 'wrap-up') throw new Error('wrap-up');
    expect(plan.notice).toBe('没有成员再接话，交给群主「Alice」收尾。');
    expect(plan.note).toContain('从 seq 1 开始');
    expect(plan.note).not.toContain('已经写过的不要重复');
    const bossLastTwo = { ...two.state, turns: { ...two.state.turns!, lastBy: A } };
    const last = planTurnsEnd(bossLastTwo, chat, members, 'idle');
    expect(last.kind === 'wrap-up' && last.note).toContain('已经写过的不要重复');
  });

  it('到安全上限：按 cap 收尾；没有可用群主时只提示', () => {
    const capChat = chatOf({}, { discussMaxTurns: 5 });
    const capped = play(started(capChat, human('hi')), capChat, [
      'A1',
      'B1',
      'C1',
      'B2',
      'C2',
    ]).result;
    expect(capped.end).toBe('cap');
    const plan = planTurnsEnd(capped.state, capChat, members, 'cap');
    expect(plan).toMatchObject({ kind: 'wrap-up', botId: A });
    expect(plan.kind === 'wrap-up' && plan.notice).toContain('安全上限（5 次成员发言）');
    const noBoss = planTurnsEnd(capped.state, { ...capChat, bossBotId: null }, members, 'cap');
    expect(noBoss.kind).toBe('end');
  });
});

describe('状态转换', () => {
  const chat = chatOf();

  it('turnsWrapUp：群主成为当前发言者，去掉成员自选与讨论计数', () => {
    const { result } = play(started(chat, human('hi')), chat, ['A1', 'B1', 'C1', '[skip]']);
    const wrap = turnsWrapUp(result.state, A);
    expect(wrap).toMatchObject({ current: A, queue: [], wrapUp: true });
    for (const key of ['turns', 'discussTurns', 'discussReplies', 'discussLastSeq', 'discussSeen'])
      expect(wrap).not.toHaveProperty(key);
  });

  it('clearTurns（开关中途关闭）：丢掉剩下的人与轮次，只记当前发言者这一次', () => {
    const { state } = play(started(chat, human('hi')), chat, ['A1', 'B1', 'C1']);
    const cleared = clearTurns(state);
    expect(cleared).toMatchObject({ current: state.current, queue: [] });
    expect(cleared.turnsByBot).toEqual({ [state.current!]: 1 });
    expect(cleared).not.toHaveProperty('turns');
    expect(cleared).not.toHaveProperty('discussTurns');
  });

  it('endTurns：结束后无人发言、无排队、无成员自选状态', () => {
    const { result } = play(started(chat, human('hi')), chat, ['[skip]', '[skip]', '[skip]']);
    const done = endTurns(result.state);
    expect(done).toMatchObject({ current: null, queue: [] });
    expect(done).not.toHaveProperty('turns');
  });
});

describe('turnsNote', () => {
  it('写明第几轮、[skip]、@ 只是提醒；第 1 轮被点名时请尽量回复', () => {
    const first = turnsNote(1, true);
    expect(first).toContain('第 1 轮');
    expect(first).toContain('[skip]');
    expect(first).toContain('@ 别人只是提醒');
    expect(first).toContain('人类点名了你');
    expect(turnsNote(1, false)).not.toContain('人类点名了你');
    const later = turnsNote(3, true);
    expect(later).toContain('第 3 轮');
    expect(later).not.toContain('人类点名了你');
    expect(later).toContain('前几轮');
  });
});
