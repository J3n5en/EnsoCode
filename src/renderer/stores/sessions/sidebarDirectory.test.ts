import { describe, expect, it } from 'vitest';
import {
  selectChatCandidateConversations,
  selectCoworkerTabConversations,
  selectSidebarConversations,
} from './sidebarDirectory';

const conv = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId: 'p',
  title: 't',
  status: 'running',
  spawning: false,
  createdAt: 1,
  messages: [{ timestamp: 10, content: extra.text ?? 'x' }],
  coworkerIds: [],
  subagents: [],
  ...extra,
});

describe('selectSidebarConversations', () => {
  it('reuses the directory when only message text changes', () => {
    const first = selectSidebarConversations({ a: conv('a', { text: 'one' }) });
    const second = selectSidebarConversations({ a: conv('a', { text: 'two' }) });
    expect(second).toBe(first);
    expect(second.a.messages).toEqual([]);
    expect(second.a.lastActiveAt).toBe(10);
  });

  it('rebuilds when title or status changes', () => {
    const first = selectSidebarConversations({ a: conv('a') });
    const next = selectSidebarConversations({ a: conv('a', { title: 'u', status: 'idle' }) });
    expect(next).not.toBe(first);
    expect(next.a.title).toBe('u');
    expect(next.a.status).toBe('idle');
  });

  it('父会话 idle 但 coworker running 时投影 hasRunningChild，供侧栏蓝点', () => {
    const directory = selectSidebarConversations({
      parent: conv('parent', { status: 'idle', coworkerIds: ['kid'] }),
      kid: conv('kid', { status: 'running', parentId: 'parent' }),
    });
    expect(directory.parent.status).toBe('idle');
    expect(directory.parent.hasRunningChild).toBe(true);
    expect(directory.kid.hasRunningChild).toBe(false);
  });

  it('coworker 从 idle 变为 running 时重建目录，父条目 hasRunningChild 翻转', () => {
    const parent = conv('parent', { status: 'idle', coworkerIds: ['kid'] });
    const first = selectSidebarConversations({
      parent,
      kid: conv('kid', { status: 'idle', parentId: 'parent' }),
    });
    const second = selectSidebarConversations({
      parent,
      kid: conv('kid', { status: 'running', parentId: 'parent' }),
    });
    expect(second).not.toBe(first);
    expect(first.parent.hasRunningChild).toBe(false);
    expect(second.parent.hasRunningChild).toBe(true);
  });
});

describe('selectChatCandidateConversations', () => {
  it('无关会话事件不改变候选引用，候选字段变化才重建', () => {
    const first = selectChatCandidateConversations({
      root: conv('root', { sessionFile: '/root.jsonl' }),
      child: conv('child', { parentId: 'root', sessionFile: '/child.jsonl' }),
    });
    const second = selectChatCandidateConversations({
      root: conv('root', {
        sessionFile: '/root.jsonl',
        status: 'idle',
        messages: [{ timestamp: 99, content: 'streaming' }],
      }),
      child: conv('child', {
        parentId: 'root',
        title: 'renamed child',
        sessionFile: '/child.jsonl',
      }),
    });
    expect(second).toBe(first);

    const renamed = selectChatCandidateConversations({
      root: conv('root', { title: 'renamed', sessionFile: '/root.jsonl' }),
      child: conv('child', { parentId: 'root', sessionFile: '/child.jsonl' }),
    });
    expect(renamed).not.toBe(second);
    expect(renamed[0].title).toBe('renamed');

    const unavailable = selectChatCandidateConversations({
      root: conv('root'),
      child: conv('child', { parentId: 'root', sessionFile: '/child.jsonl' }),
    });
    expect(unavailable).toEqual([]);
  });
});

describe('selectCoworkerTabConversations', () => {
  it('只响应当前父会话的 tab 展示字段', () => {
    const parent = conv('parent', { coworkerIds: ['child'] });
    const child = conv('child', { parentId: 'parent', title: 'worker', status: 'idle' });
    const first = selectCoworkerTabConversations({ parent, child }, 'parent');
    const second = selectCoworkerTabConversations(
      {
        parent,
        child: { ...child, messages: [{ timestamp: 20 }] },
        unrelated: conv('unrelated', { status: 'failed' }),
      },
      'parent'
    );
    expect(second).toBe(first);

    const running = selectCoworkerTabConversations(
      { parent, child: { ...child, status: 'running' } },
      'parent'
    );
    expect(running).not.toBe(second);
    expect(running[0]).toMatchObject({ id: 'child', title: 'worker', status: 'running' });
  });

  it('按父会话隔离缓存，交错订阅不会挤掉稳定引用', () => {
    const parentA = conv('parent-a', { coworkerIds: ['child-a'] });
    const childA = conv('child-a', { parentId: 'parent-a', status: undefined });
    const firstA = selectCoworkerTabConversations(
      { 'parent-a': parentA, 'child-a': childA },
      'parent-a'
    );

    const parentB = conv('parent-b', { coworkerIds: ['child-b'] });
    const childB = conv('child-b', { parentId: 'parent-b' });
    selectCoworkerTabConversations({ 'parent-b': parentB, 'child-b': childB }, 'parent-b');

    const secondA = selectCoworkerTabConversations(
      { 'parent-a': parentA, 'child-a': { ...childA, messages: [] } },
      'parent-a'
    );
    expect(secondA).toBe(firstA);
    expect(secondA[0]).toMatchObject({
      status: 'idle',
      reloading: false,
      pendingApprovalCount: 0,
      pendingAskCount: 0,
      pendingCapabilityAskCount: 0,
    });
  });

  it('parent coworkerIds 增删和重排都会立即更新 tab 顺序', () => {
    const childA = conv('child-a-order', { parentId: 'parent-order' });
    const childB = conv('child-b-order', { parentId: 'parent-order' });
    const first = selectCoworkerTabConversations(
      {
        parent: conv('parent-order', { coworkerIds: ['child-a-order'] }),
        'child-a-order': childA,
        'child-b-order': childB,
      },
      'parent'
    );
    expect(first.map((entry) => entry.id)).toEqual(['child-a-order']);

    const reordered = selectCoworkerTabConversations(
      {
        parent: conv('parent-order', {
          coworkerIds: ['child-b-order', 'child-a-order'],
        }),
        'child-a-order': childA,
        'child-b-order': childB,
      },
      'parent'
    );
    expect(reordered.map((entry) => entry.id)).toEqual(['child-b-order', 'child-a-order']);

    const removed = selectCoworkerTabConversations(
      {
        parent: conv('parent-order', { coworkerIds: [] }),
        'child-a-order': childA,
        'child-b-order': childB,
      },
      'parent'
    );
    expect(removed).toEqual([]);
  });
});
