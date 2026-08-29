import type { BackgroundTaskInfo, SubagentInfo } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import { applyTaskEvent, type TaskState } from './taskProjection';

const task = (over: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo => ({
  taskId: 't1',
  command: 'pnpm test',
  status: 'running',
  tail: '',
  startedAt: 1,
  ...over,
});

const agent = (over: Partial<SubagentInfo> = {}): SubagentInfo => ({
  id: 'a1',
  description: 'scan module',
  status: 'running',
  steps: 0,
  currentActivity: '',
  startedAt: 1,
  ...over,
});

const empty: TaskState = { tasks: [], subagents: [] };

describe('applyTaskEvent', () => {
  it('task-started 追加任务，重复 taskId 不重复追加', () => {
    const s1 = applyTaskEvent(empty, { type: 'task-started', task: task() });
    expect(s1?.tasks).toHaveLength(1);
    const s2 = applyTaskEvent(s1 ?? empty, { type: 'task-started', task: task() });
    expect(s2?.tasks).toHaveLength(1);
  });

  it('task-output 覆盖 tail 与 status，未知 taskId 不新增', () => {
    const base: TaskState = { tasks: [task()], subagents: [] };
    const next = applyTaskEvent(base, {
      type: 'task-output',
      taskId: 't1',
      tail: 'hello',
      status: 'running',
    });
    expect(next?.tasks[0]?.tail).toBe('hello');
    const miss = applyTaskEvent(base, {
      type: 'task-output',
      taskId: 'nope',
      tail: 'x',
      status: 'running',
    });
    expect(miss?.tasks).toHaveLength(1);
    expect(miss?.tasks[0]?.tail).toBe('');
  });

  it('task-ended 写终态与退出码', () => {
    const base: TaskState = { tasks: [task()], subagents: [] };
    const next = applyTaskEvent(base, {
      type: 'task-ended',
      taskId: 't1',
      status: 'done',
      exitCode: 0,
    });
    expect(next?.tasks[0]?.status).toBe('done');
    expect(next?.tasks[0]?.exitCode).toBe(0);
  });

  it('subagent-update 按 id 覆盖式 upsert', () => {
    const s1 = applyTaskEvent(empty, { type: 'subagent-update', agent: agent() });
    expect(s1?.subagents).toHaveLength(1);
    const s2 = applyTaskEvent(s1 ?? empty, {
      type: 'subagent-update',
      agent: agent({ status: 'done', resultText: 'ok' }),
    });
    expect(s2?.subagents).toHaveLength(1);
    expect(s2?.subagents[0]?.status).toBe('done');
    expect(s2?.subagents[0]?.resultText).toBe('ok');
  });

  it('无关事件返回 null（调用方跳过重渲染）', () => {
    expect(applyTaskEvent(empty, { type: 'status', status: 'running' })).toBeNull();
  });

  it('脏输入不崩：缺 task/agent 字段的事件按无关处理', () => {
    expect(applyTaskEvent(empty, { type: 'task-started' })).toBeNull();
    expect(applyTaskEvent(empty, { type: 'subagent-update', agent: null })).toBeNull();
  });
});
