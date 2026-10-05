import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotChatStore } from './chatStore';

const BOT_A = '11111111-1111-4111-8111-111111111111';
const BOT_B = '22222222-2222-4222-8222-222222222222';

let root: string;
let store: BotChatStore;
let clock = 1000;
const now = () => ++clock;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bot-chats-'));
  store = new BotChatStore(root, now);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function group() {
  const created = store.create({
    kind: 'group',
    title: '发布小组',
    members: [BOT_A, BOT_B],
    bossBotId: BOT_A,
    workspace: { kind: 'project', projectId: 'p1' },
  });
  if (!created) throw new Error('create failed');
  return created;
}

describe('BotChatStore chats', () => {
  it('creates, reloads and rejects invalid chats', () => {
    const chat = group();
    expect(chat).toMatchObject({
      routing: { mode: 'smart', maxHops: 4, maxTurnsPerBot: 2 },
      sessions: {},
      version: 1,
    });
    expect(new BotChatStore(root, now).get(chat.id)).toEqual(chat);
    expect(
      store.create({
        kind: 'group',
        title: 'x',
        members: [BOT_A],
        bossBotId: BOT_A,
        workspace: { kind: 'project', projectId: 'p' },
      })
    ).toBeUndefined();
  });

  it('updates through a validated mutation and bumps version', () => {
    const boss = store.create({
      kind: 'group',
      title: 'x',
      members: [BOT_A, BOT_B],
      bossBotId: BOT_A,
      workspace: { kind: 'project', projectId: 'p' },
      routing: { mode: 'boss' },
    });
    expect(boss?.routing.mode).toBe('boss');
    const chat = group();
    const updated = store.update(chat.id, (draft) => ({
      ...draft,
      sessions: { [BOT_A]: { conversationId: 'c1', cursor: 2 } },
    }));
    expect(updated).toMatchObject({
      version: 2,
      sessions: { [BOT_A]: { conversationId: 'c1', cursor: 2 } },
    });
    expect(store.update(chat.id, (draft) => ({ ...draft, members: [BOT_A] }))).toBeUndefined();
    expect(store.get(chat.id)?.members).toEqual([BOT_A, BOT_B]);
    expect(store.update(chat.id, (draft) => ({ ...draft, id: 'other' }))).toBeUndefined();
  });

  it('removes the chat directory', () => {
    const chat = group();
    store.appendEntry(chat.id, { id: 'e1', at: 1, kind: 'system', text: 'hi' });
    expect(store.remove(chat.id)).toBe(true);
    expect(store.get(chat.id)).toBeUndefined();
    expect(store.readEntries(chat.id)).toEqual([]);
  });
});

describe('BotChatStore timeline', () => {
  it('assigns increasing seq that survives restart', () => {
    const chat = group();
    const first = store.appendEntry(chat.id, {
      id: 'e1',
      at: 1,
      kind: 'human',
      text: 'hi',
      mentions: [],
    });
    const second = store.appendEntry(chat.id, { id: 'e2', at: 2, kind: 'system', text: 'x' });
    expect([first?.seq, second?.seq]).toEqual([1, 2]);

    const reloaded = new BotChatStore(root, now);
    expect(reloaded.lastSeq(chat.id)).toBe(2);
    expect(reloaded.appendEntry(chat.id, { id: 'e3', at: 3, kind: 'system', text: 'y' })?.seq).toBe(
      3
    );
  });

  it('rejects invalid entries and unknown chats', () => {
    const chat = group();
    expect(
      store.appendEntry(chat.id, { id: '', at: 1, kind: 'system', text: 'x' })
    ).toBeUndefined();
    expect(
      store.appendEntry('77777777-7777-4777-8777-777777777777', {
        id: 'e',
        at: 1,
        kind: 'system',
        text: 'x',
      })
    ).toBeUndefined();
    expect(store.lastSeq(chat.id)).toBe(0);
  });

  it('tolerates corrupt and truncated lines', () => {
    const chat = group();
    store.appendEntry(chat.id, { id: 'e1', at: 1, kind: 'system', text: 'a' });
    appendFileSync(
      join(root, chat.id, 'timeline.jsonl'),
      'garbage\n{"seq":2,"id":"e2","at":2,"kind":"sys'
    );

    const reloaded = new BotChatStore(root, now);
    expect(reloaded.lastSeq(chat.id)).toBe(1);
    expect(reloaded.appendEntry(chat.id, { id: 'e3', at: 3, kind: 'system', text: 'c' })?.seq).toBe(
      2
    );
    expect(reloaded.readEntries(chat.id).map((entry) => entry.id)).toEqual(['e1', 'e3']);
  });

  it('pages backwards by seq', () => {
    const chat = group();
    for (let i = 1; i <= 5; i++)
      store.appendEntry(chat.id, { id: `e${i}`, at: i, kind: 'system', text: String(i) });
    expect(store.readEntries(chat.id, { limit: 2 }).map((entry) => entry.seq)).toEqual([4, 5]);
    expect(
      store.readEntries(chat.id, { beforeSeq: 4, limit: 2 }).map((entry) => entry.seq)
    ).toEqual([2, 3]);
    expect(
      store.readEntries(chat.id, { beforeSeq: 2, limit: 10 }).map((entry) => entry.seq)
    ).toEqual([1]);
  });

  it('reads across chunk boundaries with multi-byte text and a torn tail', () => {
    const small = new BotChatStore(root, now, { chunkSize: 7 });
    const chat = small.create({
      kind: 'group',
      title: 't',
      members: [BOT_A, BOT_B],
      bossBotId: BOT_A,
      workspace: { kind: 'project', projectId: 'p' },
    });
    if (!chat) throw new Error('create failed');
    for (let i = 1; i <= 6; i++)
      small.appendEntry(chat.id, { id: `e${i}`, at: i, kind: 'system', text: `中文消息${i}🙂` });
    appendFileSync(join(root, chat.id, 'timeline.jsonl'), '{"seq":7,"id":"e7","at":7,"ki');
    const reloaded = new BotChatStore(root, now, { chunkSize: 5 });
    expect(reloaded.lastSeq(chat.id)).toBe(6);
    expect(
      reloaded
        .readEntries(chat.id, { limit: 3 })
        .map((entry) => entry.kind === 'system' && entry.text)
    ).toEqual(['中文消息4🙂', '中文消息5🙂', '中文消息6🙂']);
    expect(reloaded.readAfter(chat.id, 4).map((entry) => entry.seq)).toEqual([5, 6]);
    expect(reloaded.appendEntry(chat.id, { id: 'e8', at: 8, kind: 'system', text: 'x' })?.seq).toBe(
      7
    );
    expect(reloaded.readEntries(chat.id, { limit: 2 }).map((entry) => entry.id)).toEqual([
      'e6',
      'e8',
    ]);
  });

  it('reads only entries after a seq, falling back to the latest page when the gap is too large', () => {
    const chat = group();
    for (let i = 1; i <= 8; i++)
      store.appendEntry(chat.id, { id: `e${i}`, at: i, kind: 'system', text: String(i) });
    expect(store.readSince(chat.id, 6, 3).map((entry) => entry.seq)).toEqual([7, 8]);
    expect(store.readSince(chat.id, 8, 3)).toEqual([]);
    expect(store.readSince(chat.id, 1, 3).map((entry) => entry.seq)).toEqual([6, 7, 8]);
  });

  it('indexes entry ids for dedupe and lookup, surviving restart and appends', () => {
    const chat = group();
    store.appendEntry(chat.id, { id: 'delegation:d1', at: 1, kind: 'system', text: 'a' });
    store.appendEntry(chat.id, { id: 'e2', at: 2, kind: 'system', text: 'b' });
    expect(store.hasEntry(chat.id, 'delegation:d1')).toBe(true);
    expect(store.hasEntry(chat.id, 'nope')).toBe(false);
    store.appendEntry(chat.id, { id: 'e3', at: 3, kind: 'system', text: 'c' });
    expect(store.findEntry(chat.id, 'e3')).toMatchObject({ seq: 3, text: 'c' });

    const reloaded = new BotChatStore(root, now);
    expect(reloaded.hasEntry(chat.id, 'delegation:d1')).toBe(true);
    expect(reloaded.findEntry(chat.id, 'e2')).toMatchObject({ seq: 2, text: 'b' });
    expect(reloaded.findEntry(chat.id, 'missing')).toBeUndefined();
    reloaded.appendEntry(chat.id, { id: 'e4', at: 4, kind: 'system', text: 'd' });
    expect(reloaded.findEntry(chat.id, 'e4')).toMatchObject({ seq: 4 });
  });

  it('builds the dedupe index only after the new-conversation divider; old lookups still work', () => {
    const small = new BotChatStore(root, now, { chunkSize: 11 });
    const chat = small.create({
      kind: 'group',
      title: 't',
      members: [BOT_A, BOT_B],
      bossBotId: BOT_A,
      workspace: { kind: 'project', projectId: 'p' },
    });
    if (!chat) throw new Error('create failed');
    for (let i = 1; i <= 5; i++)
      small.appendEntry(chat.id, { id: `e${i}`, at: i, kind: 'system', text: `旧${i}` });
    small.update(chat.id, (draft) => ({ ...draft, epochSeq: 3 }));

    const reloaded = new BotChatStore(root, now, { chunkSize: 11 });
    expect(reloaded.get(chat.id)?.epochSeq).toBe(3);
    expect(reloaded.hasEntry(chat.id, 'e5')).toBe(true);
    expect(reloaded.hasEntry(chat.id, 'e4')).toBe(true);
    expect(reloaded.hasEntry(chat.id, 'e3')).toBe(false);
    expect(reloaded.hasEntry(chat.id, 'e1')).toBe(false);
    expect(reloaded.findEntry(chat.id, 'e2')).toMatchObject({ seq: 2, text: '旧2' });
    expect(reloaded.findEntry(chat.id, 'e3')).toMatchObject({ seq: 3 });
    expect(reloaded.hasEntry(chat.id, 'e1')).toBe(true);
    reloaded.appendEntry(chat.id, { id: 'e6', at: 6, kind: 'system', text: 'x' });
    expect(reloaded.findEntry(chat.id, 'e6')).toMatchObject({ seq: 6 });
    expect(reloaded.findEntry(chat.id, 'missing')).toBeUndefined();
  });

  it('reads backward down to a lower bound', () => {
    const chat = group();
    for (let i = 1; i <= 6; i++)
      store.appendEntry(chat.id, { id: `e${i}`, at: i, kind: 'system', text: String(i) });
    expect([...store.backward(chat.id, undefined, 3)].map((e) => e.seq)).toEqual([6, 5, 4]);
    expect([...store.backward(chat.id, undefined, 6)]).toEqual([]);
    expect(store.readAfter(chat.id, 4).map((e) => e.seq)).toEqual([5, 6]);
  });

  it('scans the whole timeline asynchronously in batches', async () => {
    const chat = group();
    for (let i = 1; i <= 5; i++)
      store.appendEntry(chat.id, { id: `e${i}`, at: i, kind: 'system', text: String(i) });
    const seqs: number[] = [];
    for await (const batch of store.scanEntries(chat.id)) seqs.push(...batch.map((e) => e.seq));
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  it('deep pages stay identical once seq checkpoints are learned', () => {
    const small = new BotChatStore(root, now, { chunkSize: 97 });
    const chat = small.create({
      kind: 'group',
      title: 't',
      members: [BOT_A, BOT_B],
      bossBotId: BOT_A,
      workspace: { kind: 'project', projectId: 'p' },
    });
    if (!chat) throw new Error('create failed');
    for (let i = 1; i <= 700; i++)
      small.appendEntry(chat.id, { id: `e${i}`, at: i, kind: 'system', text: `第${i}条` });
    const page = (store: BotChatStore, beforeSeq: number) =>
      store.readEntries(chat.id, { beforeSeq, limit: 7 }).map((entry) => entry.seq);
    // 先整段倒读一遍，学到检查点
    expect(small.readEntries(chat.id, { limit: 1000 })).toHaveLength(700);
    for (const before of [701, 700, 513, 512, 511, 257, 256, 129, 128, 8, 2, 1])
      expect(page(small, before)).toEqual(page(new BotChatStore(root, now), before));
    small.appendEntry(chat.id, { id: 'tail', at: 1, kind: 'system', text: 'x' });
    expect(page(small, 702)).toEqual([695, 696, 697, 698, 699, 700, 701]);
    expect(page(small, 300)).toEqual([293, 294, 295, 296, 297, 298, 299]);
  });

  it('tail-reads a 50k-entry timeline without loading it all', () => {
    const chat = group();
    const file = join(root, chat.id, 'timeline.jsonl');
    const lines: string[] = [];
    for (let seq = 1; seq <= 50_000; seq++)
      lines.push(
        JSON.stringify({
          seq,
          id: `e${seq}`,
          at: seq,
          kind: 'system',
          text: `消息 ${seq} `.repeat(8),
        })
      );
    writeFileSync(file, `${lines.join('\n')}\n`);
    const reloaded = new BotChatStore(root, now);
    const started = performance.now();
    expect(reloaded.lastSeq(chat.id)).toBe(50_000);
    expect(reloaded.readEntries(chat.id, { limit: 50 }).map((e) => e.seq)).toEqual(
      Array.from({ length: 50 }, (_, i) => 49_951 + i)
    );
    expect(
      reloaded.readEntries(chat.id, { beforeSeq: 49_901, limit: 2 }).map((e) => e.seq)
    ).toEqual([49_899, 49_900]);
    expect(reloaded.readAfter(chat.id, 49_990)).toHaveLength(10);
    expect(
      reloaded.appendEntry(chat.id, { id: 'new', at: 1, kind: 'system', text: 'x' })?.seq
    ).toBe(50_001);
    const tail = performance.now() - started;
    const fullStarted = performance.now();
    expect(reloaded.readEntries(chat.id, { beforeSeq: 3, limit: 5 }).map((e) => e.seq)).toEqual([
      1, 2,
    ]);
    const full = performance.now() - fullStarted;
    // 绝对上界留给负载较高的 CI；相对上界确认尾部读取不随文件大小增长
    expect(tail).toBeLessThan(500);
    expect(tail * 5).toBeLessThan(full);
    expect(reloaded.findEntry(chat.id, 'e123')).toMatchObject({ seq: 123 });
  });
});
