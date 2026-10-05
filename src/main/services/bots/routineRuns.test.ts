import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { type BotRoutineRun, routineDeliveryId } from '../../../shared/types/bot';
import { BotRoutineRunLog } from './routineRuns';

const BOT = '22222222-2222-4222-8222-222222222222';
const R1 = '66666666-6666-4666-8666-666666666666';
const R2 = '77777777-7777-4777-8777-777777777777';
const CHAT = '33333333-3333-4333-8333-333333333333';

let root: string;
let log: BotRoutineRunLog;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bot-routine-runs-'));
  log = new BotRoutineRunLog(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (routineId: string, scheduledFor: number, extra: Partial<BotRoutineRun> = {}) => ({
  runId: routineDeliveryId(routineId, scheduledFor),
  routineId,
  botId: BOT,
  executorId: BOT,
  chatId: CHAT,
  trigger: 'scheduled' as const,
  scheduledFor,
  startedAt: scheduledFor,
  ...extra,
});

it('同 runId 后写覆盖；按例程最近在前列出，坏行跳过', () => {
  log.save(run(R1, 1000));
  log.save(run(R1, 2000));
  log.save(run(R2, 1500));
  appendFileSync(join(root, BOT, 'routine-runs.jsonl'), '{torn');
  log.save(run(R1, 1000, { finishedAt: 1100, result: 'ok' }));
  expect(log.get(BOT, routineDeliveryId(R1, 1000))).toMatchObject({ result: 'ok' });
  expect(log.list(BOT, R1).map((item) => item.scheduledFor)).toEqual([2000, 1000]);
  expect(log.list(BOT, R1, 1)).toHaveLength(1);
  expect(new BotRoutineRunLog(root).list(BOT, R2)).toHaveLength(1);
});

it('unsettled 汇总所有成员未结算的占用；非法 botId 目录与坏路径忽略', () => {
  log.save(run(R1, 1000));
  log.save(run(R1, 2000, { finishedAt: 2100, result: 'error' }));
  mkdirSync(join(root, 'not-a-bot'));
  expect(log.unsettled().map((item) => item.runId)).toEqual([routineDeliveryId(R1, 1000)]);
  expect(log.list('../evil', R1)).toEqual([]);
  expect(() => log.save({ ...run(R1, 1), runId: 'x' })).toThrow();
});

it('超过上限时压缩：每个例程保留最近 50 条，未结算的保留', () => {
  log.save(run(R2, 1));
  for (let i = 0; i < 1000; i += 1) log.save(run(R1, 10 + i, { finishedAt: 10 + i, result: 'ok' }));
  const lines = readFileSync(join(root, BOT, 'routine-runs.jsonl'), 'utf8')
    .trim()
    .split('\n');
  expect(lines.length).toBeLessThan(200);
  expect(log.list(BOT, R1, 100)).toHaveLength(50);
  expect(log.list(BOT, R1, 1)[0].scheduledFor).toBe(1009);
  expect(log.unsettled()).toHaveLength(1);
});

it('forget 删除某例程的全部历史', () => {
  log.save(run(R1, 1000));
  log.save(run(R2, 1000));
  log.forget(BOT, R1);
  expect(log.list(BOT, R1)).toEqual([]);
  expect(log.list(BOT, R2)).toHaveLength(1);
});
