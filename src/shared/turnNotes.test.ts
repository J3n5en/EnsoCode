import { describe, expect, it } from 'vitest';
import {
  leadingTaskWrapUp,
  prependTurnNote,
  splitTaskWrapUpPrefix,
  splitTurnNotes,
  withoutTaskWrapUp,
} from './turnNotes';

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

describe('收尾清单解析', () => {
  const W = [
    '<background-tasks-wrap-up>',
    'These background tasks are still running and you have not said what happens to them:',
    '- task-1-a: pnpm dev (running 0m)',
    `- task-2-b: ssh green 'echo " (running 0m)' (running 1h 5m)`,
    'Call task_settle once for all of them: stop each one you no longer need, or keep it with a one-line reason the user will see. Do not leave them undeclared.',
    '</background-tasks-wrap-up>',
  ].join('\n');

  it('逐条拿到任务 id、命令和已运行时长，英文指令不算任务', () => {
    expect(splitTaskWrapUpPrefix(`${W}\n\n做事`)).toEqual({
      items: [
        { taskId: 'task-1-a', command: 'pnpm dev', ran: '0m' },
        { taskId: 'task-2-b', command: `ssh green 'echo " (running 0m)'`, ran: '1h 5m' },
      ],
      rest: '做事',
    });
    expect(splitTaskWrapUpPrefix(`做事\n\n${W}`)).toBeNull();
  });

  it('与 Plan / 无人值守提示并列时也能找到，去掉后正文不变', () => {
    const text = `${P}\n\n${W}\n\n做事`;
    expect(leadingTaskWrapUp(text)?.items.map((item) => item.taskId)).toEqual([
      'task-1-a',
      'task-2-b',
    ]);
    expect(withoutTaskWrapUp(text)).toBe(`${P}\n\n做事`);
    expect(leadingTaskWrapUp('做事')).toBeUndefined();
    expect(withoutTaskWrapUp('做事')).toBe('做事');
  });
});
