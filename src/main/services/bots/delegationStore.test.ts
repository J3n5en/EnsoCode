import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Delegation } from '../../../shared/types/bot';
import { DelegationStore } from './delegationStore';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const DAY = 86_400_000;
const NOW = 100 * DAY;
let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delegations-'));
  file = join(dir, 'delegations.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function record(patch: Partial<Delegation> = {}): Delegation {
  n++;
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`,
    parentConversationId: 'parent',
    parentBotId: A,
    targetBotId: B,
    chatId: null,
    task: 'do it',
    context: '',
    childConversationId: `child-${n}`,
    state: 'running',
    depth: 1,
    createdAt: NOW - DAY,
    ...patch,
  };
}
const lines = () => readFileSync(file, 'utf8').split('\n').filter(Boolean);

it('rewrites the log to the latest snapshot once redundant lines pass the threshold', () => {
  const store = new DelegationStore(file, { now: () => NOW, minRedundant: 5 });
  const item = record();
  for (let i = 0; i < 5; i++) store.save({ ...item, context: `step ${i}` });
  expect(lines()).toHaveLength(5);
  store.save({ ...item, state: 'completed', result: 'ok', finishedAt: NOW });
  expect(lines()).toHaveLength(1);
  expect(new DelegationStore(file).get(item.id)).toMatchObject({
    state: 'completed',
    result: 'ok',
  });
});

it('compacts on load and archives delivered terminal records older than the retention', () => {
  const writer = new DelegationStore(file, { now: () => NOW, minRedundant: 1000 });
  const old = record({
    state: 'completed',
    finishedAt: NOW - 31 * DAY,
    deliveredAt: NOW - 31 * DAY,
  });
  const undelivered = record({ state: 'failed', finishedAt: NOW - 40 * DAY });
  const recent = record({ state: 'completed', finishedAt: NOW - 2 * DAY, deliveredAt: NOW - DAY });
  const active = record({ createdAt: NOW - 60 * DAY });
  for (const item of [old, undelivered, recent, active]) {
    writer.save({ ...item, state: 'running' });
    writer.save(item);
  }
  writeFileSync(file, `${readFileSync(file, 'utf8')}{"torn":`, { flag: 'w' });
  const store = new DelegationStore(file, { now: () => NOW, minRedundant: 1000 });
  expect(store.get(old.id)).toBeUndefined();
  expect(
    store
      .list()
      .map((item) => item.id)
      .sort()
  ).toEqual([undelivered.id, recent.id, active.id].sort());
  expect(lines()).toHaveLength(3);
  const archived = readFileSync(join(dir, 'delegations.archive.jsonl'), 'utf8');
  expect(archived).toContain(old.id);
  expect(new DelegationStore(file, { now: () => NOW }).list()).toHaveLength(3);
});

it('keeps the original log intact when the atomic rewrite fails', () => {
  const store = new DelegationStore(file, { now: () => NOW, minRedundant: 2 });
  const item = record();
  store.save(item);
  store.save({ ...item, context: 'x' });
  const before = readFileSync(file, 'utf8');
  // 临时文件路径被目录占住 → 写临时文件失败，rename 不会发生
  mkdirSync(`${file}.${process.pid}.tmp`);
  expect(() => store.save({ ...item, context: 'y' })).not.toThrow();
  expect(readFileSync(file, 'utf8').startsWith(before)).toBe(true);
  expect(new DelegationStore(file).get(item.id)?.context).toBe('y');
  expect(existsSync(join(dir, 'delegations.archive.jsonl'))).toBe(false);
});
