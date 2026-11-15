import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_WAKE_GRACE_MS,
  backgroundWaitStall,
  backgroundWakeText,
} from './backgroundWatch';

const task = {
  taskId: 't1',
  status: 'running' as const,
};

function input(
  over: Partial<Parameters<typeof backgroundWaitStall>[0]> = {}
): Parameters<typeof backgroundWaitStall>[0] {
  return {
    awaiting: true,
    idle: true,
    pendingUser: false,
    tasks: [task],
    ...over,
  };
}

describe('backgroundWaitStall', () => {
  it('还在跑、没超时、进程还在：不报', () => {
    expect(backgroundWaitStall(input(), 60_000)).toBeNull();
  });

  it('没在等后台任务、或还在等用户：不报', () => {
    expect(backgroundWaitStall(input({ awaiting: false }), 60_000)).toBeNull();
    expect(
      backgroundWaitStall(
        input({ pendingUser: true, tasks: [{ ...task, overdue: true, deadlineAt: 0 }] }),
        60_000
      )
    ).toBeNull();
  });

  it('超时后先报停滞，宽限过了且仍空闲才唤醒', () => {
    const tasks = [{ ...task, overdue: true, deadlineAt: 1_000 }];
    expect(backgroundWaitStall(input({ tasks }), 1_000)).toEqual({
      taskId: 't1',
      reason: 'timeout',
      wake: false,
    });
    expect(backgroundWaitStall(input({ tasks }), 1_000 + BACKGROUND_WAKE_GRACE_MS)).toEqual({
      taskId: 't1',
      reason: 'timeout',
      wake: true,
    });
    expect(
      backgroundWaitStall(input({ tasks, idle: false }), 1_000 + BACKGROUND_WAKE_GRACE_MS)
    ).toEqual({ taskId: 't1', reason: 'timeout', wake: false });
  });

  it('进程已死从第一次确认的时刻算宽限', () => {
    const tasks = [{ ...task, dead: true, deadAt: 5_000 }];
    expect(backgroundWaitStall(input({ tasks }), 5_000)).toMatchObject({
      reason: 'dead',
      wake: false,
    });
    expect(backgroundWaitStall(input({ tasks }), 5_000 + BACKGROUND_WAKE_GRACE_MS)).toMatchObject({
      reason: 'dead',
      wake: true,
    });
  });

  it('到点被杀掉的进程优先报超时，不报成进程已死', () => {
    const tasks = [{ ...task, overdue: true, deadlineAt: 1_000, dead: true, deadAt: 1_000 }];
    expect(backgroundWaitStall(input({ tasks }), 1_000)?.reason).toBe('timeout');
  });

  it('结束后仍空闲，过了宽限才算没唤醒；期间又跑起来就不报', () => {
    const tasks = [{ taskId: 't1', status: 'done' as const, endedAt: 100 }];
    expect(backgroundWaitStall(input({ tasks }), 100)).toBeNull();
    expect(backgroundWaitStall(input({ tasks }), 100 + BACKGROUND_WAKE_GRACE_MS)).toEqual({
      taskId: 't1',
      reason: 'undelivered',
      wake: true,
    });
    expect(
      backgroundWaitStall(input({ tasks, idle: false }), 100 + BACKGROUND_WAKE_GRACE_MS)
    ).toBeNull();
    expect(
      backgroundWaitStall(input({ tasks, consumed: true }), 100 + BACKGROUND_WAKE_GRACE_MS)
    ).toBeNull();
  });

  it('还有任务在跑时，不把已经结束的那条当成没唤醒', () => {
    expect(
      backgroundWaitStall(
        input({
          tasks: [
            { taskId: 'done', status: 'done', endedAt: 0 },
            { taskId: 'run', status: 'running' },
          ],
        }),
        BACKGROUND_WAKE_GRACE_MS
      )
    ).toBeNull();
  });

  it('还有任务在跑时，不拿已经死掉的旧任务报进程已死', () => {
    // 真实误报：会话等 task-33（还在跑），旧任务 task-28 的进程早就没了
    const tasks = [
      { taskId: 'task-33', status: 'running' as const },
      { taskId: 'task-28', status: 'failed' as const, dead: true, deadAt: 0, endedAt: 0 },
    ];
    expect(backgroundWaitStall(input({ tasks }), 60_000)).toBeNull();
    expect(backgroundWaitStall(input({ tasks }), 60_000 + BACKGROUND_WAKE_GRACE_MS)).toBeNull();
  });

  it('alive 还没探测（没有 dead 标记）时按未知处理，不报进程已死', () => {
    // worker 只在确认进程不在时才把 alive 置 false；缺省 / null 都是「还没探测」
    const tasks = [{ taskId: 't1', status: 'running' as const }];
    expect(backgroundWaitStall(input({ tasks }), 60_000)).toBeNull();
    expect(backgroundWaitStall(input({ tasks }), 60_000 + BACKGROUND_WAKE_GRACE_MS)).toBeNull();
  });

  it('所有任务都已退出时报没唤醒，不报进程已死', () => {
    const tasks = [
      { taskId: 'done', status: 'done' as const, endedAt: 0 },
      { taskId: 'killed', status: 'failed' as const, dead: true, deadAt: 0, endedAt: 0 },
    ];
    expect(backgroundWaitStall(input({ tasks }), 0)).toBeNull();
    expect(backgroundWaitStall(input({ tasks }), BACKGROUND_WAKE_GRACE_MS)).toMatchObject({
      reason: 'undelivered',
      wake: true,
    });
  });

  it('多个任务混合状态：在跑的那条没超时就不报，超时了才报超时', () => {
    const mixed = [
      { taskId: 'run', status: 'running' as const },
      { taskId: 'killed', status: 'failed' as const, dead: true, deadAt: 0, endedAt: 0 },
      { taskId: 'done', status: 'done' as const, endedAt: 0 },
    ];
    expect(backgroundWaitStall(input({ tasks: mixed }), 60_000)).toBeNull();
    const late = mixed.map((task) =>
      task.taskId === 'run' ? { ...task, overdue: true, deadlineAt: 50_000 } : task
    );
    expect(backgroundWaitStall(input({ tasks: late }), 60_000)).toMatchObject({
      taskId: 'run',
      reason: 'timeout',
    });
  });
});

describe('backgroundWakeText', () => {
  it('点名任务和原因，并告诉模型不要再等', () => {
    const text = backgroundWakeText('undelivered', 'task-1');
    expect(text).toContain('task-1');
    expect(text).toContain('completion notification');
    expect(text).toContain('Do not wait');
  });
});
