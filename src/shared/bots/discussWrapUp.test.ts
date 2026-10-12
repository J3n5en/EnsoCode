import { describe, expect, it } from 'vitest';
import {
  buildWrapUpNote,
  DISCUSS_WRAP_UP_MIN_REPLIES,
  discussCap,
  hasNewContent,
  planWrapUp,
  wrapUpOwner,
} from './discussWrapUp';

const boss = { id: 'boss', name: '老板' };
const base = { replies: 2, boss, cap: 50, bossWasLast: false, rootSeq: 7 } as const;

describe('discussCap', () => {
  it('缺省 50，非法值按缺省，越界夹到 5–200', () => {
    expect(discussCap({})).toBe(50);
    expect(discussCap(undefined)).toBe(50);
    expect(discussCap({ discussMaxTurns: 12 })).toBe(12);
    expect(discussCap({ discussMaxTurns: 1 })).toBe(5);
    expect(discussCap({ discussMaxTurns: 999 })).toBe(200);
    expect(discussCap({ discussMaxTurns: 7.5 })).toBe(50);
    expect(discussCap({ discussMaxTurns: '9' as never })).toBe(50);
  });
});

describe('hasNewContent', () => {
  it('没发过言的成员总有新内容；发过言的只有出现更新的有效发言才有', () => {
    expect(hasNewContent(undefined, 3)).toBe(true);
    expect(hasNewContent(3, 3)).toBe(false);
    expect(hasNewContent(3, 2)).toBe(false);
    expect(hasNewContent(3, 4)).toBe(true);
  });
});

describe('wrapUpOwner', () => {
  const members = [
    { id: 'boss', name: '老板' },
    { id: 'fe', name: '前端' },
  ];
  it('群主在群、未归档时可收尾；归档、不在群、没有群主都不可用', () => {
    expect(wrapUpOwner({ members: ['boss', 'fe'], bossBotId: 'boss' }, members)).toEqual(boss);
    expect(
      wrapUpOwner({ members: ['boss', 'fe'], bossBotId: 'boss' }, [
        { ...members[0]!, archivedAt: 1 },
        members[1]!,
      ])
    ).toBeNull();
    expect(wrapUpOwner({ members: ['fe'], bossBotId: 'boss' }, members)).toBeNull();
    expect(wrapUpOwner({ members: ['boss', 'fe'], bossBotId: null }, members)).toBeNull();
    expect(wrapUpOwner({ members: ['boss', 'fe'], bossBotId: 'boss' }, [members[1]!])).toBeNull();
  });
});

describe('planWrapUp', () => {
  it(`有效发言 ≥${DISCUSS_WRAP_UP_MIN_REPLIES} 且群主可用时收尾，按原因给提示（有结论时不提示）`, () => {
    expect(planWrapUp({ ...base, reason: 'concluded' })).toEqual({
      kind: 'wrap-up',
      botId: 'boss',
      note: expect.any(String),
    });
    expect(planWrapUp({ ...base, reason: 'cap', cap: 5 })).toMatchObject({
      kind: 'wrap-up',
      botId: 'boss',
      notice: '本次讨论已达安全上限（5 次成员发言），交给群主「老板」收尾。',
    });
    expect(planWrapUp({ ...base, reason: 'idle' })).toMatchObject({
      kind: 'wrap-up',
      notice: '没有成员再接话，交给群主「老板」收尾。',
    });
    expect(planWrapUp({ ...base, reason: 'judge-failed', failure: '判断超时' })).toMatchObject({
      kind: 'wrap-up',
      notice: '讨论判断不可用（判断超时），交给群主「老板」收尾。',
    });
  });

  it('有效发言不足 2 条：不收尾，沿用原来的结束提示', () => {
    const few = { ...base, replies: 1 };
    expect(planWrapUp({ ...few, reason: 'concluded' })).toEqual({ kind: 'end' });
    expect(planWrapUp({ ...few, reason: 'cap', cap: 5 })).toEqual({
      kind: 'end',
      notice: '本次讨论已达安全上限（5 次成员发言），讨论结束。',
    });
    expect(planWrapUp({ ...few, reason: 'idle' })).toEqual({
      kind: 'end',
      notice: '没有其他可接话的成员，讨论结束。',
    });
    expect(planWrapUp({ ...few, reason: 'judge-failed', failure: '判断超时' })).toEqual({
      kind: 'end',
      notice: '讨论判断不可用（判断超时），讨论结束',
    });
  });

  it('没有可用群主（未设、已归档、不在群）：不收尾，提示交给用户', () => {
    const none = { ...base, boss: null };
    expect(planWrapUp({ ...none, reason: 'concluded' })).toEqual({
      kind: 'end',
      notice: '讨论已有结论，但群里没有可用的群主，未收尾。',
    });
    expect(planWrapUp({ ...none, reason: 'cap', cap: 5 })).toEqual({
      kind: 'end',
      notice:
        '本次讨论已达安全上限（5 次成员发言），未达成结论。群里没有可用的群主，请你决定下一步。',
    });
    expect(planWrapUp({ ...none, reason: 'idle' })).toEqual({
      kind: 'end',
      notice: '没有成员再接话，讨论结束。群里没有可用的群主，未收尾。',
    });
    expect(planWrapUp({ ...none, reason: 'judge-failed', failure: 'x' })).toEqual({
      kind: 'end',
      notice: '讨论判断不可用（x），讨论结束。群里没有可用的群主，未收尾。',
    });
  });

  it('收尾附注与 buildWrapUpNote 一致', () => {
    const plan = planWrapUp({ ...base, reason: 'cap', cap: 9, bossWasLast: true });
    expect(plan.kind === 'wrap-up' && plan.note).toBe(
      buildWrapUpNote({ reason: 'cap', cap: 9, rootSeq: 7, bossWasLast: true })
    );
  });
});

describe('buildWrapUpNote', () => {
  const note = (patch: Partial<Parameters<typeof buildWrapUpNote>[0]> = {}) =>
    buildWrapUpNote({ reason: 'concluded', cap: 50, rootSeq: 7, bossWasLast: false, ...patch });

  it('三段结构、需要用户决定的事项单独列、@ 只是提醒、可委派、不要复述、不要 [skip]', () => {
    const text = note();
    expect(text).toContain('判断认为讨论已有结论或明确的下一步');
    expect(text).toContain('结论、分歧、下一步');
    expect(text).toContain('「需要你决定」');
    expect(text).toContain('可以委派');
    expect(text).toContain('@ 只是提醒，不会让对方接着发言');
    expect(text).toContain('group_history');
    expect(text).toContain('seq 7');
    expect(text).toContain('不要回 [skip]');
    expect(text).not.toContain('不要委派');
    expect(text).not.toContain('不要重复');
  });

  it('到上限：要求开头写明未达成结论，列出卡住的点交给用户', () => {
    const text = note({ reason: 'cap', cap: 9 });
    expect(text).toContain('安全上限（9 次成员发言）');
    expect(text).toContain('收尾开头写明「未达成结论」');
    expect(text).toContain('卡住的点');
  });

  it('没人接话 / 判断失败：没有结论时写明未达成结论；判断失败带原因', () => {
    expect(note({ reason: 'idle' })).toContain('如果还没有结论，开头写明「未达成结论」');
    const failed = note({ reason: 'judge-failed', failure: '判断超时' });
    expect(failed).toContain('讨论判断不可用（判断超时）');
    expect(failed).toContain('如果还没有结论，开头写明「未达成结论」');
  });

  it('群主是最后发言人：提示不要重复已写过的内容', () => {
    expect(note({ bossWasLast: true })).toContain('已经写过的不要重复');
  });
});
