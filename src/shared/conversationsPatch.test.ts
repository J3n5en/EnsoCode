import { describe, expect, it } from 'vitest';
import {
  applyConversationsPatch,
  diffConversations,
  isEmptyConversationsPatch,
  parseConversationsPatch,
} from './conversationsPatch';

const blob = (conversations: Record<string, object>, order: string[]) => ({
  state: { conversations, order, activeId: order[0] ?? null },
  version: 3,
});

describe('conversations patch', () => {
  it('diffs field-level changes, removals and order', () => {
    const prev = blob({ a: { id: 'a', title: 'A', pinned: true }, b: { id: 'b', title: 'B' } }, [
      'a',
      'b',
    ]);
    const next = blob({ a: { id: 'a', title: 'A2' }, c: { id: 'c', title: 'C' } }, ['c', 'a']);
    expect(diffConversations(prev, next)).toEqual({
      upserts: {
        a: { set: { title: 'A2' }, unset: ['pinned'] },
        c: { set: { id: 'c', title: 'C' }, unset: [] },
      },
      removes: ['b'],
      order: ['c', 'a'],
    });
  });

  it('produces an empty patch for identical content', () => {
    const value = blob({ a: { id: 'a', goal: { text: 'x' } } }, ['a']);
    expect(isEmptyConversationsPatch(diffConversations(value, structuredClone(value)))).toBe(true);
  });

  it('值为 undefined 的字段按缺省处理：不在两端（结构化克隆 vs JSON）之间来回推整表', () => {
    const disk = blob({ a: { id: 'a', title: 'A' }, b: { id: 'b' } }, ['a', 'b']);
    const ipc = blob(
      { a: { id: 'a', title: 'A', error: undefined }, b: { id: 'b', pinned: undefined } },
      ['a', 'b']
    );
    expect(isEmptyConversationsPatch(diffConversations(disk, ipc))).toBe(true);
    expect(isEmptyConversationsPatch(diffConversations(ipc, disk))).toBe(true);
    expect(
      diffConversations(
        blob({ a: { id: 'a', title: 'A' } }, ['a']),
        blob({ a: { id: 'a', title: undefined } }, ['a'])
      )
    ).toEqual({ upserts: { a: { set: {}, unset: ['title'] } }, removes: [] });
  });

  it('merges concurrent edits from two renderers without losing either', () => {
    const base = blob({ a: { id: 'a', title: 'A' }, b: { id: 'b', title: 'B' } }, ['a', 'b']);
    // 远端新建 r 并改 a 的标题；桌面并发新建 d 并置顶 b
    const remote = diffConversations(
      base,
      blob({ r: { id: 'r' }, a: { id: 'a', title: 'A!' }, b: { id: 'b', title: 'B' } }, [
        'r',
        'a',
        'b',
      ])
    );
    const desktopDisk = blob(
      { d: { id: 'd' }, a: { id: 'a', title: 'A' }, b: { id: 'b', title: 'B', pinned: true } },
      ['d', 'a', 'b']
    );
    const merged = applyConversationsPatch(desktopDisk, remote) as ReturnType<typeof blob>;
    expect(Object.keys(merged.state.conversations).sort()).toEqual(['a', 'b', 'd', 'r']);
    expect(merged.state.conversations.a).toEqual({ id: 'a', title: 'A!' });
    expect(merged.state.conversations.b).toEqual({ id: 'b', title: 'B', pinned: true });
    expect(merged.state.order).toEqual(['d', 'r', 'a', 'b']);
    expect(merged.version).toBe(3);
    expect(merged.state.activeId).toBe('d');
  });

  it('drops removed ids from order and tolerates garbage targets', () => {
    const patch = { upserts: { n: { set: { id: 'n' }, unset: [] } }, removes: ['a'] };
    expect(applyConversationsPatch(undefined, patch)).toEqual({
      state: { conversations: { n: { id: 'n' } }, order: ['n'] },
    });
    const merged = applyConversationsPatch(blob({ a: { id: 'a' } }, ['a']), patch) as ReturnType<
      typeof blob
    >;
    expect(merged.state.order).toEqual(['n']);
  });

  it('ignores partial upserts for conversations missing from the target', () => {
    const base = blob({ a: { id: 'a' } }, ['a']);
    const merged = applyConversationsPatch(base, {
      upserts: { gone: { set: { title: 'renamed' }, unset: [] } },
      removes: [],
    }) as ReturnType<typeof blob>;
    expect(merged.state.conversations).not.toHaveProperty('gone');
    expect(merged.state.order).toEqual(['a']);
  });

  it('does not promote a child conversation into sidebar order', () => {
    const base = blob({ parent: { id: 'parent', title: 'P' } }, ['parent']);
    const patch = diffConversations(
      base,
      blob(
        {
          parent: { id: 'parent', title: 'P' },
          child: { id: 'child', parentId: 'parent', title: 'review' },
        },
        ['parent']
      )
    );
    const merged = applyConversationsPatch(base, patch) as ReturnType<typeof blob>;
    expect(merged.state.conversations.child).toMatchObject({ parentId: 'parent', title: 'review' });
    expect(merged.state.order).toEqual(['parent']);
  });

  it('drops a child already stuck in order instead of keeping it as an unknown extra', () => {
    const disk = blob(
      {
        parent: { id: 'parent', title: 'P' },
        child: { id: 'child', parentId: 'parent', title: 'review' },
      },
      ['child', 'parent']
    );
    const patch = diffConversations(
      blob({ parent: { id: 'parent', title: 'P' } }, ['parent']),
      blob({ parent: { id: 'parent', title: 'P2' } }, ['parent'])
    );
    const merged = applyConversationsPatch(disk, patch) as ReturnType<typeof blob>;
    expect(merged.state.conversations.parent).toMatchObject({ title: 'P2' });
    expect(merged.state.conversations.child).toMatchObject({ parentId: 'parent' });
    expect(merged.state.order).toEqual(['parent']);
  });

  it('parses only well-formed patches', () => {
    expect(parseConversationsPatch({ upserts: {}, removes: [] })).toEqual({
      upserts: {},
      removes: [],
      seq: 0,
    });
    expect(parseConversationsPatch({ upserts: { a: { set: 1 } }, removes: [] })).toBeNull();
    expect(parseConversationsPatch(null)).toBeNull();
  });

  it('parses the sequence number Main attaches to a pushed patch', () => {
    expect(parseConversationsPatch({ upserts: {}, removes: [], seq: 4 })).toEqual({
      upserts: {},
      removes: [],
      seq: 4,
    });
    expect(parseConversationsPatch({ upserts: {}, removes: [], seq: -1 })?.seq).toBe(0);
    expect(parseConversationsPatch({ upserts: {}, removes: [], seq: 1.5 })?.seq).toBe(0);
    expect(parseConversationsPatch({ upserts: {}, removes: [], seq: 'x' })?.seq).toBe(0);
  });
});
