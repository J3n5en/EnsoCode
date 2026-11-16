import { applyConversationsPatch, diffConversations } from '@shared/conversationsPatch';
import { IPC_CHANNELS } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakePeer {
  id: number;
  kind: 'main';
  sent: Array<Record<string, unknown>>;
  signals: string[];
  send: (channel: string, payload?: unknown) => void;
}

const peers = vi.hoisted(() => ({ local: null as unknown, remote: [] as unknown[] }));

vi.mock('../renderers', () => ({ localMainContents: () => peers.local }));
vi.mock('./senders', () => ({ remoteSenders: () => peers.remote }));

let nextId = 1;
function peer(): FakePeer {
  const sent: Array<Record<string, unknown>> = [];
  const signals: string[] = [];
  return {
    id: nextId++,
    kind: 'main',
    sent,
    signals,
    send: (channel, payload) => {
      if (channel === IPC_CHANNELS.CONVERSATIONS_PATCH)
        sent.push(payload as Record<string, unknown>);
      else signals.push(channel);
    },
  };
}

type Row = Record<string, unknown>;
interface Blob {
  state: { conversations: Record<string, Row>; order: string[]; activeId: string | null };
  version: number;
}

const row = (id: string, extra: Row = {}): Row => ({ id, projectId: 'p', title: id, ...extra });
const blob = (conversations: Record<string, Row>, order: string[]): Blob => ({
  state: { conversations, order, activeId: order[0] ?? null },
  version: 3,
});
const insert = (id: string, order: string[]) => ({
  upserts: { [id]: { set: row(id), unset: [] } },
  removes: [],
  order,
});

let sync: typeof import('./conversationSync');

beforeEach(async () => {
  peers.local = null;
  peers.remote = [];
  vi.resetModules();
  sync = await import('./conversationSync');
});

describe('会话账本', () => {
  it('单主界面写回时 activeId 与 version 随写回落盘', () => {
    const desktop = peer();
    peers.local = desktop;
    const disk = blob({ a: row('a'), b: row('b') }, ['a', 'b']);
    sync.readConversationsFor(desktop, disk);
    const value = { ...disk, state: { ...disk.state, activeId: 'b' } };
    const merged = sync.mergeConversationsWrite(desktop, disk, value, 0) as Blob;
    expect(merged.state.activeId).toBe('b');

    const solo = peer();
    peers.local = solo;
    const first = sync.mergeConversationsWrite(solo, undefined, value, 0) as Blob;
    expect(first.version).toBe(3);
    expect(first.state.activeId).toBe('b');
  });

  it('多主界面时远端写回不改磁盘上的 activeId', () => {
    const desktop = peer();
    const phone = peer();
    peers.local = desktop;
    peers.remote = [phone];
    const disk = blob({ a: row('a'), b: row('b') }, ['a', 'b']);
    sync.readConversationsFor(phone, disk);
    const value = { ...disk, state: { ...disk.state, activeId: 'b' } };
    const merged = sync.mergeConversationsWrite(phone, disk, value, 0) as Blob;
    expect(merged.state.activeId).toBe('a');
  });

  it('Main 插入的行不会被 renderer 的旧值写回抹掉', () => {
    const desktop = peer();
    peers.local = desktop;
    const disk = blob({ a: row('a') }, ['a']);
    expect(sync.readConversationsFor(desktop, disk)).toEqual({ value: disk, seq: 0 });

    const inserted = sync.applyMainConversationsPatch(disk, insert('m', ['m', 'a']));
    expect(desktop.sent).toEqual([{ ...insert('m', ['m', 'a']), seq: 1 }]);

    expect(sync.mergeConversationsWrite(desktop, inserted, disk, 0)).toEqual(inserted);
  });

  it('先回放已确认的补丁再求差量，renderer 的删除才会落到磁盘', () => {
    const desktop = peer();
    peers.local = desktop;
    const disk = blob({ a: row('a') }, ['a']);
    sync.readConversationsFor(desktop, disk);
    const inserted = sync.applyMainConversationsPatch(disk, insert('m', ['m', 'a']));
    const acked = (desktop.sent[0] as { seq: number }).seq;

    const merged = sync.mergeConversationsWrite(desktop, inserted, disk, acked) as Blob;
    expect(merged.state.conversations).toEqual({ a: row('a') });
    expect(merged.state.order).toEqual(['a']);
  });

  it('两个主界面并发写入的结果与单端顺序写入一致', () => {
    const desktop = peer();
    const browser = peer();
    peers.local = desktop;
    peers.remote = [browser];
    const disk = blob({ a: row('a') }, ['a']);
    sync.readConversationsFor(desktop, disk);
    sync.readConversationsFor(browser, disk);
    const desktopValue = blob({ a: row('a'), d: row('d') }, ['d', 'a']);
    const browserValue = blob({ a: row('a'), r: row('r') }, ['r', 'a']);

    const afterDesktop = sync.mergeConversationsWrite(desktop, disk, desktopValue, 0);
    const afterBrowser = sync.mergeConversationsWrite(browser, afterDesktop, browserValue, 0);

    const sequential = applyConversationsPatch(
      applyConversationsPatch(disk, diffConversations(disk, desktopValue)),
      diffConversations(disk, browserValue)
    );
    expect(afterBrowser).toEqual(sequential);
    expect(Object.keys((afterBrowser as Blob).state.conversations).sort()).toEqual(['a', 'd', 'r']);
  });

  it('单主界面时只合并差量，Main 期间插入的行保留', () => {
    const desktop = peer();
    peers.local = desktop;
    const disk = blob({ a: row('a') }, ['a']);
    sync.readConversationsFor(desktop, disk);
    const inserted = sync.applyMainConversationsPatch(disk, insert('m', ['m', 'a']));

    const merged = sync.mergeConversationsWrite(
      desktop,
      inserted,
      blob({ a: row('a', { pinned: true }) }, ['a']),
      0
    ) as Blob;
    expect(merged.state.conversations.m).toEqual(row('m'));
    expect(merged.state.conversations.a.pinned).toBe(true);
    expect(merged.state.order).toEqual(['m', 'a']);
  });

  it('conversations:read 重置账本，未确认的补丁不再回放', () => {
    const desktop = peer();
    peers.local = desktop;
    const disk = blob({ a: row('a') }, ['a']);
    sync.readConversationsFor(desktop, disk);
    const inserted = sync.applyMainConversationsPatch(disk, insert('m', ['m', 'a']));

    const reread = sync.readConversationsFor(desktop, inserted);
    expect(reread).toEqual({ value: inserted, seq: 1 });

    const second = sync.applyMainConversationsPatch(inserted, insert('n', ['n', 'm', 'a']));
    expect(sync.mergeConversationsWrite(desktop, second, inserted, reread.seq)).toEqual(second);
  });

  it('settings:read 只在账本缺失时建账，不重置已有账本', () => {
    const desktop = peer();
    peers.local = desktop;
    const disk = blob({ a: row('a') }, ['a']);
    sync.readConversationsFor(desktop, disk);
    const inserted = sync.applyMainConversationsPatch(disk, insert('m', ['m', 'a']));

    sync.noteConversationsRead(desktop, inserted);
    const merged = sync.mergeConversationsWrite(desktop, inserted, disk, 0) as Blob;
    expect(merged.state.conversations.m).toEqual(row('m'));
  });

  it('写回合并后通知监听者，取消订阅后不再通知', () => {
    const desktop = peer();
    peers.local = desktop;
    const disk = blob({ a: row('a') }, ['a']);
    sync.readConversationsFor(desktop, disk);
    const seen: unknown[] = [];
    const off = sync.onConversationsMerged((patch) => seen.push(patch));

    const pinned = blob({ a: row('a', { pinned: true }) }, ['a']);
    sync.mergeConversationsWrite(desktop, disk, pinned, 0);
    expect(seen).toEqual([diffConversations(disk, pinned)]);

    off();
    sync.mergeConversationsWrite(desktop, pinned, disk, 1);
    expect(seen).toHaveLength(1);
  });

  it('多 renderer 时空写入不清空磁盘会话表，并要求写回方重读', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const desktop = peer();
    const browser = peer();
    peers.local = desktop;
    peers.remote = [browser];
    const disk = blob({ a: row('a') }, ['a']);
    sync.readConversationsFor(desktop, disk);
    sync.noteConversationsRead(browser, disk);

    const merged = sync.mergeConversationsWrite(browser, disk, blob({}, []), 0);

    expect(merged).toBe(disk);
    expect(desktop.sent).toEqual([]);
    expect(desktop.signals).toEqual([]);
    expect(browser.signals).toEqual([IPC_CHANNELS.CONVERSATIONS_RESYNC]);
    expect(String(warn.mock.calls[0]?.[0])).toContain('拒绝整表删除写入');
    warn.mockRestore();
  });

  it('P2：空表加 1 行的写回删光磁盘其余会话时同样拒收', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const desktop = peer();
    const browser = peer();
    peers.local = desktop;
    peers.remote = [browser];
    const disk = blob({ a: row('a'), b: row('b'), c: row('c') }, ['a', 'b', 'c']);
    sync.readConversationsFor(desktop, disk);
    sync.readConversationsFor(browser, disk);
    const seen: unknown[] = [];
    const off = sync.onConversationsMerged((patch) => seen.push(patch));

    const merged = sync.mergeConversationsWrite(browser, disk, blob({ x: row('x') }, ['x']), 0);
    off();

    expect(merged).toBe(disk);
    expect(desktop.sent).toEqual([]);
    expect(seen).toEqual([]);
    expect(browser.signals).toEqual([IPC_CHANNELS.CONVERSATIONS_RESYNC]);

    // 重读后基线是磁盘值，同一行再写回只追加 x
    sync.readConversationsFor(browser, disk);
    const resynced = blob({ a: row('a'), b: row('b'), c: row('c'), x: row('x') }, [
      'x',
      'a',
      'b',
      'c',
    ]);
    const after = sync.mergeConversationsWrite(browser, disk, resynced, 0) as Blob;
    expect(Object.keys(after.state.conversations).sort()).toEqual(['a', 'b', 'c', 'x']);
    warn.mockRestore();
  });

  it('结构不合法的写回拒收', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const desktop = peer();
    peers.local = desktop;
    const disk = blob({ a: row('a') }, ['a']);
    sync.readConversationsFor(desktop, disk);

    expect(sync.mergeConversationsWrite(desktop, disk, { version: 3 }, 0)).toBe(disk);
    expect(sync.mergeConversationsWrite(desktop, disk, 'oops', 0)).toBe(disk);
    expect(sync.mergeConversationsWrite(desktop, disk, { state: { conversations: {} } }, 0)).toBe(
      disk
    );
    expect(desktop.signals).toHaveLength(3);
    warn.mockRestore();
  });

  it('只删部分会话的写回照常合并', () => {
    const desktop = peer();
    peers.local = desktop;
    const disk = blob({ a: row('a'), b: row('b') }, ['a', 'b']);
    sync.readConversationsFor(desktop, disk);

    const merged = sync.mergeConversationsWrite(desktop, disk, blob({ b: row('b') }, ['b']), 0);
    expect((merged as Blob).state.order).toEqual(['b']);
    expect(desktop.signals).toEqual([]);
  });

  it('P1：Main 先按 id 删掉最后一个会话，随后的空表写回落盘为空且无幽灵行', () => {
    const desktop = peer();
    peers.local = desktop;
    const disk = blob({ a: row('a') }, ['a']);
    sync.readConversationsFor(desktop, disk);

    const removed = sync.applyMainConversationsPatch(disk, { upserts: {}, removes: ['a'] });
    const merged = sync.mergeConversationsWrite(desktop, removed, blob({}, []), 0) as Blob;

    expect(merged.state.conversations).toEqual({});
    expect(merged.state.order).toEqual([]);
    expect(desktop.signals).toEqual([]);
  });

  it('P3：空基线下 Main 插入未确认、settings 重读后写回，两行都保留', () => {
    const desktop = peer();
    peers.local = desktop;
    const empty = blob({}, []);
    sync.noteConversationsRead(desktop, empty);
    const inserted = sync.applyMainConversationsPatch(empty, insert('m', ['m']));

    sync.noteConversationsRead(desktop, inserted);
    const merged = sync.mergeConversationsWrite(
      desktop,
      inserted,
      blob({ r: row('r') }, ['r']),
      0
    ) as Blob;

    expect(merged.state.order).toEqual(['m', 'r']);
    expect(Object.keys(merged.state.conversations).sort()).toEqual(['m', 'r']);
  });

  it('写入 undefined 删除整个键', () => {
    const desktop = peer();
    peers.local = desktop;
    const disk = blob({ a: row('a') }, ['a']);
    sync.readConversationsFor(desktop, disk);

    expect(sync.mergeConversationsWrite(desktop, disk, undefined, 0)).toBeUndefined();
    expect(desktop.signals).toEqual([]);
  });
});
