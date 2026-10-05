import { describe, expect, it } from 'vitest';
import { parseBotRoutine, parseBotRoutineRun, parseGroupEntry, routineDeliveryId } from './bot';

const base = {
  id: '66666666-6666-4666-8666-666666666666',
  botId: '22222222-2222-4222-8222-222222222222',
  title: '早报',
  prompt: '汇总',
  schedule: '0 9 * * *',
  chatId: '33333333-3333-4333-8333-333333333333',
  status: 'enabled',
  procedureVersion: 2,
  approvedVersion: 2,
  catchUp: true,
  createdAt: 1,
  updatedAt: 2,
};
const OTHER = '44444444-4444-4444-8444-444444444444';

describe('parseBotRoutine', () => {
  it('合法记录原样收窄，可选字段只在合法时保留', () => {
    expect(parseBotRoutine(base)).toEqual(base);
    expect(
      parseBotRoutine({ ...base, lastRunAt: 3, lastResult: 'error', missed: 2, extra: 1 })
    ).toEqual({ ...base, lastRunAt: 3, lastResult: 'error', missed: 2 });
    expect(parseBotRoutine({ ...base, lastResult: 'boom', missed: -1, lastRunAt: 'x' })).toEqual(
      base
    );
    expect(parseBotRoutine({ ...base, lastResult: 'budget' })?.lastResult).toBe('budget');
    const full = {
      ...base,
      status: 'blocked',
      blockedReason: 'not-in-chat',
      doneBy: OTHER,
      proposedBy: OTHER,
      cursor: 5,
      catchUp: false,
      lastResult: 'interrupted',
    };
    expect(parseBotRoutine(full)).toEqual(full);
    expect(
      parseBotRoutine({ ...base, doneBy: '../x', proposedBy: 1, cursor: -1, blockedReason: 'x' })
    ).toEqual(base);
  });

  it('旧数据（只有 enabled）视为用户已批准的第 1 版，补跑默认开启', () => {
    const { status: _s, procedureVersion: _p, approvedVersion: _a, catchUp: _c, ...legacy } = base;
    const common = { procedureVersion: 1, approvedVersion: 1, catchUp: true };
    expect(parseBotRoutine({ ...legacy, enabled: true })).toEqual({
      ...legacy,
      ...common,
      status: 'enabled',
    });
    expect(parseBotRoutine({ ...legacy, enabled: false })).toEqual({
      ...legacy,
      ...common,
      status: 'paused',
    });
    expect(parseBotRoutine({ ...base, approvedVersion: undefined, status: 'draft' })).toEqual({
      ...base,
      approvedVersion: undefined,
      status: 'draft',
    });
  });

  it('脏输入拒绝', () => {
    for (const bad of [
      null,
      [],
      { ...base, id: 'x' },
      { ...base, botId: '../a' },
      { ...base, chatId: 1 },
      { ...base, title: '' },
      { ...base, prompt: 1 },
      { ...base, schedule: 'every day' },
      { ...base, status: 'yes' },
      { ...base, status: undefined, enabled: 'yes' },
      { ...base, procedureVersion: 0 },
      { ...base, approvedVersion: 3 },
      { ...base, createdAt: -1 },
    ]) {
      expect(parseBotRoutine(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('parseBotRoutineRun', () => {
  const run = {
    runId: routineDeliveryId(base.id, 60_000),
    routineId: base.id,
    botId: base.botId,
    executorId: OTHER,
    chatId: base.chatId,
    trigger: 'catchup',
    scheduledFor: 60_000,
    startedAt: 61_000,
  };

  it('runId 由 routineId + scheduledFor 派生；结算字段可选', () => {
    expect(run.runId).toBe(`routine:${base.id}:60000`);
    expect(parseBotRoutineRun(run)).toEqual(run);
    const done = {
      ...run,
      finishedAt: 70_000,
      result: 'ok',
      conversationId: 'conv',
      error: 'x',
    };
    expect(parseBotRoutineRun(done)).toEqual(done);
  });

  it('脏输入拒绝', () => {
    for (const bad of [
      { ...run, runId: 'routine:other:1' },
      { ...run, trigger: 'cron' },
      { ...run, result: 'nope' },
      { ...run, executorId: '../x' },
      { ...run, scheduledFor: -1 },
    ])
      expect(parseBotRoutineRun(bad), JSON.stringify(bad)).toBeUndefined();
  });
});

describe('群时间线里的例行任务提议条目', () => {
  it('system 条目可带例程引用，引用不合法时丢弃引用、保留正文', () => {
    const entry = { seq: 1, id: 'e', at: 1, kind: 'system', text: '提议' };
    const routine = { botId: base.botId, id: base.id };
    expect(parseGroupEntry({ ...entry, routine })).toEqual({ ...entry, routine });
    expect(parseGroupEntry({ ...entry, routine: { botId: '../x', id: base.id } })).toEqual(entry);
  });
});
