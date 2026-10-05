import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotInboxStore } from './inboxStore';

let root: string;
let file: string;
let clock: number;
const open = (options: { minRedundant?: number; retentionMs?: number } = {}) =>
  new BotInboxStore(file, { now: () => clock, ...options });
const budget = (botId: string) => ({
  key: `budget:${botId}:d`,
  kind: 'budget' as const,
  chatId: null,
  botId,
  budget: { reason: 'cost' as const, day: 'd' },
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bot-inbox-'));
  file = join(root, 'inbox.jsonl');
  clock = 100;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('BotInboxStore', () => {
  it('dedupes by key, keeps dismissal across restarts and only writes on change', () => {
    const store = open();
    expect(store.upsert(budget('a'))).toBe(true);
    expect(store.upsert(budget('a'))).toBe(false);
    clock = 200;
    expect(store.dismiss('budget:a:d')).toBe(true);
    expect(store.dismiss('missing')).toBe(false);
    const lines = readFileSync(file, 'utf8').trim().split('\n').length;
    const reloaded = open();
    expect(reloaded.list()).toEqual([
      { ...budget('a'), createdAt: 100, updatedAt: 200, dismissedAt: 200 },
    ]);
    // 仍然活跃的条目再次出现不会取消忽略
    expect(reloaded.upsert(budget('a'))).toBe(false);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(lines);
    expect(reloaded.reopen('budget:a:d')).toBe(true);
    expect(reloaded.list()[0].dismissedAt).toBeUndefined();
  });

  it('sync resolves vanished items of the given kinds; a resolved key coming back reopens fresh', () => {
    const store = open();
    store.upsert(budget('a'));
    store.upsert({ key: 'silence:s:1', kind: 'silence', chatId: 'c', since: 1 });
    store.dismiss('budget:a:d');
    clock = 300;
    expect(store.sync(['budget'], [budget('b')])).toBe(true);
    expect(store.list().map((item) => item.key)).toEqual(['silence:s:1', 'budget:b:d']);
    expect(store.sync(['budget'], [budget('b')])).toBe(false);
    clock = 400;
    store.sync(['budget'], [budget('a'), budget('b')]);
    expect(store.get('budget:a:d')).toMatchObject({ createdAt: 400 });
    expect(store.get('budget:a:d')?.dismissedAt).toBeUndefined();
    expect(store.resolve('silence:s:1')).toBe(true);
    expect(store.resolve('silence:s:1')).toBe(false);
  });

  it('updates payload in place, skips torn lines and compacts redundant history', () => {
    const store = open({ minRedundant: 3 });
    const ask = { requestId: 'r', question: 'q?' };
    store.upsert({ key: 'ask:s:r', kind: 'ask', chatId: 'c', conversationId: 's', ask });
    for (let i = 0; i < 4; i++)
      store.upsert({
        key: 'ask:s:r',
        kind: 'ask',
        chatId: 'c',
        conversationId: 's',
        ask: { ...ask, question: `q${i}` },
      });
    appendFileSync(file, '{"key":"broken"\n{"nope":1}\n');
    const reloaded = open({ minRedundant: 3 });
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0].ask?.question).toBe('q3');
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('drops long-resolved items on load', () => {
    const store = open({ retentionMs: 1000 });
    store.upsert(budget('a'));
    store.resolve('budget:a:d');
    clock = 5000;
    const reloaded = open({ retentionMs: 1000, minRedundant: 1 });
    expect(reloaded.get('budget:a:d')).toBeUndefined();
  });
});
