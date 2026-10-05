import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOT_SCHEMA_VERSION } from '../../../shared/bots/migrations';
import { BotStore } from './botStore';
import { BotChatStore } from './chatStore';
import { DelegationStore } from './delegationStore';
import { GroupTaskStore } from './groupTaskStore';
import { BotRoutineStore } from './routineStore';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const CHAT = '33333333-3333-4333-8333-333333333333';
const D1 = '44444444-4444-4444-8444-444444444444';
const D2 = '55555555-5555-4555-8555-555555555555';
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bot-schema-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const jsonLines = (path: string) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
function put(path: string, value: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}

describe('schemaVersion on persisted bot records', () => {
  it('bot.json: stamps on write, reads legacy, ignores newer schemas', () => {
    const store = new BotStore(join(root, 'bots'));
    const created = store.create({ name: 'Alice' }, []);
    if (!created.ok) throw new Error('create');
    const file = join(root, 'bots', created.bot.id, 'bot.json');
    expect(json(file)).toMatchObject({ schemaVersion: BOT_SCHEMA_VERSION.bot, version: 1 });
    expect(new BotStore(join(root, 'bots')).get(created.bot.id)).toEqual(created.bot);

    const { schemaVersion: _, ...legacy } = json(file);
    put(file, legacy);
    expect(new BotStore(join(root, 'bots')).get(created.bot.id)).toEqual(created.bot);
    put(file, { ...legacy, schemaVersion: BOT_SCHEMA_VERSION.bot + 1 });
    expect(new BotStore(join(root, 'bots')).get(created.bot.id)).toBeUndefined();
  });

  it('chat.json: stamps on write, reads legacy, ignores newer schemas', () => {
    const store = new BotChatStore(join(root, 'chats'));
    const chat = store.create({
      kind: 'group',
      title: 'g',
      members: [A, B],
      bossBotId: A,
      workspace: { kind: 'project', projectId: 'p' },
    });
    if (!chat) throw new Error('create');
    const file = join(root, 'chats', chat.id, 'chat.json');
    expect(json(file)).toMatchObject({ schemaVersion: BOT_SCHEMA_VERSION.chat, version: 1 });
    const { schemaVersion: _, ...legacy } = json(file);
    put(file, legacy);
    expect(new BotChatStore(join(root, 'chats')).get(chat.id)).toEqual(chat);
    put(file, { ...legacy, schemaVersion: BOT_SCHEMA_VERSION.chat + 1 });
    expect(new BotChatStore(join(root, 'chats')).get(chat.id)).toBeUndefined();
  });

  it('routines.json: stamps the file, reads legacy files, ignores newer schemas', () => {
    const store = new BotRoutineStore(join(root, 'bots'));
    const saved = store.save(A, { title: 't', prompt: 'p', schedule: '0 9 * * *', chatId: CHAT });
    if (!saved.ok) throw new Error('save');
    const file = join(root, 'bots', A, 'routines.json');
    expect(json(file)).toMatchObject({ schemaVersion: BOT_SCHEMA_VERSION.routines });
    put(file, { routines: json(file).routines });
    expect(store.list(A)).toEqual([saved.routine]);
    put(file, { schemaVersion: BOT_SCHEMA_VERSION.routines + 1, routines: json(file).routines });
    expect(store.list(A)).toEqual([]);
  });

  it('delegations.jsonl: stamps lines and keeps newer-schema lines through compaction', () => {
    const file = join(root, 'delegations.jsonl');
    const record = {
      id: D1,
      parentConversationId: 'p',
      parentBotId: A,
      targetBotId: B,
      chatId: null,
      task: 't',
      context: '',
      childConversationId: 'c',
      state: 'running' as const,
      depth: 1,
      createdAt: 1,
    };
    const future = JSON.stringify({
      ...record,
      id: D2,
      schemaVersion: BOT_SCHEMA_VERSION.delegation + 1,
    });
    put(file, `${JSON.stringify(record)}\n${future}\n`);
    const store = new DelegationStore(file, { minRedundant: 1 });
    expect(store.get(D1)).toEqual(record);
    expect(store.get(D2)).toBeUndefined();
    for (let i = 0; i < 4; i++) store.save({ ...record, context: `c${i}` });
    const lines = jsonLines(file);
    expect(lines.some((line) => line.id === D2)).toBe(true);
    expect(lines.filter((line) => line.id === D1).at(-1)).toMatchObject({
      schemaVersion: BOT_SCHEMA_VERSION.delegation,
      context: 'c3',
    });
  });

  it('tasks.jsonl: stamps snapshots, reads legacy lines, keeps newer-schema lines', () => {
    const store = new GroupTaskStore(root, { minRedundant: 1 });
    const task = store.create(CHAT, { title: 'a', createdBy: 'human' }, 1);
    if (!task) throw new Error('create');
    const file = join(root, CHAT, 'tasks.jsonl');
    expect(jsonLines(file)[0]).toMatchObject({ schemaVersion: BOT_SCHEMA_VERSION.task });
    const { schemaVersion: _, ...legacy } = jsonLines(file)[0];
    const future = { ...legacy, id: D2, seq: 2, schemaVersion: BOT_SCHEMA_VERSION.task + 1 };
    put(file, `${JSON.stringify(legacy)}\n${JSON.stringify(future)}\n`);
    const reloaded = new GroupTaskStore(root, { minRedundant: 1 });
    expect(reloaded.list(CHAT)).toEqual([task]);
    for (let i = 0; i < 4; i++) reloaded.save(CHAT, { ...task, updatedAt: 2 + i });
    expect(jsonLines(file).some((line) => line.id === D2)).toBe(true);
    expect(reloaded.create(CHAT, { title: 'b', createdBy: 'human' }, 9)?.seq).toBe(3);
  });
});
