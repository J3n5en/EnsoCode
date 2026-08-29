import { describe, expect, it } from 'vitest';
import { archivedConversationIds, pinnedConversationIds, projectConversationIds } from './pinned';

type Minimal = { projectId: string; pinned?: boolean; archived?: boolean; parentId?: string };

const conversations: Record<string, Minimal> = {
  a: { projectId: 'p1' },
  b: { projectId: 'p1', pinned: true },
  c: { projectId: 'p2', pinned: true },
  d: { projectId: 'p1' },
  e: { projectId: 'p1', pinned: true },
  ghost: { projectId: 'p1', pinned: true, parentId: 'a' }, // coworker 不进侧栏
};

// order 新的在前
const order = ['a', 'b', 'c', 'd', 'e'];

const withArchived: Record<string, Minimal> = {
  ...conversations,
  b: { projectId: 'p1', pinned: true, archived: true },
  d: { projectId: 'p1', archived: true },
};

describe('projectConversationIds', () => {
  it('置顶的排最前,组内保持 order 相对顺序', () => {
    expect(projectConversationIds(order, conversations, 'p1')).toEqual(['b', 'e', 'a', 'd']);
  });

  it('无置顶时与原序一致', () => {
    const plain = { a: { projectId: 'p1' }, d: { projectId: 'p1' } };
    expect(projectConversationIds(['a', 'd'], plain, 'p1')).toEqual(['a', 'd']);
  });

  it('脏输入不崩:order 里有 conversations 缺失的 id', () => {
    expect(projectConversationIds(['x', 'b'], conversations, 'p1')).toEqual(['b']);
  });
});

describe('archived 与分组的互斥', () => {
  it('归档的不进项目分组', () => {
    expect(projectConversationIds(order, withArchived, 'p1')).toEqual(['e', 'a']);
  });

  it('归档的不进置顶栏(即使还残留 pinned 标记)', () => {
    expect(pinnedConversationIds(order, withArchived)).toEqual(['c', 'e']);
  });

  it('archivedConversationIds 按 order 收集归档会话', () => {
    expect(archivedConversationIds(order, withArchived)).toEqual(['b', 'd']);
    expect(archivedConversationIds(order, conversations)).toEqual([]);
  });
});

describe('pinnedConversationIds', () => {
  it('跨项目收集置顶会话,保持 order 顺序', () => {
    expect(pinnedConversationIds(order, conversations)).toEqual(['b', 'c', 'e']);
  });

  it('不含 order 之外的会话(coworker 等)', () => {
    expect(pinnedConversationIds(order, conversations)).not.toContain('ghost');
  });
});
