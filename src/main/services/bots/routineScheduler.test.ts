import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotChat, BotProfile, BotRoutine, BotRoutineBlock } from '../../../shared/types/bot';
import { routineDeliveryId } from '../../../shared/types/bot';
import { BotRoutineRunLog } from './routineRuns';
import { type RoutineRunOptions, RoutineScheduler, routineBlock } from './routineScheduler';
import { type BotRoutineDraft, BotRoutineStore } from './routineStore';

const BOT = '22222222-2222-4222-8222-222222222222';
const BOT2 = '55555555-5555-4555-8555-555555555555';
const CHAT = '33333333-3333-4333-8333-333333333333';
const at = (h: number, m = 0, s = 0) => new Date(2026, 0, 5, h, m, s).getTime();

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bot-routine-scheduler-'));
  vi.useFakeTimers();
  vi.setSystemTime(at(9, 0, 30));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

type Result = { ok: boolean; error?: string; conversationId?: string };
function setup(options: { block?: BotRoutineBlock; result?: () => Promise<Result> } = {}) {
  const store = new BotRoutineStore(root);
  const runs = new BotRoutineRunLog(root);
  const state = { block: options.block };
  const run = vi.fn<(routine: BotRoutine, options: RoutineRunOptions) => Promise<Result>>(
    options.result ?? (async (): Promise<Result> => ({ ok: true, conversationId: 'conv' }))
  );
  const scheduler = new RoutineScheduler({
    store,
    runs,
    run,
    eligible: () => true,
    check: () => state.block,
    emit: () => {},
  });
  return { store, runs, run, scheduler, state };
}
function create(store: BotRoutineStore, extra: Partial<BotRoutineDraft> = {}) {
  const saved = store.save(BOT, {
    title: '巡检',
    prompt: '看一下',
    schedule: '0 * * * *',
    chatId: CHAT,
    ...extra,
  });
  if (!saved.ok) throw new Error('setup');
  return saved.routine;
}
const get = (store: BotRoutineStore, id: string) =>
  store.list(BOT).find((item) => item.id === id) as BotRoutine;

it('关闭期间错过多次只补跑最近一次，记 catchup；重启不重复补跑', async () => {
  const f = setup();
  const routine = create(f.store);
  vi.setSystemTime(at(12, 10));
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.run.mock.calls[0][1]).toMatchObject({
    deliveryId: routineDeliveryId(routine.id, at(12)),
    executorId: BOT,
    dryRun: false,
  });
  expect(get(f.store, routine.id)).toMatchObject({ cursor: at(12), missed: 2, lastResult: 'ok' });
  expect(f.runs.list(BOT, routine.id)).toEqual([
    expect.objectContaining({
      trigger: 'catchup',
      scheduledFor: at(12),
      result: 'ok',
      conversationId: 'conv',
    }),
  ]);
  f.scheduler.stop();
  const again = setup();
  again.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(again.run).not.toHaveBeenCalled();
  again.scheduler.stop();
});

it('关闭补跑时只记错过次数', async () => {
  const f = setup();
  const routine = create(f.store, { catchUp: false });
  vi.setSystemTime(at(12, 10));
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.run).not.toHaveBeenCalled();
  expect(get(f.store, routine.id)).toMatchObject({ cursor: at(12), missed: 3 });
  f.scheduler.stop();
});

it('启动对账：未结算的占用标 interrupted，且该时刻不再补跑', async () => {
  const f = setup({ result: () => new Promise<Result>(() => {}) });
  const routine = create(f.store);
  vi.setSystemTime(at(10, 0, 5));
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.runs.unsettled()).toHaveLength(1);
  f.scheduler.stop();
  // 模拟应用崩溃后重启：同一时刻
  const again = setup();
  again.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(again.run).not.toHaveBeenCalled();
  expect(again.runs.list(BOT, routine.id)[0]).toMatchObject({
    result: 'interrupted',
    finishedAt: expect.any(Number),
  });
  expect(get(again.store, routine.id).lastResult).toBe('interrupted');
  again.scheduler.stop();
});

it('上一次还在跑时到点记 skipped-busy，不重入', async () => {
  let finish: (result: Result) => void = () => {};
  const f = setup({ result: () => new Promise<Result>((resolve) => (finish = resolve)) });
  const routine = create(f.store, { schedule: '* * * * *' });
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.runs.list(BOT, routine.id).map((run) => run.result)).toEqual([
    'skipped-busy',
    undefined,
  ]);
  expect(f.scheduler.trigger(BOT, routine.id, 'manual')).toEqual({ ok: false, error: 'busy' });
  finish({ ok: false, error: 'budget-exceeded' });
  await vi.advanceTimersByTimeAsync(0);
  expect(get(f.store, routine.id).lastResult).toBe('budget');
  f.scheduler.stop();
});

it('待批准的例程不调度、不能手动运行，但可以试运行；试运行不推进调度', async () => {
  const f = setup();
  const proposed = f.store.propose(BOT, {
    title: '日报',
    prompt: '写日报',
    schedule: '* * * * *',
    chatId: CHAT,
  });
  if (!proposed.ok) throw new Error('setup');
  const id = proposed.routine.id;
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f.run).not.toHaveBeenCalled();
  expect(f.scheduler.trigger(BOT, id, 'manual')).toEqual({ ok: false, error: 'not-approved' });
  const dry = f.scheduler.trigger(BOT, id, 'dry-run');
  expect(dry.ok).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.run.mock.calls[0][1]).toMatchObject({ dryRun: true });
  const routine = get(f.store, id);
  expect(routine.status).toBe('draft');
  expect(routine).not.toHaveProperty('lastRunAt');
  expect(routine).not.toHaveProperty('cursor');
  expect(f.runs.list(BOT, id)[0]).toMatchObject({ trigger: 'dry-run', result: 'ok' });

  f.store.review(BOT, id, true);
  f.scheduler.refresh();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.run).toHaveBeenCalledTimes(2);
  expect(f.run.mock.calls[1][1]).toMatchObject({ dryRun: false });
  // 成员改动流程后回到待批准，不再调度
  f.store.propose(BOT, { title: '日报', prompt: '写周报', schedule: '* * * * *', chatId: CHAT });
  f.scheduler.refresh();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f.run).toHaveBeenCalledTimes(2);
  f.scheduler.stop();
});

it('依赖检查不通过：自动 blocked、写历史并停止调度；草稿试运行失败不改状态', async () => {
  const f = setup({ block: 'not-in-chat' });
  const routine = create(f.store, { schedule: '* * * * *', doneBy: BOT2 });
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.run).not.toHaveBeenCalled();
  expect(get(f.store, routine.id)).toMatchObject({
    status: 'blocked',
    blockedReason: 'not-in-chat',
  });
  expect(f.runs.list(BOT, routine.id)[0]).toMatchObject({
    result: 'blocked',
    executorId: BOT2,
  });
  expect(vi.getTimerCount()).toBe(0);
  expect(f.scheduler.trigger(BOT, routine.id, 'manual')).toEqual({
    ok: false,
    error: 'blocked',
  });

  const proposed = f.store.propose(BOT, {
    title: '草稿',
    prompt: 'x',
    schedule: '* * * * *',
    chatId: CHAT,
  });
  if (!proposed.ok) throw new Error('setup');
  expect(f.scheduler.trigger(BOT, proposed.routine.id, 'dry-run')).toEqual({
    ok: false,
    error: 'blocked',
    reason: 'not-in-chat',
  });
  expect(get(f.store, proposed.routine.id).status).toBe('draft');

  f.state.block = undefined;
  f.store.save(BOT, { ...routine, id: routine.id, enabled: true });
  expect(f.scheduler.verify(BOT, routine.id)?.status).toBe('enabled');
  f.state.block = 'chat-archived';
  expect(f.scheduler.verify(BOT, routine.id)).toMatchObject({
    status: 'blocked',
    blockedReason: 'chat-archived',
  });
  f.scheduler.stop();
});

it('手动运行更新上次结果但不前移游标', async () => {
  const f = setup();
  const routine = create(f.store);
  f.scheduler.start();
  const started = f.scheduler.trigger(BOT, routine.id, 'manual');
  expect(started.ok).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(get(f.store, routine.id)).toMatchObject({ lastResult: 'ok', cursor: routine.cursor });
  expect(f.runs.list(BOT, routine.id)[0]).toMatchObject({
    trigger: 'manual',
    scheduledFor: at(9, 0, 30),
  });
  expect(f.scheduler.trigger(BOT, 'nope', 'manual')).toEqual({ ok: false, error: 'not-found' });
  f.scheduler.stop();
});

it('依赖检查：执行成员、目标聊天、成员在聊天里、委派 ACL', () => {
  const bot = (id: string, extra: Partial<BotProfile> = {}) =>
    ({
      id,
      delegation: { canDelegateTo: 'any', acceptFrom: 'any' },
      ...extra,
    }) as BotProfile;
  const bots = new Map([
    [BOT, bot(BOT)],
    [BOT2, bot(BOT2)],
  ]);
  const chat = { id: CHAT, members: [BOT, BOT2] } as unknown as BotChat;
  const chats = new Map([[CHAT, chat]]);
  const lookup = { bot: (id: string) => bots.get(id), chat: (id: string) => chats.get(id) };
  const routine = { botId: BOT, chatId: CHAT } as BotRoutine;
  const by = { ...routine, doneBy: BOT2 };
  expect(routineBlock(routine, lookup)).toBeUndefined();
  expect(routineBlock(by, lookup)).toBeUndefined();
  bots.set(BOT2, bot(BOT2, { delegation: { canDelegateTo: 'any', acceptFrom: [] } }));
  expect(routineBlock(by, lookup)).toBe('acl');
  bots.set(BOT, bot(BOT, { delegation: { canDelegateTo: [BOT2], acceptFrom: 'any' } }));
  bots.set(BOT2, bot(BOT2));
  expect(routineBlock(by, lookup)).toBeUndefined();
  bots.set(BOT2, bot(BOT2, { archivedAt: 1 }));
  expect(routineBlock(by, lookup)).toBe('executor-archived');
  bots.delete(BOT2);
  expect(routineBlock(by, lookup)).toBe('executor-missing');
  chats.set(CHAT, { ...chat, members: [BOT2] });
  expect(routineBlock(routine, lookup)).toBe('not-in-chat');
  chats.set(CHAT, { ...chat, archivedAt: 1 });
  expect(routineBlock(routine, lookup)).toBe('chat-archived');
  chats.clear();
  expect(routineBlock(routine, lookup)).toBe('chat-missing');
});
