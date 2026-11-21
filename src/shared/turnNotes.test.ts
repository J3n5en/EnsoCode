import { describe, expect, it } from 'vitest';
import { prependTurnNote, splitTurnNotes } from './turnNotes';

const U = '<unattended>\nUnattended mode is ON: x\n</unattended>';
const P = '<plan-mode>\nPlan mode is ON\n</plan-mode>';

describe('turnNotes', () => {
  it('拆出任意顺序的提示', () => {
    expect(splitTurnNotes(`${P}\n\n${U}\n\n做事`)).toEqual({
      plan: 'on',
      unattended: 'on',
      rest: '做事',
    });
    expect(splitTurnNotes(`${U}\n\n做事`)).toEqual({ unattended: 'on', rest: '做事' });
    expect(splitTurnNotes('做事')).toEqual({ rest: '做事' });
  });

  it('提示放在开头的 /skill: 之后', () => {
    expect(prependTurnNote(U, '做事')).toBe(`${U}\n\n做事`);
    expect(prependTurnNote(U, '/skill:a /skill:b 做事')).toBe(`/skill:a /skill:b ${U}\n\n做事`);
    expect(prependTurnNote(U, '/skill:a')).toBe(`/skill:a ${U}`);
  });

  it('剥掉回合收尾的后台任务清单', () => {
    const W =
      '<background-tasks-wrap-up>\nThese background tasks are still running:\n- t1: pnpm dev\n</background-tasks-wrap-up>';
    expect(splitTurnNotes(`${P}\n\n${W}\n\n做事`)).toEqual({ plan: 'on', rest: '做事' });
    expect(splitTurnNotes(`${W}\n\n${U}\n\n做事`)).toEqual({ unattended: 'on', rest: '做事' });
  });
});
