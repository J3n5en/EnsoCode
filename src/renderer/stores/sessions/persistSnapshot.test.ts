import { describe, expect, it } from 'vitest';
import { cachedPartializeSessions } from './persistSnapshot';

const conv = (id: string, extra: { title?: string; text?: string } = {}) => ({
  id,
  projectId: 'p',
  title: extra.title ?? id,
  started: true,
  spawning: false,
  createdAt: 1,
  sessionFile: '/tmp/a.jsonl',
  historyLoading: true,
  status: 'running' as const,
  messages: [
    { timestamp: 10, role: 'assistant', content: [{ type: 'text', text: extra.text ?? 'x' }] },
  ],
  commands: [{ name: 'x' }],
  customEntries: [1],
  lastSeq: 99,
  lastOutputAt: 8,
});

describe('cachedPartializeSessions', () => {
  it('preserves empty worktree drafts and their names across serialization', () => {
    const worktree = {
      conversationId: 'a',
      projectId: 'p',
      repoPath: '/repo',
      path: '/managed/a',
      branch: 'enso/a',
      baseBranch: 'main',
      baseCommit: 'abc',
      createdAt: 1,
      name: 'Feature',
    };
    const persisted = cachedPartializeSessions({
      conversations: {
        a: {
          ...conv('a'),
          title: '',
          started: false,
          sessionFile: undefined,
          messages: [],
          worktree,
        },
      },
      order: ['a'],
      activeId: 'a',
    });
    const restored = JSON.parse(JSON.stringify(persisted));
    expect(restored.conversations.a.worktree).toEqual(worktree);
    expect(restored.conversations.a.messages).toEqual([]);
    expect(restored.order).toEqual(['a']);
    expect(restored.activeId).toBe('a');
  });

  it('静音标记随会话元数据保留，取消后不再留下', () => {
    const muted = cachedPartializeSessions({
      conversations: { a: { ...conv('a'), muted: true } },
      order: ['a'],
      activeId: 'a',
    });
    expect(muted.conversations.a.muted).toBe(true);
    expect(muted.conversations.a.messages).toEqual([]);
    const cleared = cachedPartializeSessions({
      conversations: { a: { ...conv('a') } },
      order: ['a'],
      activeId: 'a',
    });
    expect(cleared.conversations.a.muted).toBeUndefined();
  });
  it('strips messages and returns the same object when only transcript changes', () => {
    const first = cachedPartializeSessions({
      conversations: { a: conv('a', { text: 'one' }) },
      order: ['a'],
      activeId: 'a',
    });
    const second = cachedPartializeSessions({
      conversations: { a: conv('a', { text: 'two' }) },
      order: ['a'],
      activeId: 'a',
    });
    expect(first).toBe(second);
    expect(first.conversations.a.messages).toEqual([]);
    expect(first.conversations.a.lastActiveAt).toBe(10);
    expect(first.conversations.a.status).toBe('idle');
    expect(first.conversations.a.toolOutputs).toEqual({});
    expect(first.conversations.a.toolStartedAt).toEqual({});
    expect(first.conversations.a.historyLoading).toBeUndefined();
  });

  it('rebuilds when a persisted field changes', () => {
    const first = cachedPartializeSessions({
      conversations: { a: conv('a') },
      order: ['a'],
      activeId: 'a',
    });
    const next = cachedPartializeSessions({
      conversations: { a: conv('a', { title: 'renamed' }) },
      order: ['a'],
      activeId: 'a',
    });
    expect(next).not.toBe(first);
    expect(next.conversations.a.title).toBe('renamed');
  });

  it('reuses untouched conversations when another one changes', () => {
    const b = conv('b');
    const first = cachedPartializeSessions({
      conversations: { a: conv('a'), b },
      order: ['a', 'b'],
      activeId: 'a',
    });
    const next = cachedPartializeSessions({
      conversations: { a: conv('a', { title: 'renamed' }), b },
      order: ['a', 'b'],
      activeId: 'a',
    });
    expect(next).not.toBe(first);
    expect(next.conversations.b).toBe(first.conversations.b);
  });

  it('rebuilds when order or active conversation changes', () => {
    const a = conv('a');
    const b = conv('b');
    const first = cachedPartializeSessions({
      conversations: { a, b },
      order: ['a', 'b'],
      activeId: 'a',
    });
    const reordered = cachedPartializeSessions({
      conversations: { a, b },
      order: ['b', 'a'],
      activeId: 'a',
    });
    expect(reordered).not.toBe(first);
    expect(reordered.order).toEqual(['b', 'a']);
    const switched = cachedPartializeSessions({
      conversations: { a, b },
      order: ['b', 'a'],
      activeId: 'b',
    });
    expect(switched).not.toBe(reordered);
    expect(switched.activeId).toBe('b');
  });

  it('omits btw conversations from persistence', () => {
    const persisted = cachedPartializeSessions({
      conversations: {
        a: conv('a'),
        btw: { ...conv('btw'), btwParentId: 'a', btwRolePrompt: 'secret' },
      },
      order: ['a', 'btw'],
      activeId: 'btw',
    });
    expect(persisted.conversations.btw).toBeUndefined();
    expect(persisted.conversations.a).toBeDefined();
    expect(persisted.order).toEqual(['a']);
    expect(persisted.activeId).toBe('a');
  });

  it('keeps child conversations but drops them from sidebar order', () => {
    const persisted = cachedPartializeSessions({
      conversations: {
        a: conv('a'),
        child: { ...conv('child'), parentId: 'a', title: 'review' },
      },
      order: ['child', 'a'],
      activeId: 'child',
    });
    expect(persisted.conversations.child).toMatchObject({ parentId: 'a', title: 'review' });
    expect(persisted.conversations.a).toBeDefined();
    expect(persisted.order).toEqual(['a']);
    expect(persisted.activeId).toBe('a');
  });
});
