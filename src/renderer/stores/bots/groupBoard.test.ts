import type { BotRoutine, Delegation, GroupTask } from '@shared/types/bot';
import { describe, expect, it } from 'vitest';
import { chatDelegationGroups, chatRoutines, taskColumns } from './groupBoard';

const task = (seq: number, status: GroupTask['status'], updatedAt = seq): GroupTask => ({
  id: `t${seq}`,
  seq,
  title: `T${seq}`,
  status,
  createdBy: 'human',
  createdAt: seq,
  updatedAt,
});

describe('taskColumns', () => {
  it('按状态分组：待办 / 进行中按编号，已完成 / 已取消新的在前', () => {
    const columns = taskColumns([
      task(3, 'todo'),
      task(1, 'todo'),
      task(2, 'doing'),
      task(4, 'done', 10),
      task(5, 'done', 20),
      task(6, 'canceled'),
    ]);
    expect(columns.todo.map((t) => t.seq)).toEqual([1, 3]);
    expect(columns.doing.map((t) => t.seq)).toEqual([2]);
    expect(columns.done.map((t) => t.seq)).toEqual([5, 4]);
    expect(columns.canceled.map((t) => t.seq)).toEqual([6]);
  });
});

const routine = (id: string, botId: string, chatId: string, createdAt: number): BotRoutine => ({
  id,
  botId,
  chatId,
  title: id,
  prompt: 'p',
  schedule: '0 9 * * *',
  status: 'enabled',
  procedureVersion: 1,
  approvedVersion: 1,
  catchUp: true,
  createdAt,
  updatedAt: createdAt,
});

describe('chatRoutines', () => {
  it('跨成员聚合本群例行任务，按创建时间', () => {
    expect(
      chatRoutines(
        [routine('b', 'bob', 'g', 2), routine('x', 'bob', 'other', 1), routine('a', 'al', 'g', 1)],
        'g'
      ).map((item) => item.id)
    ).toEqual(['a', 'b']);
  });
});

const delegation = (
  id: string,
  state: Delegation['state'],
  createdAt: number,
  over: Partial<Delegation> = {}
): Delegation => ({
  id,
  parentConversationId: 'p',
  parentBotId: 'a',
  targetBotId: 'b',
  chatId: 'g',
  task: id,
  context: '',
  childConversationId: `c${id}`,
  state,
  depth: 1,
  createdAt,
  ...over,
});

describe('chatDelegationGroups', () => {
  it('进行中 / 已完成 / 失败·中断·取消三组；终态按结束时间新的在前，只算本群', () => {
    const groups = chatDelegationGroups(
      [
        delegation('r2', 'running', 5),
        delegation('q1', 'queued', 1),
        delegation('c1', 'completed', 1, { finishedAt: 3 }),
        delegation('c2', 'completed', 2, { finishedAt: 9 }),
        delegation('f1', 'failed', 1, { finishedAt: 4, failure: 'interrupted' }),
        delegation('x1', 'canceled', 1, { finishedAt: 6 }),
        delegation('o1', 'running', 1, { chatId: 'other' }),
      ],
      'g'
    );
    expect(groups.active.map((d) => d.id)).toEqual(['q1', 'r2']);
    expect(groups.completed.map((d) => d.id)).toEqual(['c2', 'c1']);
    expect(groups.failed.map((d) => d.id)).toEqual(['x1', 'f1']);
  });
});
