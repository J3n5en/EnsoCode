import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { GroupTaskStore } from './groupTaskStore';

const CHAT = '33333333-3333-4333-8333-333333333333';
const BOT = '22222222-2222-4222-8222-222222222222';
let root: string;
let store: GroupTaskStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'group-tasks-'));
  store = new GroupTaskStore(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('appends tasks with per-chat increasing seq and replays the last snapshot', () => {
  const a = store.create(CHAT, { title: 'Login page', createdBy: 'human' }, 1)!;
  const b = store.create(CHAT, { title: 'API', detail: 'REST', createdBy: BOT }, 2)!;
  expect([a.seq, b.seq]).toEqual([1, 2]);
  store.save(CHAT, { ...a, status: 'doing', assigneeBotId: BOT, updatedAt: 3 });
  const reloaded = new GroupTaskStore(root);
  expect(reloaded.list(CHAT)).toEqual([
    { ...a, status: 'doing', assigneeBotId: BOT, updatedAt: 3 },
    b,
  ]);
  expect(reloaded.find(CHAT, '#2')?.id).toBe(b.id);
  expect(reloaded.find(CHAT, '2')?.id).toBe(b.id);
  expect(reloaded.find(CHAT, a.id)?.seq).toBe(1);
  expect(reloaded.find(CHAT, '#9')).toBeUndefined();
});

it('skips corrupt and torn lines, keeps seq monotonic after deletion', () => {
  const a = store.create(CHAT, { title: 'one', createdBy: 'human' }, 1)!;
  const b = store.create(CHAT, { title: 'two', createdBy: 'human' }, 1)!;
  expect(store.remove(CHAT, b.id)).toBe(true);
  appendFileSync(join(root, CHAT, 'tasks.jsonl'), 'garbage\n{"id":"x","seq":');
  const reloaded = new GroupTaskStore(root);
  expect(reloaded.list(CHAT).map((task) => task.id)).toEqual([a.id]);
  expect(reloaded.create(CHAT, { title: 'three', createdBy: 'human' }, 2)?.seq).toBe(3);
  expect(readFileSync(join(root, CHAT, 'tasks.jsonl'), 'utf8')).toContain('"deleted":true');
});

it('rejects invalid chat ids and titles without touching disk', () => {
  expect(store.create('../x', { title: 'a', createdBy: 'human' }, 1)).toBeUndefined();
  expect(store.create(CHAT, { title: '  ', createdBy: 'human' }, 1)).toBeUndefined();
  expect(store.list('../x')).toEqual([]);
  expect(existsSync(join(root, CHAT))).toBe(false);
});

it('forget drops the cache so a removed chat directory reads empty', () => {
  store.create(CHAT, { title: 'a', createdBy: 'human' }, 1);
  rmSync(join(root, CHAT), { recursive: true, force: true });
  store.forget(CHAT);
  expect(store.list(CHAT)).toEqual([]);
  expect(store.create(CHAT, { title: 'b', createdBy: 'human' }, 1)?.seq).toBe(1);
});

const taskLines = () =>
  readFileSync(join(root, CHAT, 'tasks.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean);

it('rewrites tasks.jsonl to the latest snapshot and keeps the deleted seq floor', () => {
  const compacting = new GroupTaskStore(root, { minRedundant: 4 });
  const a = compacting.create(CHAT, { title: 'a', createdBy: 'human' }, 1)!;
  const b = compacting.create(CHAT, { title: 'b', createdBy: 'human' }, 1)!;
  compacting.remove(CHAT, b.id);
  for (let i = 0; i < 3; i++) compacting.save(CHAT, { ...a, detail: `v${i}`, updatedAt: 2 + i });
  expect(taskLines().length).toBeLessThan(6);
  const reloaded = new GroupTaskStore(root);
  expect(reloaded.list(CHAT)).toEqual([{ ...a, detail: 'v2', updatedAt: 4 }]);
  expect(reloaded.create(CHAT, { title: 'c', createdBy: 'human' }, 5)?.seq).toBe(3);
});

it('compacts a bloated log on load and survives a failed rewrite', () => {
  const a = store.create(CHAT, { title: 'a', createdBy: 'human' }, 1)!;
  for (let i = 0; i < 6; i++) store.save(CHAT, { ...a, updatedAt: 2 + i });
  mkdirSync(join(root, CHAT, `tasks.jsonl.${process.pid}.tmp`));
  const blocked = new GroupTaskStore(root, { minRedundant: 3 });
  expect(blocked.list(CHAT)).toEqual([{ ...a, updatedAt: 7 }]);
  expect(taskLines()).toHaveLength(7);
  rmSync(join(root, CHAT, `tasks.jsonl.${process.pid}.tmp`), { recursive: true });
  const compacted = new GroupTaskStore(root, { minRedundant: 3 });
  expect(compacted.list(CHAT)).toEqual([{ ...a, updatedAt: 7 }]);
  expect(taskLines()).toHaveLength(1);
});
