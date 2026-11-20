import type { BackgroundTaskInfo, RendererAgentEvent } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { BackgroundTaskTracker } from './backgroundTaskTracker';

const identity = { sessionId: 's1', generation: 'g1' } as const;

const task = (overrides: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo => ({
  taskId: 't1',
  command: 'pnpm dev',
  status: 'running',
  tail: '',
  startedAt: 1_000,
  ...overrides,
});

const started = (info: BackgroundTaskInfo): RendererAgentEvent =>
  ({ type: 'task-started', identity, seq: 1, task: info }) as RendererAgentEvent;

describe('BackgroundTaskTracker', () => {
  it('累积 task-started，结束时补状态与退出码', () => {
    const tracker = new BackgroundTaskTracker();
    tracker.observe(started(task()));
    tracker.observe({
      type: 'task-ended',
      identity,
      seq: 2,
      taskId: 't1',
      status: 'failed',
      exitCode: 2,
    } as RendererAgentEvent);
    expect(tracker.tasks('s1')).toEqual([
      { taskId: 't1', command: 'pnpm dev', status: 'failed', startedAt: 1_000, exitCode: 2 },
    ]);
  });

  it('background-tasks-level 整体替换，snapshot 也整体替换', () => {
    const tracker = new BackgroundTaskTracker();
    tracker.observe(started(task()));
    tracker.observe({
      type: 'background-tasks-level',
      identity,
      seq: 3,
      tasks: [task({ taskId: 't2', startedAt: 2_000 })],
    } as RendererAgentEvent);
    expect(tracker.tasks('s1').map((item) => item.taskId)).toEqual(['t2']);

    tracker.observe({
      type: 'snapshot',
      sessions: [{ identity, status: 'running', messages: [], commands: [], backgroundTasks: [] }],
    } as unknown as RendererAgentEvent);
    expect(tracker.tasks('s1')).toEqual([]);
  });

  it('按开始时间倒序，且不记录命令输出', () => {
    const tracker = new BackgroundTaskTracker();
    tracker.observe(started(task({ taskId: 'old', startedAt: 1_000 })));
    tracker.observe(started(task({ taskId: 'new', startedAt: 9_000 })));
    tracker.observe({
      type: 'task-output',
      identity,
      seq: 4,
      taskId: 'new',
      tail: 'SECRET OUTPUT',
      status: 'running',
    } as RendererAgentEvent);
    const tasks = tracker.tasks('s1');
    expect(tasks.map((item) => item.taskId)).toEqual(['new', 'old']);
    expect(JSON.stringify(tasks)).not.toContain('SECRET OUTPUT');
  });

  it('未知会话返回空数组', () => {
    expect(new BackgroundTaskTracker().tasks('nope')).toEqual([]);
  });

  it('hasRunning：任一会话还有在跑的后台命令（回合已结束也算），全部结束后为 false', () => {
    const tracker = new BackgroundTaskTracker();
    expect(tracker.hasRunning()).toBe(false);
    tracker.observe(started(task()));
    expect(tracker.hasRunning()).toBe(true);
    tracker.observe({
      type: 'task-ended',
      identity,
      seq: 2,
      taskId: 't1',
      status: 'done',
      exitCode: 0,
    } as RendererAgentEvent);
    expect(tracker.hasRunning()).toBe(false);
    tracker.observe({
      type: 'background-tasks-level',
      identity: { sessionId: 's2', generation: 'g2' },
      seq: 1,
      tasks: [task({ taskId: 't2' })],
    } as RendererAgentEvent);
    expect(tracker.hasRunning()).toBe(true);
  });
});
