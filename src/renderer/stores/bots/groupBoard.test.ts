import type { BotRoutine, Delegation, GroupTask, GroupTaskRun } from '@shared/types/bot';
import { describe, expect, it } from 'vitest';
import {
  canRework,
  chatDelegationGroups,
  chatRoutines,
  taskBlockInfo,
  taskColumns,
  taskRunRows,
} from './groupBoard';

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
  it('按状态分组：待办 / 进行中 / 待验收按编号，已完成 / 已取消新的在前', () => {
    const columns = taskColumns([
      task(3, 'todo'),
      task(1, 'todo'),
      task(2, 'doing'),
      task(8, 'review'),
      task(7, 'review', 30),
      task(4, 'done', 10),
      task(5, 'done', 20),
      task(6, 'canceled'),
    ]);
    expect(columns.todo.map((t) => t.seq)).toEqual([1, 3]);
    expect(columns.doing.map((t) => t.seq)).toEqual([2]);
    expect(columns.review.map((t) => t.seq)).toEqual([7, 8]);
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

  it('等待自动重试的失败记录归进行中，不进失败组；接替出现后回到失败组', () => {
    const waiting = delegation('w1', 'failed', 2, { finishedAt: 4, autoRetryAt: 9 });
    const groups = chatDelegationGroups([delegation('r1', 'running', 3), waiting], 'g');
    expect(groups.active.map((d) => d.id)).toEqual(['w1', 'r1']);
    expect(groups.failed).toEqual([]);
    const next = delegation('w2', 'running', 10, { retryOf: 'w1', retryBy: 'auto' });
    const after = chatDelegationGroups([waiting, next], 'g');
    expect(after.active.map((d) => d.id)).toEqual(['w2']);
    expect(after.failed.map((d) => d.id)).toEqual(['w1']);
  });
});

describe('taskRunRows', () => {
  const run = (id: string, createdAt: number, extra: Partial<GroupTaskRun> = {}): GroupTaskRun => ({
    id,
    botId: 'b',
    trigger: 'delegate',
    state: 'completed',
    createdAt,
    ...extra,
  });

  it('按发起先后排列，同时刻保持原顺序，并按 id 关联委派记录', () => {
    const rows = taskRunRows(
      [run('c', 30), run('a', 10), run('b1', 20), run('b2', 20)],
      [{ id: 'a', childConversationId: 'conv-a' } as Delegation],
      100
    );
    expect(rows.map((row) => row.run.id)).toEqual(['a', 'b1', 'b2', 'c']);
    expect(rows[0].record?.childConversationId).toBe('conv-a');
    expect(rows[1].record).toBeUndefined();
  });

  it('排队中按 createdAt 记等待时长，其余按 startedAt→finishedAt 记耗时', () => {
    const [queued, running, done, legacy, canceled] = taskRunRows(
      [
        run('q', 10, { state: 'queued' }),
        run('r', 20, { state: 'running', startedAt: 40 }),
        run('d', 30, { startedAt: 50, finishedAt: 90 }),
        run('l', 40, { state: 'failed', finishedAt: 70 }),
        run('x', 50, { state: 'canceled', finishedAt: 60 }),
      ],
      [],
      100
    );
    expect(queued.time).toEqual({ queued: true, ms: 90 });
    expect(running.time).toEqual({ queued: false, ms: 60 });
    expect(done.time).toEqual({ queued: false, ms: 40 });
    expect(legacy.time).toEqual({ queued: false, ms: 30 });
    expect(canceled.time).toEqual({ queued: false, ms: 10 });
  });
});

describe('canRework', () => {
  it('只有委派交付、仍有执行人的待验收任务能退回返工', () => {
    const delivered = { ...task(1, 'review'), delegationId: 'd1', assigneeBotId: 'b' };
    expect(canRework(delivered)).toBe(true);
    expect(canRework({ ...delivered, delegationId: undefined })).toBe(false);
    expect(canRework({ ...delivered, assigneeBotId: undefined })).toBe(false);
    expect(canRework({ ...delivered, status: 'doing' })).toBe(false);
  });
});

describe('taskBlockInfo', () => {
  const blocked = (extra: Partial<GroupTask> = {}): GroupTask => ({
    ...task(1, 'blocked', 50),
    assigneeBotId: 'b',
    delegationId: 'd1',
    ...extra,
  });
  const record = (extra: Partial<Delegation> = {}) =>
    ({
      id: 'd1',
      parentBotId: 'boss',
      targetBotId: 'b',
      state: 'blocked',
      createdAt: 10,
      finishedAt: 40,
      blocked: { need: '数据库地址', waitFor: 'parent', at: 30 },
      ...extra,
    }) as Delegation;

  it('没卡住返回 undefined', () => {
    expect(taskBlockInfo(task(1, 'doing'), [])).toBeUndefined();
    expect(taskBlockInfo(task(1, 'review'), [])).toBeUndefined();
  });

  it('缺信息：缺什么、等发起方回复，从本轮结束算起', () => {
    const info = taskBlockInfo(blocked({ blockedReason: 'need', blockedNeed: '数据库地址' }), [
      record(),
    ]);
    expect(info).toEqual({ reason: 'need', need: '数据库地址', waitFor: 'boss', since: 40 });
  });

  it('缺信息：等人回复；连续卡满次数后只等人', () => {
    const need = { blockedReason: 'need' as const, blockedNeed: 'x' };
    expect(
      taskBlockInfo(blocked(need), [record({ blocked: { need: 'x', waitFor: 'human', at: 30 } })])
    ).toMatchObject({ waitFor: 'human' });
    expect(taskBlockInfo(blocked({ ...need, blockedStreak: { b: 3 } }), [record()])).toMatchObject({
      waitFor: 'human',
      humanOnly: true,
    });
  });

  it('缺信息：委派记录已清理时等人，按任务更新时间算', () => {
    expect(taskBlockInfo(blocked({ blockedReason: 'need', blockedNeed: 'x' }), [])).toEqual({
      reason: 'need',
      need: 'x',
      waitFor: 'human',
      since: 50,
    });
  });

  it('执行失败：带上委派记录（原因），从执行结束算起', () => {
    const failed = record({ state: 'failed', failure: 'timeout', blocked: undefined });
    const info = taskBlockInfo(
      blocked({
        blockedReason: 'failed',
        runs: [
          {
            id: 'd1',
            botId: 'b',
            trigger: 'delegate',
            state: 'failed',
            createdAt: 10,
            finishedAt: 45,
          },
        ],
      }),
      [failed]
    );
    expect(info).toEqual({ reason: 'failed', record: failed, since: 45 });
  });

  it('执行失败（P2 旧数据：进行中 + 当前执行失败）也算卡住', () => {
    const info = taskBlockInfo(
      {
        ...task(1, 'doing', 50),
        assigneeBotId: 'b',
        delegationId: 'd1',
        runs: [{ id: 'd1', botId: 'b', trigger: 'delegate', state: 'failed', createdAt: 10 }],
      },
      []
    );
    expect(info).toEqual({ reason: 'failed', since: 50 });
  });
});
