import { describe, expect, it, vi } from 'vitest';
import { applyConversationsPatchToState } from './remotePatch';
import { setPairViewedSession } from './unread';

type Row = Record<string, unknown>;
const row = (id: string, extra: Row = {}): Row => ({
  id,
  projectId: 'p',
  title: id,
  started: false,
  status: 'idle',
  messages: [],
  createdAt: 1,
  ...extra,
});

const state = (conversations: Record<string, Row>, order: string[], activeId: string | null) => ({
  conversations,
  order,
  activeId,
  unrelated: 1,
});

describe('applyConversationsPatchToState', () => {
  it('merges only non-runtime fields into existing conversations', () => {
    const messages = [{ role: 'user', text: 'hi' }];
    const before = state(
      { a: row('a', { started: true, status: 'running', messages, pinned: true }) },
      ['a'],
      'a'
    );
    const next = applyConversationsPatchToState(before, {
      upserts: {
        a: {
          set: { title: 'renamed', status: 'idle', started: false, messages: [] },
          unset: ['pinned', 'error'],
        },
      },
      removes: [],
    });
    expect(next.conversations.a).toEqual({
      ...row('a', { started: true, status: 'running', messages }),
      title: 'renamed',
    });
    expect(next.conversations.a.messages).toBe(messages);
    expect(next.order).toEqual(['a']);
  });

  it('keeps runtime keys listed in unset', () => {
    const before = state({ a: row('a', { error: 'boom' }) }, ['a'], 'a');
    const next = applyConversationsPatchToState(before, {
      upserts: { a: { set: {}, unset: ['error'] } },
      removes: [],
    });
    expect(next.conversations.a.error).toBe('boom');
  });

  it('inserts new conversations as persisted rows and prepends them to order', () => {
    const before = state({ a: row('a') }, ['a'], 'a');
    const incoming = row('b', { title: 'remote' });
    const next = applyConversationsPatchToState(before, {
      upserts: { b: { set: incoming, unset: [] } },
      removes: [],
    });
    expect(next.conversations.b).toEqual(incoming);
    expect(next.order).toEqual(['b', 'a']);
    expect(next.activeId).toBe('a');
  });

  it('ignores partial patches for conversations this renderer does not have', () => {
    const before = state({ a: row('a') }, ['a'], 'a');
    const next = applyConversationsPatchToState(before, {
      upserts: { gone: { set: { title: 'renamed', lastActiveAt: 2 }, unset: [] } },
      removes: [],
    });
    expect(next.conversations).not.toHaveProperty('gone');
    expect(next.order).toEqual(['a']);
  });

  it('gives new conversations an empty messages list when the row lacks one', () => {
    const incoming: Row = { ...row('b') };
    delete incoming.messages;
    const next = applyConversationsPatchToState(state({}, [], null), {
      upserts: { b: { set: incoming, unset: [] } },
      removes: [],
    });
    expect(next.conversations.b.messages).toEqual([]);
  });

  it('removes conversations and moves activeId to the next in order', () => {
    const before = state({ a: row('a'), b: row('b'), c: row('c') }, ['a', 'b', 'c'], 'a');
    const next = applyConversationsPatchToState(before, { upserts: {}, removes: ['a'] });
    expect(Object.keys(next.conversations)).toEqual(['b', 'c']);
    expect(next.order).toEqual(['b', 'c']);
    expect(next.activeId).toBe('b');

    const kept = applyConversationsPatchToState(before, { upserts: {}, removes: ['c'] });
    expect(kept.activeId).toBe('a');

    const empty = applyConversationsPatchToState(state({ a: row('a') }, ['a'], 'a'), {
      upserts: {},
      removes: ['a'],
    });
    expect(empty.activeId).toBeNull();
  });

  it('applies patch order while keeping local-only conversations such as btw', () => {
    const before = state(
      { a: row('a'), b: row('b'), btw: row('btw', { btwParentId: 'a' }) },
      ['btw', 'a', 'b'],
      'a'
    );
    const next = applyConversationsPatchToState(before, {
      upserts: {},
      removes: [],
      order: ['b', 'a', 'gone'],
    });
    expect(next.order).toEqual(['btw', 'b', 'a']);
  });

  it('本端正在看的会话不接收其他主界面标的未读', () => {
    const before = state(
      { a: row('a', { status: 'running' }), b: row('b', { status: 'running' }) },
      ['a', 'b'],
      'a'
    );
    const next = applyConversationsPatchToState(before, {
      upserts: {
        a: { set: { unread: true, lastActiveAt: 5 }, unset: [] },
        b: { set: { unread: true }, unset: [] },
      },
      removes: [],
    });
    expect(next.conversations.a.unread).toBe(false);
    expect(next.conversations.a.lastActiveAt).toBe(5);
    expect(next.conversations.b.unread).toBe(true);
  });

  it('重同步的整行补丁同样不把正在看的会话标未读', () => {
    const before = state({ a: row('a') }, ['a'], 'a');
    const next = applyConversationsPatchToState(before, {
      upserts: { a: { set: row('a', { unread: true }), unset: [] } },
      removes: [],
    });
    expect(next.conversations.a.unread).toBe(false);
  });

  it('手机正在订阅的会话同样视为已读', () => {
    setPairViewedSession('b');
    const before = state({ a: row('a'), b: row('b') }, ['a', 'b'], 'a');
    const next = applyConversationsPatchToState(before, {
      upserts: { b: { set: { unread: true }, unset: [] } },
      removes: [],
    });
    setPairViewedSession(null);
    expect(next.conversations.b.unread).toBe(false);
  });

  it('加上和删掉 queuedStart 都进 store', () => {
    const queued = { queuedAt: 1, text: 'first' };
    const added = applyConversationsPatchToState(state({ a: row('a') }, ['a'], 'a'), {
      upserts: { a: { set: { queuedStart: queued }, unset: [] } },
      removes: [],
    });
    expect(added.conversations.a.queuedStart).toEqual(queued);
    const removed = applyConversationsPatchToState(added, {
      upserts: { a: { set: {}, unset: ['queuedStart'] } },
      removes: [],
    });
    expect(removed.conversations.a.queuedStart).toBeUndefined();
    expect('queuedStart' in removed.conversations.a).toBe(false);
  });
});

describe('会话补丁确认号与水合缓存', () => {
  const load = async () => {
    vi.resetModules();
    return import('./remotePatch');
  };
  const insert = (id: string, seq: number) => ({
    upserts: { [id]: { set: row(id), unset: [] } },
    removes: [],
    seq,
  });

  it('水合前的补丁先缓存，水合后按序应用', async () => {
    const mod = await load();
    expect(mod.queueConversationsPatch(insert('b', 1))).toBeNull();
    expect(mod.queueConversationsPatch(insert('c', 2))).toBeNull();

    const buffered = mod.flushBufferedConversationsPatches();
    expect(buffered.map((patch) => patch.seq)).toEqual([1, 2]);
    let state: { conversations: Record<string, Row>; order: string[]; activeId: string | null } = {
      conversations: { a: row('a') },
      order: ['a'],
      activeId: 'a',
    };
    for (const patch of buffered) state = mod.applySequencedConversationsPatch(state, patch);
    expect(Object.keys(state.conversations).sort()).toEqual(['a', 'b', 'c']);
    expect(mod.conversationsAppliedSeq()).toBe(2);
    expect(mod.flushBufferedConversationsPatches()).toEqual([]);
  });

  it('水合后的补丁直接返回，确认号只增不减', async () => {
    const mod = await load();
    mod.flushBufferedConversationsPatches();
    mod.resetConversationsAppliedSeq(7);
    expect(mod.conversationsAppliedSeq()).toBe(7);

    const patch = mod.queueConversationsPatch(insert('b', 9));
    expect(patch?.seq).toBe(9);
    mod.applySequencedConversationsPatch({ conversations: {}, order: [], activeId: null }, patch!);
    expect(mod.conversationsAppliedSeq()).toBe(9);

    mod.applySequencedConversationsPatch(
      { conversations: {}, order: [], activeId: null },
      { upserts: {}, removes: [], seq: 8 }
    );
    expect(mod.conversationsAppliedSeq()).toBe(9);
  });

  it('序号不大于已确认号时直接忽略旧补丁并返回原 state 引用', async () => {
    const mod = await load();
    mod.flushBufferedConversationsPatches();
    mod.resetConversationsAppliedSeq(9);

    const state = {
      conversations: { a: row('a') },
      order: ['a'],
      activeId: 'a',
    };
    const next = mod.applySequencedConversationsPatch(state, {
      upserts: { b: { set: row('b'), unset: [] } },
      removes: ['a'],
      order: ['b'],
      seq: 8,
    });
    expect(next).toBe(state);
    expect(mod.conversationsAppliedSeq()).toBe(9);
  });
});
